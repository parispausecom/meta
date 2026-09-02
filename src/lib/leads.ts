/**
 * Mise en forme d'un lead en ligne de tableur.
 *
 * Isolé du serveur pour être testable sans démarrer de serveur HTTP.
 */
import type { Lead, LeadRow } from '../types.js';

/**
 * Les noms de champs dépendent du formulaire : Meta génère des noms anglais
 * pour ses champs standards, mais un formulaire personnalisé peut employer
 * n'importe quel libellé. On teste les variantes les plus courantes.
 */
export function toRow(lead: Lead): LeadRow {
  const fields = lead.fields ?? {};
  const pick = (...names: string[]): string =>
    names.map((n) => fields[n]).find(Boolean) ?? '';

  return [
    lead.createdTime ?? new Date().toISOString(),
    pick('full_name', 'nom', 'name', 'first_name'),
    pick('email', 'e-mail', 'courriel'),
    pick('phone_number', 'telephone', 'téléphone', 'phone'),
    pick('company_name', 'entreprise', 'société', 'societe'),
    // Question de qualification propre aux formulaires Pausecom : le libellé
    // exact varie d'un formulaire à l'autre, d'où plusieurs variantes.
    pick('vous_êtes_?', 'vous_etes_?', 'vous_êtes', 'profil', 'secteur'),
    lead.id ?? '',
  ];
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
