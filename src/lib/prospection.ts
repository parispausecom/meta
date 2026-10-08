/**
 * Fil de prospection Instagram : collecte des comptes qui interagissent avec
 * @pausecom.agency, enrichissement, qualification par l'agent et écriture
 * dans l'onglet « Prospection Instagram » du Sheet.
 *
 * Sources lisibles par la Graph API :
 *   - commentaires sur les publications du compte, y compris les posts
 *     collaboratifs publiés avec un client — le client devient le « via »,
 *     ce qui permet à l'agent de rattacher le prospect à une réalisation ;
 *   - mentions du compte dans les légendes de tiers, le plus souvent des
 *     clients : ils deviennent des références, pas des prospects.
 *
 * Ni les likers ni les commentateurs des posts publiés par les clients eux-mêmes
 * ne sont exposés : la Graph API n'en donne que le nombre ou le texte anonyme.
 *
 * L'onglet est indexé par compte, et ses colonnes sont lues par leur titre :
 * ajouter ou déplacer une colonne ne casse rien. Les colonnes de suivi
 * (statut, message, date d'envoi, notes) ne sont jamais écrasées, et l'agent
 * ne traite que les lignes « À qualifier ».
 */
import { graphGet, graphGetAll } from './graph.js';
import { sheetsApi } from './sheets.js';
import { qualify, type Qualification } from './agent.js';

export const TAB = 'Prospection Instagram';

const COLUMNS = [
  // Collecte, réécrite à chaque passage.
  'Compte', 'Profil', 'Rôle', 'Source', 'Via', 'Interactions', 'Dernière interaction', 'Extrait',
  // Business Discovery, lue une seule fois par compte.
  'Compte pro', 'Nom', 'Bio', 'Site', 'Abonnés',
  // Agent.
  'Catégorie', 'Secteur', 'Score', 'Raison',
  // Suivi : à l'équipe et à l'agent, jamais écrasé par la collecte.
  'Statut', 'Message proposé', 'Envoyé le', 'Notes',
] as const;
type Column = (typeof COLUMNS)[number];
export type Prospect = Partial<Record<Column, string>>;

export const ROLES = ['Prospect', 'Référence (à confirmer)', 'Référence (validée)', 'Client'] as const;
export const STATUSES = [
  'À qualifier', 'Message prêt', 'Qualifié', 'Écarté', 'Envoyé', 'Répondu', 'Rendez-vous', 'Pas intéressé', 'Ne pas contacter',
] as const;

/** Statut posé par la collecte ; seul statut que l'agent s'autorise à changer. */
const TODO = 'À qualifier';
/** Score à partir duquel un prospect reçoit un message prêt à envoyer. */
const READY_SCORE = 60;

// ── Graph API ─────────────────────────────────────────────────────────────

interface Comment {
  username?: string;
  timestamp?: string;
  text?: string;
  replies?: { data?: Comment[] };
}

interface Media {
  id: string;
  comments_count?: number;
  collaborators?: { data?: Array<{ username?: string }> };
}

export interface Engager {
  username: string;
  comments: number;
  mentions: number;
  via: Set<string>;
  last: string;
  excerpt: string;
}

const oneLine = (s = '', n = 120) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Le compte lui-même et ceux de l'équipe ne sont ni prospects ni références. */
const isOwn = (username: string, own: string) => username === own || username.includes('pausecom');

class Collector {
  readonly people = new Map<string, Engager>();
  constructor(private readonly own: string) {}

  note(username: string | undefined, kind: 'comments' | 'mentions', ts = '', text = '', via: string[] = []): void {
    if (!username || isOwn(username, this.own)) return;
    const p = this.people.get(username) ?? { username, comments: 0, mentions: 0, via: new Set<string>(), last: '', excerpt: '' };
    p[kind]++;
    for (const v of via) if (v !== username) p.via.add(v);
    if (ts > p.last) {
      p.last = ts;
      p.excerpt = oneLine(text);
    }
    this.people.set(username, p);
  }

  /** Commentateurs d'une publication du compte, rattachés à ses collaborateurs. */
  async media(m: Media): Promise<void> {
    const via = (m.collaborators?.data ?? []).map((c) => c.username ?? '').filter((u) => u && !isOwn(u, this.own));
    const comments = await graphGetAll<Comment>(`${m.id}/comments`, {
      fields: 'username,timestamp,text,replies{username,timestamp,text}',
    });
    for (const c of comments) {
      this.note(c.username, 'comments', c.timestamp, c.text, via);
      for (const r of c.replies?.data ?? []) this.note(r.username, 'comments', r.timestamp, r.text, via);
    }
  }
}

const MEDIA_FIELDS = 'id,comments_count,collaborators{username}';

