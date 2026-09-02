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
import { appendRow } from './lib/sheets.js';
import { toRow } from './lib/leads.js';
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
    const lead = await fetchLead(leadId);
    await appendRow(toRow(lead));
    console.log(`✅ Lead ${leadId} ajouté au Google Sheet.`);
  } catch (err) {
    // On retire l'ID pour qu'un éventuel réessai de Meta puisse retenter.
    processed.delete(leadId);
    throw err;
  }
}

app.listen(Number(PORT), () => {
  console.log(`Serveur webhook à l'écoute sur le port ${PORT}`);
  console.log(`  Vérification : GET  /webhook`);
  console.log(`  Leads        : POST /webhook`);
  console.log(`  Santé        : GET  /health`);
});
