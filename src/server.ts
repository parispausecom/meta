/**
 * Serveur webhook Meta : reçoit les leads des Instant Forms Facebook/Instagram
 * en temps réel et ajoute une ligne par lead dans un Google Sheet.
 *
 * Meta n'envoie dans le webhook que l'ID du lead, pas ses données : il faut
 * ensuite appeler la Graph API pour récupérer les champs du formulaire.
 *
 * Meta considère la livraison échouée si on ne répond pas 200 en quelques
 * secondes, et réessaie alors le même lead. On acquitte donc immédiatement et
 * on traite le lead en arrière-plan.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { requireEnv, optionalEnv, errorMessage } from './lib/env.js';
import { fetchLead, fetchLeadDetail } from './lib/graph.js';
import { appendRow, existingLeadIds, readLeadRows } from './lib/sheets.js';
import { toRow, isTestLead } from './lib/leads.js';
import { getStatus, recordActivity, invalidateStatus, currentVersion, onVersionChange } from './lib/status.js';
import { getBusiness, invalidateBusiness, fetchConversation, fetchInstagramComments, fetchPostComments } from './lib/business.js';
import { renderDashboard } from './dashboard.js';
import { renderPrivacy, renderDeletion } from './legal.js';
import type { LeadgenValue, WebhookBody } from './types.js';

/** Express n'expose pas le corps brut : on le conserve pour la signature. */
interface SignedRequest extends Request {
  rawBody?: Buffer;
}

const PORT = optionalEnv('PORT', '3000');
const VERIFY_TOKEN = requireEnv('META_VERIFY_TOKEN', 'Chaîne secrète, à reporter dans le Dashboard Meta');
// Optionnel mais fortement recommandé : sans lui, n'importe qui connaissant
// l'URL peut injecter de faux leads dans la feuille.
const APP_SECRET = process.env.META_APP_SECRET;

const app = express();

// La signature Meta est calculée sur les octets bruts du corps : on les
// conserve avant que le JSON ne soit parsé et reformaté.
app.use(express.json({
  verify: (req, _res, buf) => { (req as SignedRequest).rawBody = buf; },
}));

if (!APP_SECRET) {
  console.warn('⚠️  META_APP_SECRET absent : les requêtes entrantes ne seront pas authentifiées.');
}

/** Vérifie la signature HMAC-SHA256 envoyée par Meta dans X-Hub-Signature-256. */
function signatureIsValid(req: SignedRequest): boolean {
  if (!APP_SECRET) return true;

  const header = req.get('x-hub-signature-256');
  if (!header || !req.rawBody) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // timingSafeEqual exige des longueurs égales, d'où la comparaison préalable.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Vérification de l'abonnement (appelée une fois par Meta à la config) ----
app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook vérifié par Meta.');
    return res.status(200).send(challenge);
  }

  console.warn('Échec de vérification du webhook (token invalide).');
  return res.sendStatus(403);
});

// Détail d'un lead : la ligne du Sheet, complétée par Meta tant que le lead
// n'a pas été purgé (90 jours). Les deux sources sont lues indépendamment.
app.get('/api/leads/:id', requireDashboardAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  if (!/^\d{5,25}$/.test(id)) {
    res.status(400).json({ error: 'Identifiant de lead invalide.' });
    return;
  }

  const [rows, meta] = await Promise.allSettled([readLeadRows(), fetchLeadDetail(id)]);
  const row = rows.status === 'fulfilled' ? rows.value.find((r) => r[6] === id) : undefined;
  const sheet = row
    ? { date: row[0], name: row[1], email: row[2], phone: row[3], company: row[4], profile: row[5], id: row[6] }
    : null;

  if (!sheet && meta.status === 'rejected') {
    res.status(404).json({ error: 'Lead introuvable dans le Sheet comme chez Meta.' });
    return;
  }
  res.json({
    id,
    sheet,
    sheetError: rows.status === 'rejected' ? errorMessage(rows.reason) : undefined,
    meta: meta.status === 'fulfilled' ? meta.value : null,
    metaError: meta.status === 'rejected' ? errorMessage(meta.reason) : undefined,
  });
});

