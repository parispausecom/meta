/**
 * Configuration automatisée de l'accès Meta.
 *
 * Enchaîne tout ce qui se fait habituellement à la main, dans le bon ordre :
 *
 *   1. identifie le jeton fourni, et l'échange s'il est court
 *   2. récupère le jeton de Page correspondant — celui-là n'expire pas
 *   3. vérifie son type et ses autorisations
 *   4. identifie le compte Instagram professionnel rattaché
 *   5. abonne la Page au champ leadgen
 *   6. écrit le tout dans .env
 *
 * Le seul geste manuel qui reste est l'autorisation dans le navigateur, que
 * Meta impose et qui n'est à refaire que si le jeton de Page est révoqué.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { optionalEnv, runCli, errorMessage } from './lib/env.js';
import { debugToken } from './lib/graph.js';

const VERSION = optionalEnv('GRAPH_API_VERSION', 'v26.0');
const BASE = `https://graph.facebook.com/${VERSION}`;

const REQUIRED_SCOPES = [
  'leads_retrieval',
  'pages_manage_metadata',
  'pages_show_list',
  'pages_read_engagement',
];

const ok = (m: string): void => console.log(`  ✅ ${m}`);
const step = (n: number, m: string): void => console.log(`\n${n}. ${m}`);

/** Une Page telle que renvoyée par /me/accounts. */
interface PageAccount {
  id: string;
  name?: string;
  access_token: string;
}

/** Appel Graph API brut : ce script gère ses propres jetons, un par étape. */
async function graph<T>(
  path: string,
  params: Record<string, string>,
  method: 'GET' | 'POST' = 'GET'
): Promise<T> {
  const url = new URL(`${BASE}/${path}`);
  const init: RequestInit = { method };

  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, v);
    init.body = body;
  }

  const response = await fetch(url, init);
  const payload = (await response.json()) as T & { error?: { message?: string } };

  if (!response.ok) {
    throw new Error(
      `Graph API ${response.status} — ${payload.error?.message ?? 'erreur inconnue'}`
    );
  }
  return payload;
}

/**
 * Met à jour des clés dans .env en préservant le reste du fichier :
 * commentaires, ordre et variables non concernées.
 */
function updateEnv(values: Record<string, string>): void {
  const path = '.env';
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];

  if (existsSync(path)) copyFileSync(path, '.env.backup');

  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }

  writeFileSync(path, lines.join('\n'));
}

