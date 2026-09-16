/**
 * État de la production, depuis un terminal.
 *
 *   npm run status              résumé lisible
 *   npm run status -- --fresh   ignore le cache serveur de 30 s
 *   npm run status -- --json    réponse brute de /api/status
 *   npm run dashboard           ouvre le tableau de bord dans le navigateur
 */
import { spawn } from 'node:child_process';
import { requireEnv, optionalEnv, runCli } from './lib/env.js';

const PROD_URL = optionalEnv('PROD_URL', 'https://pausecom-meta-webhook.onrender.com').replace(/\/$/, '');
const args = process.argv.slice(2);

if (args.includes('--open')) {
  const url = `${PROD_URL}/dashboard`;
  console.log(`\nOuverture de ${url}`);
  console.log(`Identifiant : ${optionalEnv('DASHBOARD_USER', 'pausecom')}`);
  console.log(`Mot de passe : npm run dashboard:password  (le copie dans le presse-papiers)\n`);
  spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
}

const ok = (b: boolean) => (b ? '✅' : '❌');
const paris = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }) : '—';

await runCli(async () => {
  const password = requireEnv('DASHBOARD_PASSWORD', 'Le même mot de passe que sur Render');
  const user = optionalEnv('DASHBOARD_USER', 'pausecom');
  const url = `${PROD_URL}/api/status${args.includes('--fresh') ? '?fresh=1' : ''}`;

  process.stdout.write(`\nInterrogation de ${PROD_URL}… `);
  const started = Date.now();
  // Le plan gratuit de Render endort le service : le premier appel peut
  // prendre près d'une minute, le temps du réveil.
  const res = await fetch(url, {
    headers: { authorization: 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64') },
    signal: AbortSignal.timeout(120_000),
  });
  console.log(`${res.status} en ${((Date.now() - started) / 1000).toFixed(1)} s`);

  if (res.status === 401) throw new Error('Mot de passe refusé : DASHBOARD_PASSWORD diffère entre .env et Render.');
  if (res.status === 503 && !res.headers.get('content-type')?.includes('json')) {
    throw new Error(await res.text());
  }
  const s: any = await res.json();

  if (args.includes('--json')) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  const sub = s.subscription;
  console.log(`\n${s.healthy ? '🟢 Automatisation opérationnelle' : '🔴 Attention requise'}   (données du ${paris(s.generatedAt)})\n`);
  console.log(`${ok(true)} Serveur        démarré le ${paris(s.server.startedAt)}`);
  console.log(
    `${ok(s.token.ok && s.token.data.valid)} Jeton Meta     ${s.token.ok ? `${s.token.data.type} · ${s.token.data.valid ? 'valide' : 'INVALIDE'} · ${s.token.data.neverExpires ? "n'expire pas" : `expire le ${paris(s.token.data.expiresAt)}`}` : s.token.error}`
  );
  console.log(
    `${ok(sub.ok && sub.data.active && sub.data.pageSubscribed)} Webhook Meta   ${sub.ok ? `${sub.data.active ? 'actif' : 'INACTIF'} → ${sub.data.callbackUrl} · Page ${sub.data.pageSubscribed ? 'abonnée' : 'NON abonnée'}` : sub.error}`
  );
  console.log(`${ok(s.sheet.ok)} Google Sheet   ${s.sheet.ok ? `« ${s.sheet.data.title} » · ${s.sheet.data.total} leads` : s.sheet.error}`);
  console.log(
    `${ok(s.sync.ok && s.sync.data.missing.length === 0)} Synchronisation ${s.sync.ok ? (s.sync.data.missing.length ? `${s.sync.data.missing.length} lead(s) Meta absent(s) du Sheet → npm run backfill` : 'Meta et Sheet concordent') : s.sync.error}`
  );
  if (s.meta.ok) {
    console.log(`   Meta           ${s.meta.data.retrievable} leads disponibles (90 j) · ${s.meta.data.activeForms}/${s.meta.data.forms} formulaires actifs`);
  }

  const n = s.server.notifications;
  console.log(`\nWebhook depuis le démarrage : ${n.reçues} reçue(s), ${n.écrites} écrite(s), ${n.échecs} échec(s)`);
  for (const a of s.server.activity.slice(0, 5)) {
    console.log(`   ${paris(a.at)}  ${a.status.padEnd(13)} ${a.name ?? ''} ${a.leadId}${a.error ? `  ⚠ ${a.error}` : ''}`);
  }

  if (s.sheet.ok && s.sheet.data.recent.length) {
    console.log('\nDerniers leads :');
    for (const r of s.sheet.data.recent) {
      console.log(`   ${paris(r[0])}  ${String(r[1]).padEnd(28).slice(0, 28)} ${String(r[3]).padEnd(14)} ${r[4]}`);
    }
  }
  console.log(`\nTableau de bord : npm run dashboard\n`);
  if (!s.healthy) process.exitCode = 1;
});