// --- Réception des leads ----------------------------------------------------
app.post('/webhook', (req: Request, res: Response) => {
  if (!signatureIsValid(req as SignedRequest)) {
    console.warn('Signature invalide — requête rejetée.');
    return res.sendStatus(401);
  }

  // On acquitte tout de suite pour éviter que Meta ne réessaie.
  res.sendStatus(200);

  const body = req.body as WebhookBody;
  const source = body?.object === 'instagram' ? 'Instagram' : body?.object === 'page' ? 'Facebook' : '';
  if (!source) return;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (source === 'Facebook' && change.field === 'leadgen' && change.value) {
        handleLead(change.value).catch((err: unknown) => {
          console.error('Traitement du lead échoué :', errorMessage(err));
        });
        continue;
      }
      // Publication, commentaire, mention, avis… : le tableau de bord relira
      // Meta à sa prochaine actualisation.
      noteEvent(`${source} · ${EVENT_LABELS[change.field ?? ''] ?? change.field ?? 'événement'}`);
    }
    if (entry.messaging?.length) noteEvent(`${source} · message`);
  }
});

const EVENT_LABELS: Record<string, string> = {
  feed: 'publication ou commentaire',
  comments: 'commentaire',
  mentions: 'mention',
  ratings: 'avis',
  messages: 'message',
};

function noteEvent(kind: string): void {
  console.log(`Événement Meta : ${kind}`);
  invalidateBusiness();
  recordActivity({ status: 'événement', kind });
}

app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

// Logo et icônes : publics, sans donnée sensible. Render lance le serveur
// depuis la racine du dépôt, où se trouve `public/`.
app.use(express.static(path.resolve('public'), { maxAge: '7d' }));
app.get('/favicon.ico', (_req: Request, res: Response) => res.redirect(301, '/favicon-32.png'));

// --- Tableau de bord --------------------------------------------------------
// Il expose des données personnelles : sans mot de passe défini, il reste
// fermé plutôt que public.
const DASHBOARD_USER = optionalEnv('DASHBOARD_USER', 'pausecom');
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const REFRESH_SECONDS = 60;

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function requireDashboardAuth(req: Request, res: Response, next: () => void): void {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');

  if (!DASHBOARD_PASSWORD) {
    res.status(503).type('text').send('Tableau de bord désactivé : définir DASHBOARD_PASSWORD.');
    return;
  }

  const [scheme, encoded] = (req.get('authorization') ?? '').split(' ');
  const [user, ...rest] = Buffer.from(encoded ?? '', 'base64').toString().split(':');
  if (scheme === 'Basic' && same(user ?? '', DASHBOARD_USER) && same(rest.join(':'), DASHBOARD_PASSWORD)) {
    next();
    return;
  }

  res.set('WWW-Authenticate', 'Basic realm="Leads Pause-Com", charset="UTF-8"');
  res.status(401).type('text').send('Authentification requise.');
}

app.get('/', (_req: Request, res: Response) => res.redirect('/dashboard'));

// Pages légales publiques, exigées par Meta pour le mode Live.
app.get('/confidentialite', (_req: Request, res: Response) => res.type('html').send(renderPrivacy()));
app.get('/suppression-des-donnees', (_req: Request, res: Response) => res.type('html').send(renderDeletion()));
app.get('/privacy', (_req: Request, res: Response) => res.redirect(301, '/confidentialite'));

app.get('/dashboard', requireDashboardAuth, async (req: Request, res: Response) => {
  try {
    const fresh = req.query.fresh === '1';
    const [status, business] = await Promise.all([getStatus(fresh), getBusiness(fresh)]);
    res.type('html').send(renderDashboard(status, business, REFRESH_SECONDS, currentVersion()));
  } catch (err) {
    res.status(500).type('text').send(`Collecte impossible : ${errorMessage(err)}`);
  }
});

// Conservé pour les navigateurs sans EventSource, ou si le flux SSE échoue.
app.get('/api/version', requireDashboardAuth, (_req: Request, res: Response) => {
  res.json({ version: currentVersion() });
});

