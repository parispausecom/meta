/**
 * Prospection Instagram : liste dans un onglet du Sheet les comptes qui ont
 * interagi avec @pausecom.agency, enrichis de leur profil public.
 *
 *   npm run prospection              # collecte, enrichit, met à jour l'onglet
 *   npm run prospection -- --dry-run # affiche le résultat, n'écrit rien
 *
 * Sources : commentaires sur les publications et mentions du compte. Les
 * likers n'en font pas partie — la Graph API n'expose que leur nombre.
 *
 * Rejouable : l'onglet est indexé par nom de compte. Les colonnes collectées
 * (A à L) sont réécrites à chaque passage ; les colonnes de suivi (M à P :
 * statut, message, date d'envoi, notes) appartiennent à l'agent et à
 * l'équipe, et ne sont jamais écrasées.
 */
import { runCli, requireEnv } from './lib/env.js';
import { graphGet } from './lib/graph.js';
import { sheetsApi } from './lib/sheets.js';

const TAB = 'Prospection Instagram';
const HEADER = [
  'Compte', 'Profil', 'Rôle', 'Source', 'Interactions', 'Dernière interaction', 'Extrait',
  'Compte pro', 'Nom', 'Bio', 'Site', 'Abonnés',
  'Statut', 'Message proposé', 'Envoyé le', 'Notes',
] as const;
const COLLECTED = 12; // A → L
const STATUSES = ['À qualifier', 'Qualifié', 'Message prêt', 'Envoyé', 'Répondu', 'Rendez-vous', 'Pas intéressé', 'Ne pas contacter'];

const dryRun = process.argv.includes('--dry-run');

interface Page<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** Parcourt toutes les pages d'une arête de la Graph API. */
async function all<T>(path: string, params: Record<string, string | number>): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  do {
    const r: Page<T> = await graphGet<Page<T>>(path, after ? { ...params, after } : params);
    out.push(...(r.data ?? []));
    after = r.paging?.next ? r.paging.cursors?.after : undefined;
  } while (after);
  return out;
}

interface Comment {
  username?: string;
  timestamp?: string;
  text?: string;
  replies?: { data?: Comment[] };
}

interface Engager {
  username: string;
  comments: number;
  mentions: number;
  last: string;
  excerpt: string;
}

interface Discovery {
  name?: string;
  biography?: string;
  website?: string;
  followers_count?: number;
}

const oneLine = (s = '', n = 120) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const day = (iso: string) => (iso ? iso.slice(0, 10) : '');

async function collect(igId: string, own: string): Promise<Engager[]> {
  const people = new Map<string, Engager>();
  const note = (username: string | undefined, kind: 'comments' | 'mentions', ts = '', text = '') => {
    // Le compte lui-même et les comptes de l'équipe ne sont pas des prospects.
    if (!username || username === own || username.includes('pausecom')) return;
    const p = people.get(username) ?? { username, comments: 0, mentions: 0, last: '', excerpt: '' };
    p[kind]++;
    if (ts > p.last) {
      p.last = ts;
      p.excerpt = oneLine(text);
    }
    people.set(username, p);
  };

  const media = await all<{ id: string; comments_count?: number }>(`${igId}/media`, { fields: 'id,comments_count', limit: 100 });
  for (const m of media.filter((x) => (x.comments_count ?? 0) > 0)) {
    const comments = await all<Comment>(`${m.id}/comments`, {
      fields: 'username,timestamp,text,replies{username,timestamp,text}',
      limit: 100,
    });
    for (const c of comments) {
      note(c.username, 'comments', c.timestamp, c.text);
      for (const r of c.replies?.data ?? []) note(r.username, 'comments', r.timestamp, r.text);
    }
  }

  const tags = await all<{ username?: string; timestamp?: string; caption?: string }>(`${igId}/tags`, {
    fields: 'username,timestamp,caption',
    limit: 50,
  });
  for (const t of tags) note(t.username, 'mentions', t.timestamp, t.caption);

  console.log(`  ${media.length} publication(s), ${tags.length} mention(s) → ${people.size} compte(s)`);
  return [...people.values()];
}

