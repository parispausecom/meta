import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const VERIFY_TOKEN = 'token_de_test';
const APP_SECRET = 'secret_de_test';
const DASHBOARD_PASSWORD = 'mdp_de_test';

let server: ChildProcess | undefined;

/** Signe un corps de requête comme le ferait Meta. */
function sign(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

/** Construit une notification leadgen valide. */
function leadgenBody(leadId: string): string {
  return JSON.stringify({
    object: 'page',
    entry: [{ id: '1', changes: [{ field: 'leadgen', value: { leadgen_id: leadId } }] }],
  });
}

before(async () => {
  server = spawn('node', ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      META_VERIFY_TOKEN: VERIFY_TOKEN,
      META_APP_SECRET: APP_SECRET,
      META_PAGE_ACCESS_TOKEN: 'jeton_factice',
      GOOGLE_SPREADSHEET_ID: 'sheet_factice',
      DASHBOARD_USER: 'pausecom',
      DASHBOARD_PASSWORD,
    },
    stdio: 'ignore',
  });

  // Attendre que le port réponde plutôt que de parier sur un délai fixe.
  for (let i = 0; i < 150; i++) {
    try {
      await fetch(`${BASE}/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("le serveur n'a pas démarré");
});

after(() => server?.kill());

test('/health répond', async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('la vérification Meta renvoie le challenge sur bon token', async () => {
  const url = `${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHAL`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'CHAL');
});

test('la vérification est refusée sur mauvais token', async () => {
  const url = `${BASE}/webhook?hub.mode=subscribe&hub.verify_token=faux&hub.challenge=CHAL`;
  assert.equal((await fetch(url)).status, 403);
});

test('un POST sans signature est rejeté', async () => {
  const res = await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"object":"page"}',
  });
  assert.equal(res.status, 401);
});

test('un POST à signature falsifiée est rejeté', async () => {
  const res = await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' },
    body: '{"object":"page"}',
  });
  assert.equal(res.status, 401);
});

test('un POST correctement signé est accepté', async () => {
  const body = leadgenBody('L1');
  const res = await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) },
    body,
  });
  assert.equal(res.status, 200);
});

test('le serveur acquitte avant de traiter, donc répond vite', async () => {
  const body = leadgenBody('L2');
  const started = Date.now();
  await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) },
    body,
  });
  // Meta abandonne au-delà de quelques secondes : l'appel à la Graph API ne
  // doit jamais retarder l'accusé de réception.
  assert.ok(Date.now() - started < 1000, 'la réponse doit être immédiate');
});

const basic = (user: string, pass: string) =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

test("l'accueil redirige vers le tableau de bord", async () => {
  const res = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard');
});

test('le tableau de bord exige une authentification', async () => {
  const res = await fetch(`${BASE}/dashboard`);
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /^Basic /);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('le tableau de bord rejette un mauvais mot de passe', async () => {
  for (const path of ['/dashboard', '/api/status']) {
    const res = await fetch(`${BASE}${path}`, { headers: { authorization: basic('pausecom', 'faux') } });
    assert.equal(res.status, 401, path);
  }
});

test('le tableau de bord rejette un mauvais identifiant', async () => {
  const res = await fetch(`${BASE}/api/status`, { headers: { authorization: basic('intrus', DASHBOARD_PASSWORD) } });
  assert.equal(res.status, 401);
});

test('le logo et le favicon sont servis sans authentification', async () => {
  for (const file of ['/logo.png', '/favicon-32.png', '/apple-touch-icon.png']) {
    const res = await fetch(`${BASE}${file}`);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get('content-type'), 'image/png', file);
  }
  const ico = await fetch(`${BASE}/favicon.ico`, { redirect: 'manual' });
  assert.equal(ico.status, 301);
});

test('les pages légales exigées par Meta sont publiques', async () => {
  for (const path of ['/confidentialite', '/suppression-des-donnees']) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.match(html, /<html lang="fr">/);
    assert.match(html, /<meta name="robots" content="index, follow">/);
    assert.match(html, /mailto:/);
  }
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  assert.match(robots, /Allow: \/confidentialite/);
});

test('un événement Instagram signé fait avancer le signal de fraîcheur', async () => {
  const auth = { authorization: basic('pausecom', DASHBOARD_PASSWORD) };
  const before = ((await (await fetch(`${BASE}/api/version`, { headers: auth })).json()) as { version: number }).version;
  await new Promise((r) => setTimeout(r, 5));
  const body = JSON.stringify({
    object: 'instagram',
    entry: [{ id: '1', changes: [{ field: 'comments', value: { id: '9', text: 'Bravo' } }] }],
  });
  const res = await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) },
    body,
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const after = ((await (await fetch(`${BASE}/api/version`, { headers: auth })).json()) as { version: number }).version;
  assert.notEqual(after, before);
});

test('les routes de détail refusent les identifiants invalides', async () => {
  const auth = { authorization: basic('pausecom', DASHBOARD_PASSWORD) };
  assert.equal((await fetch(`${BASE}/api/conversations/abc`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${BASE}/api/comments/tiktok/123456`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${BASE}/api/leads/..%2Fme`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${BASE}/api/business`)).status, 401);
});
