/**
 * Inventaire des formulaires de leads sur TOUTES les Pages administrées.
 *
 * Le jeton de Page ne voit qu'une Page. Ce script utilise le jeton utilisateur
 * (META_USER_ACCESS_TOKEN), qui seul permet d'énumérer les Pages puis, pour
 * chacune, d'obtenir son jeton et de lister ses formulaires.
 */
import { requireEnv, optionalEnv, runCli, errorMessage } from './lib/env.js';

const VERSION = optionalEnv('GRAPH_API_VERSION', 'v26.0');
const BASE = `https://graph.facebook.com/${VERSION}`;

interface Page { id: string; name?: string; access_token: string }
interface Form { id: string; name?: string; status?: string; leads_count?: number; created_time?: string }

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body;
}

await runCli(async () => {
  const userToken = requireEnv(
    'META_USER_ACCESS_TOKEN',
    'Relance npm run setup:meta pour le générer (il expire au bout de 60 jours)'
  );

  const { data: pages } = await get<{ data?: Page[] }>('me/accounts', {
    fields: 'id,name,access_token',
    limit: '100',
    access_token: userToken,
  });

  if (!pages?.length) throw new Error('Aucune Page administrée par ce jeton.');

  console.log(`\n${pages.length} Page(s) administrée(s)\n`);
  let totalForms = 0;
  let totalLeads = 0;

  for (const page of pages) {
    console.log(`── ${page.name ?? page.id} (${page.id})`);
    try {
      const { data: forms } = await get<{ data?: Form[] }>(`${page.id}/leadgen_forms`, {
        fields: 'id,name,status,leads_count,created_time',
        limit: '200',
        access_token: page.access_token,
      });

      const list = forms ?? [];
      const leads = list.reduce((n, f) => n + (f.leads_count ?? 0), 0);
      totalForms += list.length;
      totalLeads += leads;

      console.log(`   ${list.length} formulaire(s), ${leads} lead(s)`);
      // Seuls les formulaires portant des leads méritent l'affichage détaillé :
      // les autres sont souvent des brouillons ou des copies.
      for (const f of list.filter((x) => (x.leads_count ?? 0) > 0)) {
        console.log(`     ${f.created_time?.slice(0, 10)}  ${String(f.leads_count).padStart(4)} lead(s)  ${f.name} [${f.id}]`);
      }
    } catch (err) {
      console.log(`   ⚠️  ${errorMessage(err)}`);
    }
    console.log('');
  }

  console.log(`Total : ${totalForms} formulaire(s), ${totalLeads} lead(s)\n`);
});