export async function ownUsername(igId: string): Promise<string> {
  return (await graphGet<{ username?: string }>(igId, { fields: 'username' })).username ?? '';
}

/** Collecte complète : toutes les publications et toutes les mentions. */
export async function collectAll(igId: string, own: string): Promise<Engager[]> {
  const c = new Collector(own);
  const media = await graphGetAll<Media>(`${igId}/media`, { fields: MEDIA_FIELDS });
  for (const m of media.filter((x) => (x.comments_count ?? 0) > 0)) await c.media(m);

  const tags = await graphGetAll<{ username?: string; timestamp?: string; caption?: string }>(`${igId}/tags`, {
    fields: 'username,timestamp,caption',
  }, 50);
  for (const t of tags) c.note(t.username, 'mentions', t.timestamp, t.caption);
  return [...c.people.values()];
}

/** Collecte ciblée, déclenchée par un commentaire reçu en webhook. */
export async function collectMedia(own: string, mediaId: string): Promise<Engager[]> {
  const c = new Collector(own);
  await c.media(await graphGet<Media>(mediaId, { fields: MEDIA_FIELDS }));
  return [...c.people.values()];
}

interface Discovery {
  name?: string;
  biography?: string;
  website?: string;
  followers_count?: number;
}

/**
 * Profil public d'un compte professionnel ou créateur. Business Discovery
 * n'expose pas les comptes personnels : `null` les distingue.
 */
async function discover(igId: string, username: string): Promise<Discovery | null> {
  try {
    const r = await graphGet<{ business_discovery?: Discovery }>(igId, {
      fields: `business_discovery.username(${username}){name,biography,website,followers_count}`,
    });
    return r.business_discovery ?? null;
  } catch {
    return null;
  }
}

// ── Sheet ─────────────────────────────────────────────────────────────────

interface Loaded {
  sheetId: number;
  rows: Prospect[];
}

async function load(): Promise<Loaded> {
  const meta = await sheetsApi<{ sheets: Array<{ properties: { sheetId: number; title: string } }> }>('?fields=sheets.properties(sheetId,title)');
  const found = meta.sheets.find((s) => s.properties.title === TAB)?.properties.sheetId;
  if (found === undefined) {
    const r = await sheetsApi<{ replies: Array<{ addSheet: { properties: { sheetId: number } } }> }>('/:batchUpdate', 'POST', {
      requests: [{ addSheet: { properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } } }],
    });
    return { sheetId: r.replies[0]!.addSheet.properties.sheetId, rows: [] };
  }
  const values = (await sheetsApi<{ values?: string[][] }>(`/values/${encodeURIComponent(`'${TAB}'`)}`)).values ?? [];
  const [header = [], ...body] = values;
  const rows = body
    .filter((r) => r[0])
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])) as Prospect);
  return { sheetId: found, rows };
}

/** Lecture seule, pour le tableau de bord : un onglet absent donne une liste vide. */
export async function readProspects(): Promise<Prospect[]> {
  const meta = await sheetsApi<{ sheets: Array<{ properties: { title: string } }> }>('?fields=sheets.properties(title)');
  if (!meta.sheets.some((s) => s.properties.title === TAB)) return [];
  return (await load()).rows;
}

async function save(sheetId: number, rows: Prospect[]): Promise<void> {
  const values = [[...COLUMNS], ...rows.map((p) => COLUMNS.map((c) => p[c] ?? ''))];
  // Vidage préalable : une colonne retirée ou une ligne en moins ne laisse pas de résidu.
  await sheetsApi(`/values/${encodeURIComponent(`'${TAB}'`)}:clear`, 'POST', {});
  await sheetsApi(`/values/${encodeURIComponent(`'${TAB}'!A1`)}?valueInputOption=RAW`, 'PUT', { values });

  const col = (name: Column) => COLUMNS.indexOf(name);
  const list = (name: Column, options: readonly string[]) => ({
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, endRowIndex: Math.max(values.length, 2), startColumnIndex: col(name), endColumnIndex: col(name) + 1 },
      rule: { condition: { type: 'ONE_OF_LIST', values: options.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false },
    },
  });
  await sheetsApi('/:batchUpdate', 'POST', {
    requests: [
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      list('Rôle', ROLES),
      list('Statut', STATUSES),
      { clearBasicFilter: { sheetId } },
      { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, endRowIndex: values.length, startColumnIndex: 0, endColumnIndex: COLUMNS.length } } } },
    ],
  });
}

// ── Orchestration ─────────────────────────────────────────────────────────

export interface SyncOptions {
  /** Relit Business Discovery même pour les comptes déjà enrichis. */
  refresh?: boolean;
  /** Collecte complète : les comptes absents de la collecte gardent leurs compteurs. */
  full?: boolean;
  /** Désactive l'agent : collecte et enrichissement seulement. */
  noAgent?: boolean;
  log?: (line: string) => void;
}

