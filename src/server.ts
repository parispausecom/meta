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
import express, { type Request, type Response } from 'express';
import { requireEnv, optionalEnv, errorMessage } from './lib/env.js';
import { fetchLead } from './lib/graph.js';
import { appendRow, existingLeadIds } from './lib/sheets.js';
import { toRow } from './lib/leads.js';
import { getStatus, recordActivity, invalidateStatus } from './lib/status.js';
import { renderDashboard } from './dashboard.js';
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

// --- Réception des leads ----------------------------------------------------
app.post('/webhook', (req: Request, res: Response) => {
  if (!signatureIsValid(req as SignedRequest)) {
    console.warn('Signature invalide — requête rejetée.');
    return res.sendStatus(401);
  }

  // On acquitte tout de suite pour éviter que Meta ne réessaie.
  res.sendStatus(200);

  const body = req.body as WebhookBody;
  if (body?.object !== 'page') return;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen' || !change.value) continue;
      handleLead(change.value).catch((err: unknown) => {
        console.error('Traitement du lead échoué :', errorMessage(err));
      });
    }
  }
});

app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

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

app.get('/dashboard', requireDashboardAuth, async (req: Request, res: Response) => {
  try {
    const status = await getStatus(req.query.fresh === '1');
    res.type('html').send(renderDashboard(status, REFRESH_SECONDS));
  } catch (err) {
    res.status(500).type('text').send(`Collecte impossible : ${errorMessage(err)}`);
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

    const row = toRow(await fetchLead(leadId));
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