/**
 * Profil public d'un compte professionnel ou créateur. Les comptes personnels
 * ne sont pas exposés par Business Discovery : `null` les distingue.
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

type Row = Array<string | number>;

function toRow(e: Engager, d: Discovery | null): Row {
  const source = [e.comments && `${e.comments} commentaire(s)`, e.mentions && `${e.mentions} mention(s)`].filter(Boolean).join(' + ');
  return [
    e.username,
    `https://www.instagram.com/${e.username}/`,
    // Un compte qui identifie Pause-Com dans ses publications est le plus
    // souvent un client : référence possible, mais à confirmer avant de la citer.
    e.mentions ? 'Référence (à confirmer)' : 'Prospect',
    source,
    e.comments + e.mentions,
    day(e.last),
    e.excerpt,
    d ? 'oui' : 'non',
    d?.name ?? '',
    oneLine(d?.biography, 300),
    d?.website ?? '',
    d?.followers_count ?? '',
  ];
}

await runCli(async () => {
  const igId = requireEnv('IG_USER_ID');
  const { username: own = '' } = await graphGet<{ username?: string }>(igId, { fields: 'username' });

  console.log(`\nCollecte des interactions de @${own}…`);
  const engagers = await collect(igId, own);

  console.log('Enrichissement par Business Discovery…');
  const rows: Row[] = [];
  for (const e of engagers) rows.push(toRow(e, await discover(igId, e.username)));
  const pros = rows.filter((r) => r[7] === 'oui').length;
  console.log(`  ${pros} compte(s) professionnel(s), ${rows.length - pros} personnel(s) ou introuvable(s)`);

  // Prospects pros d'abord, puis par engagement.
  const rank = (r: Row) => (r[2] === 'Prospect' ? 0 : 1) * 2 + (r[7] === 'oui' ? 0 : 1);
  rows.sort((a, b) => rank(a) - rank(b) || Number(b[4]) - Number(a[4]));

  if (dryRun) {
    for (const r of rows.slice(0, 30)) console.log(`  ${String(r[2]).padEnd(24)} ${String(r[0]).padEnd(28)} pro:${r[7]}  ${r[4]}  ${r[9]}`);
    console.log('\n--dry-run : rien n’a été écrit.');
    return;
  }

  // Onglet créé au premier passage.
  const meta = await sheetsApi<{ sheets: Array<{ properties: { sheetId: number; title: string } }> }>('?fields=sheets.properties(sheetId,title)');
  let sheetId = meta.sheets.find((s) => s.properties.title === TAB)?.properties.sheetId;
  const created = sheetId === undefined;
  if (created) {
    const r = await sheetsApi<{ replies: Array<{ addSheet: { properties: { sheetId: number } } }> }>('/:batchUpdate', 'POST', {
      requests: [{ addSheet: { properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } } }],
    });
    sheetId = r.replies[0]!.addSheet.properties.sheetId;
  }

  // Le suivi déjà saisi est conservé, rattaché au compte.
  const range = encodeURIComponent(`'${TAB}'!A2:P`);
  const existing = created ? [] : (await sheetsApi<{ values?: string[][] }>(`/values/${range}`)).values ?? [];
  const followUp = new Map(existing.filter((r) => r[0]).map((r) => [r[0]!, r.slice(COLLECTED, HEADER.length)]));
  // Un compte déjà suivi qui n'apparaît plus dans la collecte reste dans l'onglet.
  const seen = new Set(rows.map((r) => String(r[0])));
  const kept = existing.filter((r) => r[0] && !seen.has(r[0]));

  const values: Row[] = [
    [...HEADER],
    ...rows.map((r) => {
      const f = followUp.get(String(r[0])) ?? [];
      return [...r, f[0] || 'À qualifier', f[1] ?? '', f[2] ?? '', f[3] ?? ''];
    }),
    ...kept.map((r) => Array.from({ length: HEADER.length }, (_, i) => r[i] ?? '')),
  ];

  await sheetsApi(`/values/${encodeURIComponent(`'${TAB}'!A1`)}?valueInputOption=RAW`, 'PUT', { values });

  const bold = { userEnteredFormat: { textFormat: { bold: true } } };
  await sheetsApi('/:batchUpdate', 'POST', {
    requests: [
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: bold, fields: 'userEnteredFormat.textFormat.bold' } },
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      // Liste déroulante sur le statut : des valeurs fixes que l'agent peut filtrer.
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: values.length, startColumnIndex: COLLECTED, endColumnIndex: COLLECTED + 1 },
          rule: { condition: { type: 'ONE_OF_LIST', values: STATUSES.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false },
        },
      },
      { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, endRowIndex: values.length, startColumnIndex: 0, endColumnIndex: HEADER.length } } } },
    ],
  });

  console.log(`\n✅ Onglet « ${TAB} » : ${values.length - 1} compte(s)${created ? ' (onglet créé)' : ''}, suivi existant conservé.`);
});