export interface SyncReport {
  total: number;
  added: number;
  enriched: number;
  qualified: number;
  ready: number;
}

function merge(existing: Prospect | undefined, e: Engager, full: boolean): Prospect {
  const p: Prospect = { ...existing };
  // Les compteurs ne sont fiables qu'en collecte complète : une collecte
  // ciblée ne voit qu'une publication, et la relire compterait deux fois.
  if (full || !existing) {
    p.Source = [e.comments && `${e.comments} commentaire(s)`, e.mentions && `${e.mentions} mention(s)`].filter(Boolean).join(' + ');
    p.Interactions = String(e.comments + e.mentions);
  }
  const via = new Set([...(full ? [] : (existing?.Via ?? '').split(', ').filter(Boolean)), ...e.via]);

  p.Compte = e.username;
  p.Profil = `https://www.instagram.com/${e.username}/`;
  p.Via = [...via].join(', ');
  const mentions = full || !existing ? e.mentions : Number(/(\d+) mention/.exec(existing.Source ?? '')?.[1] ?? 0);
  if (!existing || e.last.slice(0, 10) >= (existing['Dernière interaction'] ?? '')) {
    p['Dernière interaction'] = e.last.slice(0, 10);
    p.Extrait = e.excerpt;
  }
  // Le rôle se décide une fois : une validation manuelle n'est jamais rétrogradée.
  p.Rôle ||= mentions ? 'Référence (à confirmer)' : 'Prospect';
  p.Statut ||= TODO;
  return p;
}

function applyQualification(p: Prospect, q: Qualification): void {
  p.Catégorie = q.category;
  p.Secteur = q.sector;
  p.Score = String(q.score);
  p.Raison = q.reason;
  if (q.category !== 'prospect') p.Statut = 'Écarté';
  else if (q.score >= READY_SCORE && q.message) {
    p.Statut = 'Message prêt';
    p['Message proposé'] = q.message;
  } else p.Statut = 'Qualifié';
}

/**
 * Fusionne les comptes collectés dans l'onglet, enrichit les nouveaux, fait
 * qualifier par l'agent les lignes « À qualifier », puis réécrit l'onglet.
 */
export async function syncProspection(igId: string, engagers: Engager[], opts: SyncOptions = {}): Promise<SyncReport> {
  const log = opts.log ?? (() => {});
  const { sheetId, rows } = await load();
  const byName = new Map(rows.map((r) => [r.Compte!, r]));
  const report: SyncReport = { total: 0, added: 0, enriched: 0, qualified: 0, ready: 0 };

  for (const e of engagers) {
    if (!byName.has(e.username)) report.added++;
    byName.set(e.username, merge(byName.get(e.username), e, Boolean(opts.full)));
  }
  const all = [...byName.values()];

  for (const p of all) {
    if (p['Compte pro'] && !opts.refresh) continue;
    const d = await discover(igId, p.Compte!);
    p['Compte pro'] = d ? 'oui' : 'non';
    p.Nom = d?.name ?? '';
    p.Bio = oneLine(d?.biography, 300);
    p.Site = d?.website ?? '';
    p.Abonnés = d?.followers_count !== undefined ? String(d.followers_count) : '';
    report.enriched++;
  }
  if (report.enriched) log(`  ${report.enriched} profil(s) enrichi(s)`);

  if (!opts.noAgent) {
    // Les références que l'équipe a validées sont les seules que l'agent peut citer.
    const references = all.filter((p) => p.Rôle === 'Référence (validée)' || p.Rôle === 'Client');
    const todo = all.filter((p) => p.Statut === TODO && p.Rôle === 'Prospect');
    for (const p of todo) {
      try {
        applyQualification(p, await qualify(p, references));
        report.qualified++;
        if (p.Statut === 'Message prêt') report.ready++;
      } catch (err) {
        // Une ligne en échec reste « À qualifier » et sera reprise au prochain passage.
        log(`  ⚠ ${p.Compte} : ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (todo.length) log(`  agent : ${report.qualified}/${todo.length} qualifié(s), ${report.ready} message(s) prêt(s)`);
  }

  const rank = (p: Prospect) =>
    ({ 'Message prêt': 0, 'À qualifier': 1, Qualifié: 2 } as Record<string, number>)[p.Statut ?? ''] ?? (p.Rôle === 'Prospect' ? 3 : 4);
  all.sort((a, b) => rank(a) - rank(b) || Number(b.Score || 0) - Number(a.Score || 0) || Number(b.Interactions || 0) - Number(a.Interactions || 0));

  await save(sheetId, all);
  report.total = all.length;
  return report;
}
