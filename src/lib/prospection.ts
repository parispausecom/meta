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
 *     clients : ils deviennent des références, pas des prospects ;
 *   - commentaires sur les publications des clients qui l'ont accepté par
 *     écrit (`PROSPECTION_CLIENTS`) et partagé leur compte avec le Business
 *     Manager : lus avec le jeton d'utilisateur système `META_BUSINESS_TOKEN`.
 *
 * Ni les likers ni les commentateurs des posts publiés par les clients eux-mêmes
 * ne sont exposés : la Graph API n'en donne que le nombre ou le texte anonyme.
 * Les likers repérés à la main dans l'application s'ajoutent par `addLikes`.
 *
 * L'onglet est indexé par compte, et ses colonnes sont lues par leur titre :
 * ajouter ou déplacer une colonne ne casse rien. Les colonnes de suivi
 * (statut, message, date d'envoi, notes) ne sont jamais écrasées, et l'agent
 * ne traite que les lignes « À qualifier ».
 */
import { graphGet, graphGetAll, graphPost } from './graph.js';
import { sheetsApi } from './sheets.js';
import { qualify, type Qualification } from './agent.js';
import { requireEnv } from './env.js';

export const TAB = 'Prospection Instagram';

const COLUMNS = [
  // Collecte, réécrite à chaque passage.
  'Compte', 'Profil', 'Rôle', 'Source', 'Via', 'Interactions', 'Dernière interaction', 'Extrait',
  // Dernier commentaire sur une publication du compte : cible d'une réponse privée.
  'Commentaire', 'Commenté le',
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
  id?: string;
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
  likes: number;
  via: Set<string>;
  last: string;
  excerpt: string;
  /** Dernier commentaire sur une publication du compte, seul à pouvoir recevoir une réponse privée. */
  commentId?: string;
  commentedAt?: string;
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

  note(username: string | undefined, kind: 'comments' | 'mentions' | 'likes', ts = '', text = '', via: string[] = []): void {
    if (!username || isOwn(username, this.own)) return;
    const p = this.people.get(username) ?? { username, comments: 0, mentions: 0, likes: 0, via: new Set<string>(), last: '', excerpt: '' };
    p[kind]++;
    for (const v of via) if (v !== username) p.via.add(v);
    if (ts > p.last) {
      p.last = ts;
      p.excerpt = oneLine(text);
    }
    this.people.set(username, p);
  }

  private comment(c: Comment, via: string[], replyable: boolean): void {
    // Un client ou un collaborateur qui commente sa propre publication n'est pas un prospect.
    if (c.username && via.includes(c.username)) return;
    this.note(c.username, 'comments', c.timestamp, c.text, via);
    const p = c.username ? this.people.get(c.username) : undefined;
    if (p && replyable && c.id && (c.timestamp ?? '') >= (p.commentedAt ?? '')) {
      p.commentId = c.id;
      p.commentedAt = c.timestamp ?? '';
    }
  }

  /**
   * Commentateurs d'une publication, rattachés à ses collaborateurs. Sur une
   * publication d'un client, le client lui-même devient le « via ».
   */
  async media(m: Media, client?: { username: string; token: string }): Promise<void> {
    const via = (m.collaborators?.data ?? []).map((c) => c.username ?? '').filter((u) => u && !isOwn(u, this.own));
    if (client) via.push(client.username);
    const comments = await graphGetAll<Comment>(`${m.id}/comments`, {
      fields: 'id,username,timestamp,text,replies{id,username,timestamp,text}',
      ...(client && { access_token: client.token }),
    });
    // Meta n'autorise la réponse privée que sur les publications du compte lui-même.
    for (const c of comments) {
      this.comment(c, via, !client);
      for (const r of c.replies?.data ?? []) this.comment(r, via, !client);
    }
  }
}

const MEDIA_FIELDS = 'id,comments_count,collaborators{username}';

export async function ownUsername(igId: string): Promise<string> {
  return (await graphGet<{ username?: string }>(igId, { fields: 'username' })).username ?? '';
}

/** Collecte complète : toutes les publications et toutes les mentions. */
export async function collectAll(igId: string, own: string, log: (line: string) => void = () => {}): Promise<Engager[]> {
  const c = new Collector(own);
  const media = await graphGetAll<Media>(`${igId}/media`, { fields: MEDIA_FIELDS });
  const commented = media.filter((x) => (x.comments_count ?? 0) > 0);
  for (const m of commented) await c.media(m);
  log(`  ${media.length} publication(s) lue(s), ${commented.length} avec des commentaires`);

  // Pages de 10 : depuis le 15/10/2026, Meta ne sert plus 25 ou 50 mentions avec
  // leur légende dans son délai et répond « reduce the amount of data ».
  const tags = await graphGetAll<{ username?: string; timestamp?: string; caption?: string }>(`${igId}/tags`, {
    fields: 'username,timestamp,caption',
  }, 10, log);
  for (const t of tags) c.note(t.username, 'mentions', t.timestamp, t.caption);
  log(`  ${tags.length} mention(s) lue(s)`);

  await collectClients(c, log);
  return [...c.people.values()];
}

/** Clients qui ont accepté par écrit que leurs commentateurs soient prospectés. */
const consentingClients = () =>
  (process.env.PROSPECTION_CLIENTS ?? '').split(',').map((u) => u.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);

/**
 * Comptes Instagram des clients partagés avec le Business Manager. Un jeton de
 * Page ne voit que sa propre Page : il faut un jeton d'utilisateur système
 * auquel ces comptes sont attribués.
 */
async function clientAccounts(token: string): Promise<Map<string, string>> {
  const page = await graphGet<{ business?: { id?: string } }>(requireEnv('META_PAGE_ID'), { fields: 'business' });
  const business = page.business?.id;
  if (!business) return new Map();
  const found = new Map<string, string>();
  for (const edge of ['client_pages', 'owned_pages']) {
    const pages = await graphGetAll<{ instagram_business_account?: { id?: string; username?: string } }>(`${business}/${edge}`, {
      fields: 'instagram_business_account{id,username}',
      access_token: token,
    }).catch(() => []);
    for (const p of pages) {
      const ig = p.instagram_business_account;
      if (ig?.id && ig.username) found.set(ig.username.toLowerCase(), ig.id);
    }
  }
  return found;
}

/** Commentateurs des publications récentes des clients consentants. */
async function collectClients(c: Collector, log: (line: string) => void): Promise<void> {
  const wanted = consentingClients();
  if (!wanted.length) return;
  const token = process.env.META_BUSINESS_TOKEN;
  if (!token) {
    log('  clients ignorés : META_BUSINESS_TOKEN absent (jeton d’utilisateur système du Business Manager)');
    return;
  }
  const accounts = await clientAccounts(token);
  for (const username of wanted) {
    const id = accounts.get(username);
    if (!id) {
      log(`  @${username} : compte non partagé avec le Business Manager Pause-Com, ignoré`);
      continue;
    }
    try {
      // Les 25 dernières publications : au-delà, les commentateurs sont trop anciens pour être démarchés.
      const media = (await graphGet<{ data?: Media[] }>(`${id}/media`, { fields: MEDIA_FIELDS, limit: 25, access_token: token })).data ?? [];
      for (const m of media.filter((x) => (x.comments_count ?? 0) > 0)) await c.media(m, { username, token });
      log(`  @${username} : ${media.length} publication(s) lue(s)`);
    } catch (err) {
      log(`  @${username} : lecture impossible — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Collecte ciblée, déclenchée par un commentaire reçu en webhook. */
export async function collectMedia(own: string, mediaId: string): Promise<Engager[]> {
  const c = new Collector(own);
  await c.media(await graphGet<Media>(mediaId, { fields: MEDIA_FIELDS }));
  return [...c.people.values()];
}

/**
 * Likers relevés à la main dans l'application, la Graph API ne les exposant
 * pas. Seuls les comptes professionnels sont retenus : un compte personnel
 * n'est pas une cible B2B, et le garder serait une donnée de trop.
 */
export async function addLikes(
  igId: string, own: string, usernames: string[], via: string[], log: (line: string) => void = () => {},
): Promise<Engager[]> {
  const c = new Collector(own);
  const today = new Date().toISOString();
  const text = via.length ? `Like sur la publication avec ${via.map((v) => '@' + v).join(', ')}` : 'Like sur une publication';
  for (const u of usernames) {
    if (!(await discover(igId, u))) {
      log(`  ${u} : compte personnel ou introuvable, ignoré`);
      continue;
    }
    c.note(u, 'likes', today, text, via);
  }
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
  const prev = (kind: string) => Number(new RegExp(`(\\d+) ${kind}`).exec(existing?.Source ?? '')?.[1] ?? 0);
  // Les compteurs ne sont fiables qu'en collecte complète : une collecte
  // ciblée ne voit qu'une publication, et la relire compterait deux fois.
  const comments = full || !existing ? e.comments : prev('commentaire');
  const mentions = full || !existing ? e.mentions : prev('mention');
  // Les likes ne viennent que de la saisie manuelle, que la collecte ne voit jamais : ils s'additionnent.
  const likes = prev('like') + e.likes;
  p.Source = [comments && `${comments} commentaire(s)`, mentions && `${mentions} mention(s)`, likes && `${likes} like(s)`]
    .filter(Boolean).join(' + ');
  p.Interactions = String(comments + mentions + likes);
  // Une collecte complète recalcule le « via », sauf celui d'un like saisi, qu'elle ne retrouverait pas.
  const keepVia = !full || likes > 0;
  const via = new Set([...(keepVia ? (existing?.Via ?? '').split(', ').filter(Boolean) : []), ...e.via]);

  p.Compte = e.username;
  p.Profil = `https://www.instagram.com/${e.username}/`;
  p.Via = [...via].join(', ');
  if (!existing || e.last.slice(0, 10) >= (existing['Dernière interaction'] ?? '')) {
    p['Dernière interaction'] = e.last.slice(0, 10);
    p.Extrait = e.excerpt;
  }
  if (e.commentId && (e.commentedAt ?? '') >= (existing?.['Commenté le'] ?? '')) {
    p.Commentaire = e.commentId;
    p['Commenté le'] = e.commentedAt ?? '';
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

// ── Envoi ─────────────────────────────────────────────────────────────────

/** Meta n'accepte une réponse privée que dans les 7 jours suivant le commentaire. */
export const REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;

/** Refus métier (compte absent, statut, délai) : à distinguer d'une panne de Meta. */
export class ProspectError extends Error {}

/**
 * La réponse privée exige l'accès avancé à `instagram_manage_messages` (App
 * Review) : sans lui, Meta la refuse pour tout compte sans rôle sur l'app.
 */
export const privateRepliesEnabled = () => process.env.INSTAGRAM_PRIVATE_REPLIES === 'on';

export const canReplyPrivately = (p: Prospect, now = Date.now()) =>
  Boolean(p.Commentaire && p['Commenté le'] && now - Date.parse(p['Commenté le']) < REPLY_WINDOW_MS);

/**
 * Envoie le message en réponse privée au dernier commentaire du compte, puis
 * passe la ligne à « Envoyé ». Meta refuse une deuxième réponse au même
 * commentaire : un double clic ne produit jamais deux messages.
 */
export async function sendPrivateReply(pageId: string, account: string, text: string): Promise<Prospect> {
  const { sheetId, rows } = await load();
  const p = rows.find((r) => r.Compte === account);
  if (!p) throw new ProspectError(`@${account} absent de l'onglet de prospection.`);
  if (p.Statut !== 'Message prêt' && p.Statut !== 'Qualifié') throw new ProspectError(`@${account} est au statut « ${p.Statut} » : rien à envoyer.`);
  if (!privateRepliesEnabled()) throw new ProspectError('Réponse privée inactive : INSTAGRAM_PRIVATE_REPLIES=on après l’accès avancé Meta.');
  if (!canReplyPrivately(p)) throw new ProspectError('Commentaire de plus de 7 jours ou absent : envoyer le message à la main depuis Instagram.');

  await graphPost(`${pageId}/messages`, {
    recipient: JSON.stringify({ comment_id: p.Commentaire }),
    message: JSON.stringify({ text }),
  });
  p.Statut = 'Envoyé';
  p['Envoyé le'] = new Date().toISOString().slice(0, 10);
  p['Message proposé'] = text;
  try {
    await save(sheetId, rows);
  } catch (err) {
    throw new Error(`Message envoyé, mais le Sheet n'a pas été mis à jour : passer @${account} à « Envoyé » à la main. (${err instanceof Error ? err.message : String(err)})`);
  }
  return p;
}