// Flux temps réel : pousse la version dès qu'un événement Meta arrive (lead,
// publication, commentaire, message), sans que la page n'ait à sonder.
app.get('/api/stream', requireDashboardAuth, (req: Request, res: Response) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${currentVersion()}\n\n`);

  const unsubscribe = onVersionChange((v) => res.write(`data: ${v}\n\n`));
  // Certains hébergeurs/proxys coupent une connexion inactive : un
  // commentaire SSE toutes les 25 s la maintient sans déclencher de rendu.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.get('/api/business', requireDashboardAuth, async (req: Request, res: Response) => {
  res.json(await getBusiness(req.query.fresh === '1'));
});

const META_ID = /^[\d_]{5,60}$/;

app.get('/api/conversations/:id', requireDashboardAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  // Les identifiants de conversation Messenger commencent par « t_ ».
  if (!/^t_[\w-]{5,80}$/.test(id)) {
    res.status(400).json({ error: 'Identifiant de conversation invalide.' });
    return;
  }
  try {
    res.json({ messages: await fetchConversation(id), pageId: process.env.META_PAGE_ID });
  } catch (err) {
    res.status(502).json({ error: errorMessage(err) });
  }
});

app.get('/api/comments/:source/:id', requireDashboardAuth, async (req: Request, res: Response) => {
  const { source, id } = req.params as { source: string; id: string };
  if (!META_ID.test(id) || !['instagram', 'facebook'].includes(source)) {
    res.status(400).json({ error: 'Publication invalide.' });
    return;
  }
  try {
    res.json({ comments: source === 'instagram' ? await fetchInstagramComments(id) : await fetchPostComments(id) });
  } catch (err) {
    res.status(502).json({ error: errorMessage(err) });
  }
});

app.get('/api/status', requireDashboardAuth, async (req: Request, res: Response) => {
  try {
    const status = await getStatus(req.query.fresh === '1');
    // Le détail des lignes reste réservé à la page : le JSON en donne le compte
    // et les plus récentes, ce qui suffit à un contrôle depuis un terminal.
    const recent = status.sheet.ok
      ? [...status.sheet.data.rows].sort((a, b) => +new Date(b[0]) - +new Date(a[0])).slice(0, 10)
      : [];
    const sheet = status.sheet.ok
      ? { ok: true, data: { title: status.sheet.data.title, total: status.sheet.data.total, recent } }
      : status.sheet;
    res.status(status.healthy ? 200 : 503).json({ ...status, sheet });
  } catch (err) {
    res.status(500).json({ healthy: false, error: errorMessage(err) });
  }
});

// Meta peut livrer deux fois le même lead (réessai réseau) : on garde en
// mémoire les IDs déjà traités pour ne pas dupliquer les lignes.
const processed = new Set<string>();

async function handleLead(value: LeadgenValue): Promise<void> {
  const { leadgen_id: leadId, form_id: formId, page_id: pageId } = value;
  if (!leadId) return;

  if (processed.has(leadId)) {
    console.log(`Lead ${leadId} déjà traité — ignoré.`);
    return;
  }
  processed.add(leadId);

  console.log(`Nouveau lead ${leadId} (formulaire ${formId}, page ${pageId})`);

  try {
    // Le Set ci-dessus repart à zéro à chaque redémarrage (le plan gratuit de
    // Render endort le service) : le Sheet est la seule mémoire fiable.
    if ((await existingLeadIds()).has(leadId)) {
      console.log(`Lead ${leadId} déjà présent dans le Sheet — ignoré.`);
      recordActivity({ leadId, status: 'déjà présent' });
      return;
    }

    const lead = await fetchLead(leadId);
    // L'outil de test de Meta prouve que la livraison fonctionne : on le
    // journalise sans polluer la base de prospects.
    if (isTestLead(lead)) {
      console.log(`Lead de test Meta ${leadId} reçu — non écrit.`);
      recordActivity({ leadId, status: 'test Meta ignoré' });
      return;
    }

    const row = toRow(lead);
    await appendRow(row);
    console.log(`✅ Lead ${leadId} ajouté au Google Sheet.`);
    recordActivity({ leadId, status: 'écrit', name: row[1] });
    invalidateStatus();
  } catch (err) {
    // On retire l'ID pour qu'un éventuel réessai de Meta puisse retenter.
    processed.delete(leadId);
    recordActivity({ leadId, status: 'échec', error: errorMessage(err) });
    throw err;
  }
}

app.listen(Number(PORT), () => {
  console.log(`Serveur webhook à l'écoute sur le port ${PORT}`);
  console.log(`  Vérification : GET  /webhook`);
  console.log(`  Leads        : POST /webhook`);
  console.log(`  Santé        : GET  /health`);
  console.log(`  Tableau      : GET  /dashboard${DASHBOARD_PASSWORD ? '' : '  (désactivé : DASHBOARD_PASSWORD absent)'}`);
});