/** Demande le jeton au clavier, en tolérant que l'URL entière soit collée. */
async function askForToken(): Promise<string> {
  console.log('\nColle ton jeton Meta ci-dessous.\n');
  console.log('  Pour en obtenir un :');
  console.log('  1. https://developers.facebook.com/tools/explorer/');
  console.log('     → jeton utilisateur, avec les cinq autorisations');
  console.log('  2. https://developers.facebook.com/tools/debug/accesstoken/');
  console.log('     → bouton « Prolonger le token d\'accès »\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Jeton : ')).trim();
  rl.close();

  // Le jeton revient dans la barre d'adresse, après un « # ». Coller l'URL
  // entière est le réflexe naturel : on en extrait le jeton plutôt que
  // d'échouer sur une valeur qui contient pourtant la bonne information.
  const inUrl = answer.match(/access_token=([^&#\s]+)/);
  if (inUrl?.[1]) {
    console.log("  (jeton extrait de l'URL collée)");
    return inUrl[1];
  }
  return answer;
}

await runCli(async () => {
  const given = process.argv[2] ?? (await askForToken());
  if (!given) {
    console.error('\nAucun jeton saisi.');
    process.exit(1);
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  // La clé secrète n'est indispensable qu'à l'échange de jeton et à
  // l'inspection via /debug_token. Sans elle, on peut tout de même aboutir si
  // l'utilisateur fournit un jeton déjà longue durée, obtenu via le bouton
  // « Prolonger le token » du débogueur de jetons.
  const withSecret = Boolean(appId && appSecret);

  console.log('\n── Configuration automatisée de Meta ───────────────────');
  if (!withSecret) {
    console.log('\nMode sans clé secrète : le jeton fourni doit déjà être longue durée.');
  }

  // 1. Identifier le jeton avant d'agir dessus.
  //
  // Trois cas : un jeton court d'explorateur (à échanger), un jeton déjà longue
  // durée, ou un jeton de System User qui n'expire jamais. Échanger un jeton
  // déjà permanent échoue de façon obscure, d'où ce tri préalable.
  step(1, 'Identification du jeton fourni');
  let longToken = given;

  if (!withSecret || !appId || !appSecret) {
    ok('inspection impossible sans clé secrète — jeton utilisé tel quel');
  } else {
    const info = await debugToken(given, appId, appSecret);
    if (!info.valid) {
      throw new Error(`Jeton refusé par Meta : ${info.error ?? 'raison inconnue'}`);
    }

    const heures = info.expiresAt
      ? (info.expiresAt.getTime() - Date.now()) / 3_600_000
      : Infinity;

    if (info.type === 'PAGE') {
      ok('jeton de Page fourni directement — aucun échange nécessaire');
    } else if (info.neverExpires) {
      ok(`jeton ${info.type ?? 'inconnu'} permanent (System User) — aucun échange nécessaire`);
    } else if (heures > 48) {
      ok(`jeton ${info.type ?? 'inconnu'} déjà longue durée (${Math.round(heures / 24)} jours)`);
    } else {
      ok(`jeton ${info.type ?? 'inconnu'} court (${Math.round(heures)} h) — échange en cours`);
      const exchanged = await graph<{ access_token: string; expires_in?: number }>(
        'oauth/access_token',
        {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: given,
        }
      );
      longToken = exchanged.access_token;
      const days = exchanged.expires_in ? `${Math.round(exchanged.expires_in / 86400)}` : '≈60';
      ok(`échangé contre un jeton longue durée (${days} jours)`);
    }
  }

  // 2. Jeton de Page
  step(2, 'Récupération du jeton de Page');
  const { data: pages } = await graph<{ data?: PageAccount[] }>('me/accounts', {
    access_token: longToken,
  });

  if (!pages?.length) {
    throw new Error(
      `Aucune Page administrée par ce compte. Vérifie que tu es bien administrateur ` +
      `de la Page, et que l'autorisation pages_show_list a été accordée.`
    );
  }

  const wantedId = process.env.META_PAGE_ID;
  const page = wantedId ? pages.find((p) => p.id === wantedId) : pages[0];

  if (!page) {
    console.error(`\nPage ${wantedId} introuvable. Pages disponibles :`);
    pages.forEach((p) => console.error(`  ${p.id}  ${p.name ?? ''}`));
    throw new Error('Ajuste META_PAGE_ID dans .env, ou retire-le pour prendre la première.');
  }
  ok(`Page « ${page.name ?? '?'} » (${page.id})`);

  const pageToken = page.access_token;

  // 3. Vérification que le jeton de Page n'expire vraiment pas
  step(3, 'Vérification du jeton de Page');
  if (!withSecret || !appId || !appSecret) {
    ok('vérification différée — renseigne META_APP_SECRET puis lance npm run doctor');
  } else {
    const info = await debugToken(pageToken, appId, appSecret);
    if (!info.valid) throw new Error(`Jeton de Page invalide : ${info.error ?? 'raison inconnue'}`);

    const expiry = info.neverExpires
      ? "n'expire pas"
      : `expire le ${info.expiresAt?.toLocaleDateString('fr-FR') ?? '?'}`;
    ok(`type ${info.type ?? 'inconnu'}, ${expiry}`);

    const missing = REQUIRED_SCOPES.filter((s) => !info.scopes.includes(s));
    if (missing.length) {
      console.log(`  ⚠️  autorisations manquantes : ${missing.join(', ')}`);
      console.log(`     Les leads ne fonctionneront pas. Recoche-les dans l'explorateur d'API.`);
    } else {
      ok('les autorisations requises sont présentes');
    }
  }

  // 4. Compte Instagram
  step(4, 'Compte Instagram rattaché');
  let igId: string | null = null;
  try {
    const detail = await graph<{ instagram_business_account?: { id?: string } }>(page.id, {
      fields: 'instagram_business_account',
      access_token: pageToken,
    });
    igId = detail.instagram_business_account?.id ?? null;
    if (igId) ok(`compte professionnel ${igId}`);
    else console.log(`  ⚠️  aucun compte Instagram professionnel lié à cette Page`);
  } catch (err) {
    console.log(`  ⚠️  non déterminé : ${errorMessage(err)}`);
  }

  // 5. Abonnement de la Page au webhook
  step(5, 'Abonnement de la Page au champ leadgen');
  try {
    await graph(
      `${page.id}/subscribed_apps`,
      { subscribed_fields: 'leadgen', access_token: pageToken },
      'POST'
    );
    ok('Page abonnée — les leads parviendront au webhook');
  } catch (err) {
    console.log(`  ⚠️  échec : ${errorMessage(err)}`);
    console.log(`     Sans cet abonnement, aucun lead n'arrivera jamais.`);
  }

  // 6. Écriture dans .env
  step(6, 'Écriture de .env');
  const values: Record<string, string> = {
    META_PAGE_ACCESS_TOKEN: pageToken,
    META_PAGE_ID: page.id,
    // Conservé en plus du jeton de Page : lui seul voit l'ensemble des Pages
    // administrées et le compte publicitaire. Il expire au bout de 60 jours,
    // contrairement au jeton de Page — d'où la variable distincte.
    META_USER_ACCESS_TOKEN: longToken,
  };
  if (igId) values['IG_USER_ID'] = igId;
  updateEnv(values);
  ok(`${Object.keys(values).join(', ')} enregistrés (sauvegarde dans .env.backup)`);
  console.log(`     Pages disponibles : ${pages.map((p) => p.name ?? p.id).join(', ')}`);

  console.log('\n✅ Meta est configuré. Vérifie avec : npm run doctor\n');
});
