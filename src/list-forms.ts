/**
 * Liste les Instant Forms de la Page, avec leur nombre de leads.
 *
 * Contrairement à `npm run inventory`, qui énumère les formulaires de toutes
 * les Pages administrées et exige pour cela un jeton utilisateur, ce script se
 * contente du jeton de Page — le seul dont on dispose durablement.
 */
import { requireEnv, runCli } from './lib/env.js';
import { listLeadForms } from './lib/graph.js';

await runCli(async () => {
  const pageId = requireEnv('META_PAGE_ID', 'ID de la Page Facebook portant les formulaires');
  const forms = await listLeadForms(pageId);

  if (!forms.length) {
    console.log(`\nAucun formulaire sur la Page ${pageId}.\n`);
    return;
  }

  // Les formulaires porteurs de leads d'abord : ce sont les seuls à interroger.
  const sorted = [...forms].sort((a, b) => (b.leads_count ?? 0) - (a.leads_count ?? 0));

  console.log(`\n${forms.length} formulaire(s) sur la Page ${pageId}\n`);
  for (const form of sorted) {
    const count = String(form.leads_count ?? 0).padStart(4);
    const date = form.created_time?.slice(0, 10) ?? '          ';
    const status = form.status === 'ACTIVE' ? '' : `  [${form.status ?? 'inconnu'}]`;
    console.log(`  ${date}  ${count} lead(s)  ${form.name ?? '(sans nom)'}  ${form.id}${status}`);
  }

  const total = forms.reduce((n, f) => n + (f.leads_count ?? 0), 0);
  console.log(`\nTotal : ${total} lead(s). Récupération : npm run backfill\n`);
});
