/**
 * Mise en forme d'un lead en ligne de tableur.
 *
 * Isolé du serveur pour être testable sans démarrer de serveur HTTP.
 */
import type { Lead, LeadRow } from '../types.js';

/** `Numéro_de_téléphone` → `numero de telephone` : comparable d'un formulaire à l'autre. */
const normalize = (key: string) =>
  key
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Les noms de champs dépendent du formulaire : Meta génère des noms anglais
 * pour ses champs standards, mais un formulaire personnalisé emploie ses
 * propres libellés (`nom_complet`, `numéro_de_téléphone`, `vous_êtes_?_`…).
 * On essaie d'abord les noms exacts connus, puis des mots-clés sur le nom
 * normalisé.
 */
export function toRow(lead: Lead): LeadRow {
  const fields = lead.fields ?? {};
  const entries = Object.entries(fields).map(([k, v]) => [normalize(k), v] as const);

  const pick = (exact: string[], matches: (key: string) => boolean): string =>
    exact.map((n) => fields[n]).find(Boolean) ??
    entries.find(([k, v]) => v && matches(k))?.[1] ??
    '';

  return [
    lead.createdTime ?? new Date().toISOString(),
    pick(['full_name', 'nom', 'name', 'first_name'], (k) => /\b(nom|name)\b/.test(k) && !/entreprise|societe|company/.test(k)),
    pick(['email', 'e-mail', 'courriel'], (k) => /mail|courriel/.test(k)),
    pick(['phone_number', 'telephone', 'téléphone', 'phone'], (k) => /telephone|phone|portable|mobile/.test(k)),
    pick(['company_name', 'entreprise', 'société', 'societe'], (k) => /entreprise|societe|company|etablissement|restaurant/.test(k)),
    // Question de qualification propre aux formulaires Pausecom : le libellé
    // exact varie d'un formulaire à l'autre, d'où plusieurs variantes.
    pick(['vous_êtes_?', 'vous_etes_?', 'vous_êtes', 'profil', 'secteur'], (k) => /^vous etes\b|profil|secteur/.test(k)),
    lead.id ?? '',
  ];
}

/**
 * Lead factice créé par l'outil de test de Meta : ses réponses valent
 * `<test lead: dummy data for …>`. Il sert à vérifier la chaîne, jamais à
 * remplir la base de prospects.
 */
export function isTestLead(lead: Lead): boolean {
  return Object.values(lead.fields ?? {}).some((v) => v.startsWith('<test lead:'));
}

/**
 * Transforme des leads en lignes prêtes à écrire, sans doublon.
 *
 * Écarte ceux dont l'identifiant figure déjà dans la feuille — un même lead
 * peut arriver deux fois : par le webhook au moment où il est déposé, puis par
 * un import complet. Écarte aussi les répétitions à l'intérieur du lot, un
 * lead pouvant appartenir à deux formulaires dupliqués.
 *
 * Le tri chronologique croissant fait que la feuille se lit du plus ancien au
 * plus récent, alors que Meta renvoie l'inverse.
 */
export function newRows(leads: Lead[], knownIds: ReadonlySet<string>): LeadRow[] {
  const seen = new Set(knownIds);
  const fresh: Lead[] = [];

  for (const lead of leads) {
    if (isTestLead(lead)) continue;
    // Un lead sans identifiant ne peut pas être dédoublonné : on le garde,
    // faute de quoi on perdrait une donnée réelle pour une hypothèse.
    if (lead.id) {
      if (seen.has(lead.id)) continue;
      seen.add(lead.id);
    }
    fresh.push(lead);
  }

  fresh.sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''));
  return fresh.map(toRow);
}
