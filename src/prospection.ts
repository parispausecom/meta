/**
 * Prospection Instagram : met à jour l'onglet « Prospection Instagram » du
 * Sheet à partir des comptes qui interagissent avec @pausecom.agency, puis
 * fait qualifier les nouveaux par l'agent. Voir src/lib/prospection.ts.
 *
 *   npm run prospection                # collecte, enrichit, qualifie, écrit
 *   npm run prospection -- --no-agent  # sans l'agent
 *   npm run prospection -- --refresh   # relit tous les profils publics
 *   npm run prospection -- --like a,b --via restaurant.irwin
 *                                      # ajoute des likers relevés à la main
 *
 * Rejouable : seuls les nouveaux comptes sont enrichis, seules les lignes
 * « À qualifier » passent par l'agent, et le suivi saisi n'est jamais écrasé.
 */
import { runCli, requireEnv } from './lib/env.js';
import { resolveInstagramUserId } from './lib/graph.js';
import { addLikes, collectAll, ownUsername, syncProspection, TAB } from './lib/prospection.js';

const args = process.argv.slice(2);
/** Valeur d'une option `--nom a,b`, en comptes Instagram normalisés. */
const accounts = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? [] : (args[i + 1] ?? '').split(',').map((u) => u.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
};
const likes = accounts('--like');

await runCli(async () => {
  const igId = await resolveInstagramUserId(requireEnv('META_PAGE_ID'));
  const own = await ownUsername(igId);

  // Saisie manuelle : on n'ajoute que ces comptes, sans relancer la collecte complète.
  const manual = likes.length > 0;
  console.log(manual ? `\nAjout de ${likes.length} liker(s)…` : `\nCollecte des interactions de @${own}…`);
  const engagers = manual ? await addLikes(igId, own, likes, accounts('--via'), console.log) : await collectAll(igId, own, console.log);
  console.log(`  ${engagers.length} compte(s)`);
  if (!process.env.OPENAI_API_KEY) console.log('  agent désactivé : OPENAI_API_KEY absente');

  const r = await syncProspection(igId, engagers, {
    full: !manual,
    refresh: args.includes('--refresh'),
    noAgent: args.includes('--no-agent') || !process.env.OPENAI_API_KEY,
    log: console.log,
  });

  console.log(`\n✅ « ${TAB} » : ${r.total} compte(s), ${r.added} nouveau(x), ${r.ready} message(s) prêt(s).`);
});
