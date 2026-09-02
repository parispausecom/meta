/**
 * Import complet des leads déjà déposés sur les Instant Forms de la Page.
 *
 * Le webhook ne voit que les leads déposés après sa mise en service : tout
 * l'historique lui échappe. Ce script parcourt les formulaires de la Page, en
 * lit tous les leads et complète le Google Sheet, en ignorant ceux qui s'y
 * trouvent déjà. Il est donc rejouable sans créer de doublon.
 *
 *   npm run backfill              # tous les formulaires de la Page
 *   npm run backfill -- --dry-run # affiche ce qui serait écrit, n'écrit rien
 *   npm run backfill -- --form=1137253001921392
 *   npm run backfill -- --csv=leads.csv   # exporte hors de Sheets
 */
import { writeFileSync } from 'node:fs';
import { requireEnv, runCli, errorMessage } from './lib/env.js';
import { listLeadForms, fetchFormLeads, type LeadForm } from './lib/graph.js';
import { appendRows, existingLeadIds } from './lib/sheets.js';
import { newRows } from './lib/leads.js';
import type { Lead, LeadRow } from './types.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

/** Lit la valeur d'un drapeau `--nom=valeur`. */
function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const onlyForm = flag('form');
// Sortie CSV : permet de récupérer les leads sans avoir configuré Sheets.
const csvPath = flag('csv');

const CSV_HEADER = ['date', 'nom', 'email', 'téléphone', 'entreprise', 'profil', 'identifiant'];

/** Échappe une valeur au format CSV (RFC 4180) : guillemets doublés. */
function csvCell(value: string): string {
  return /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(rows: LeadRow[]): string {
  return [CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/**
 * L'API Sheets refuse les requêtes trop volumineuses : on écrit par paquets
 * plutôt qu'en une seule fois, sans pour autant faire un appel par lead.
 */
const BATCH = 500;

/** Ne garde que les formulaires susceptibles de contenir des leads. */
function selectForms(forms: LeadForm[]): LeadForm[] {
  if (onlyForm) return forms.filter((f) => f.id === onlyForm);
  // `leads_count` à 0 concerne surtout des brouillons et des copies : les
  // interroger coûterait un appel par formulaire pour rien.
  return forms.filter((f) => (f.leads_count ?? 0) > 0);
}

await runCli(async () => {
  const pageId = requireEnv('META_PAGE_ID', 'ID de la Page Facebook portant les formulaires');

  console.log(`\nLecture des formulaires de la Page ${pageId}…`);
  const forms = await listLeadForms(pageId);
  const selected = selectForms(forms);

  if (onlyForm && !selected.length) {
    throw new Error(`Aucun formulaire ${onlyForm} sur cette Page. Lance npm run backfill -- --dry-run pour voir la liste.`);
  }
  console.log(`${forms.length} formulaire(s), dont ${selected.length} à parcourir.\n`);

  const leads: Lead[] = [];
  const failures: string[] = [];

  for (const form of selected) {
    const label = `${form.name ?? form.id} [${form.id}]`;
    try {
      const found = await fetchFormLeads(form.id);
      leads.push(...found);
      // L'écart avec leads_count est normal : Meta ne conserve les leads que
      // 90 jours, alors que le compteur, lui, n'oublie rien.
      const annonce = form.leads_count ?? 0;
      const ecart = annonce > found.length ? `  (${annonce} annoncé(s), ${annonce - found.length} hors des 90 jours)` : '';
      console.log(`  ${String(found.length).padStart(4)} lead(s)  ${label}${ecart}`);
    } catch (err) {
      failures.push(`${label} — ${errorMessage(err)}`);
      console.log(`     ⚠️  ${label} — ${errorMessage(err)}`);
    }
  }

  console.log(`\n${leads.length} lead(s) récupéré(s) chez Meta.`);
  if (failures.length) {
    console.log(`⚠️  ${failures.length} formulaire(s) illisible(s) :`);
    for (const f of failures) console.log(`   ${f}`);
  }

  // En mode CSV, le fichier est écrit intégralement : rien à dédoublonner,
  // et surtout aucun identifiant Google à exiger.
  const known = csvPath ? new Set<string>() : await existingLeadIds();
  if (!csvPath) console.log(`${known.size} lead(s) déjà dans le Sheet.`);

  const rows = newRows(leads, known);
  if (!rows.length) {
    console.log(`\n✅ Rien à ajouter : le Sheet est déjà à jour.\n`);
    return;
  }

  if (csvPath) {
    writeFileSync(csvPath, toCsv(rows), 'utf8');
    console.log(`\n✅ ${rows.length} lead(s) écrit(s) dans ${csvPath}\n`);
    return;
  }

  if (dryRun) {
    console.log(`\n${rows.length} ligne(s) seraient ajoutées. Aperçu :\n`);
    for (const row of rows.slice(0, 5)) console.log(`   ${row.join(' | ')}`);
    if (rows.length > 5) console.log(`   … et ${rows.length - 5} autre(s)`);
    console.log(`\n(--dry-run : rien n'a été écrit)\n`);
    return;
  }

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await appendRows(batch);
    console.log(`   ${Math.min(i + BATCH, rows.length)}/${rows.length} ligne(s) écrite(s)`);
  }

  console.log(`\n✅ ${rows.length} lead(s) ajouté(s) au Sheet.\n`);
});
