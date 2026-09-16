/**
 * Rapport Google Sheets : met en forme l'onglet Leads et écrit, dans des
 * onglets dédiés, tout ce que remonte Meta Business Suite — tableau de bord
 * avec indicateurs et graphiques, Instagram, Facebook, audience, messages,
 * mentions et avis.
 *
 *   npm run sheet:report
 *
 * Rejouable à volonté : chaque onglet généré est vidé puis réécrit. L'onglet
 * Leads, lui, n'est jamais vidé — seule sa mise en forme change, ses valeurs
 * restent celles qu'écrivent le webhook et le rattrapage.
 */
import { runCli, optionalEnv } from './lib/env.js';
import { sheetsApi, readLeadRows } from './lib/sheets.js';
import { getBusiness, type Business } from './lib/business.js';
import type { LeadRow } from './types.js';

// ── Charte ────────────────────────────────────────────────────────────────

const hex = (h: string) => ({
  red: parseInt(h.slice(1, 3), 16) / 255,
  green: parseInt(h.slice(3, 5), 16) / 255,
  blue: parseInt(h.slice(5, 7), 16) / 255,
});

const C = {
  ink: hex('#141312'),
  cream: hex('#F7F3E8'),
  paper: hex('#FBF8F1'),
  white: hex('#FFFFFF'),
  band: hex('#F4EFE4'),
  line: hex('#E6DFD2'),
  muted: hex('#6B655C'),
  accent: hex('#B3261E'),
  accentSoft: hex('#F6E3E1'),
  green: hex('#1D6F3A'),
};

const FONT = 'Inter';
const TITLE_FONT = 'Playfair Display';
const TZ = 'Europe/Paris';

const LEADS_TAB = optionalEnv('GOOGLE_SHEET_RANGE', 'Leads!A:G').split('!')[0]!.replace(/'/g, '');
const TABS = {
  dashboard: 'Tableau de bord',
  prospects: 'Prospects',
  instagram: 'Instagram',
  facebook: 'Facebook',
  audience: 'Audience',
  messages: 'Messages',
  mentions: 'Mentions',
  reviews: 'Avis',
  data: 'Données graphiques',
} as const;

// ── Utilitaires ───────────────────────────────────────────────────────────

const day = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString('fr-FR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
const dayTime = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString('fr-FR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
const prettify = (k: string) => {
  const t = k.replace(/_/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : 'Non renseigné';
};
const oneLine = (s?: string, n = 400) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
/** Guillemets doublés : seule précaution nécessaire dans une chaîne de formule. */
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Séparateur d'arguments des formules : il suit la langue du classeur
 * (`;` en français, `,` en anglais). Fixé au démarrage.
 */
let SEP = ';';
/** Séparateur de colonnes dans un tableau littéral `{…}` : `\` en français. */
let COL = '\\';
const link = (url: string, label: string) => `=HYPERLINK(${q(url)}${SEP}${q(label)})`;

type Cell = string | number;
type Request = Record<string, unknown>;

interface SheetMeta {
  properties: { sheetId: number; title: string; index: number; hidden?: boolean };
  charts?: Array<{ chartId: number }>;
  bandedRanges?: Array<{ bandedRangeId: number }>;
  merges?: unknown[];
  basicFilter?: unknown;
}

async function meta(): Promise<Map<string, SheetMeta>> {
  const r = await sheetsApi<{ sheets: SheetMeta[] }>(
    '?fields=sheets(properties(sheetId,title,index,hidden),charts(chartId),bandedRanges(bandedRangeId),merges,basicFilter)'
  );
  return new Map(r.sheets.map((s) => [s.properties.title, s]));
}

const batch = (requests: Request[]) =>
  requests.length ? sheetsApi('/:batchUpdate', 'POST', { requests }) : Promise.resolve();

async function write(tab: string, start: string, rows: Cell[][], input: 'RAW' | 'USER_ENTERED' = 'RAW') {
  if (!rows.length) return;
  await sheetsApi(`/values/${encodeURIComponent(`'${tab}'!${start}`)}?valueInputOption=${input}`, 'PUT', { values: rows });
}

// Briques de requêtes de mise en forme.
const range = (sheetId: number, r0: number, r1: number, c0: number, c1: number) => ({
  sheetId,
  startRowIndex: r0,
  endRowIndex: r1,
  startColumnIndex: c0,
  endColumnIndex: c1,
});

const fmt = (rng: object, format: object, fields: string): Request => ({
  repeatCell: { range: rng, cell: { userEnteredFormat: format }, fields: `userEnteredFormat(${fields})` },
});

const widths = (sheetId: number, px: number[]): Request[] =>
  px.map((pixelSize, i) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  }));

const rowHeight = (sheetId: number, r0: number, r1: number, pixelSize: number): Request => ({
  updateDimensionProperties: {
    range: { sheetId, dimension: 'ROWS', startIndex: r0, endIndex: r1 },
    properties: { pixelSize },
    fields: 'pixelSize',
  },
});

/** En-tête noir, crème et gras, première ligne figée, bandes alternées, filtre. */
function tableStyle(sheetId: number, columns: number, rows: number, colWidths: number[]): Request[] {
  const last = Math.max(rows, 1) + 1;
  return [
    fmt(range(sheetId, 0, last, 0, columns), {
      textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: C.ink },
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'CLIP',
      padding: { left: 8, right: 8, top: 4, bottom: 4 },
    }, 'textFormat,verticalAlignment,wrapStrategy,padding'),
    fmt(range(sheetId, 0, 1, 0, columns), {
      backgroundColor: C.ink,
      textFormat: { fontFamily: FONT, fontSize: 10, bold: true, foregroundColor: C.cream },
      verticalAlignment: 'MIDDLE',
    }, 'backgroundColor,textFormat,verticalAlignment'),
    rowHeight(sheetId, 0, 1, 38),
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      addBanding: {
        bandedRange: {
          range: range(sheetId, 0, last, 0, columns),
          rowProperties: { headerColor: C.ink, firstBandColor: C.white, secondBandColor: C.band },
        },
      },
    },
    { setBasicFilter: { filter: { range: range(sheetId, 0, last, 0, columns) } } },
    ...widths(sheetId, colWidths),
  ];
}

/** Supprime graphiques, bandes, fusions, filtre, valeurs et formats d'un onglet. */
function wipe(s: SheetMeta): Request[] {
  const id = s.properties.sheetId;
  return [
    ...(s.charts ?? []).map((c) => ({ deleteEmbeddedObject: { objectId: c.chartId } })),
    ...(s.bandedRanges ?? []).map((b) => ({ deleteBanding: { bandedRangeId: b.bandedRangeId } })),
    ...(s.basicFilter ? [{ clearBasicFilter: { sheetId: id } }] : []),
    { unmergeCells: { range: { sheetId: id } } },
    { updateCells: { range: { sheetId: id }, fields: 'userEnteredValue,userEnteredFormat,note' } },
    { updateSheetProperties: { properties: { sheetId: id, gridProperties: { frozenRowCount: 0 } }, fields: 'gridProperties.frozenRowCount' } },
  ];
}

// ── Contenu des onglets ───────────────────────────────────────────────────

interface Built {
  rows: Cell[][];
  /** Colonnes écrites en formule (IMAGE, HYPERLINK), indexées depuis 0. */
  formulas?: Array<{ col: number; values: string[] }>;
  widths: number[];
  rowHeight?: number;
  /** Colonnes numériques à aligner à droite. */
  numeric?: number[];
}

function instagramTab(b: Business): Built {
  const media = b.instagram.ok ? (b.instagram.data.media?.data ?? []) : [];
  const type = (t?: string) => (t === 'VIDEO' ? 'Vidéo' : t === 'CAROUSEL_ALBUM' ? 'Carrousel' : 'Photo');
  return {
    rows: [
      ['Aperçu', 'Date', 'Type', 'Légende', 'J’aime', 'Commentaires', 'Lien'],
      ...media.map((m) => ['', day(m.timestamp), type(m.media_type), oneLine(m.caption), m.like_count ?? 0, m.comments_count ?? 0, '']),
    ],
    formulas: [
      { col: 0, values: media.map((m) => { const u = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url; return u ? `=IMAGE(${q(u)})` : ''; }) },
      { col: 6, values: media.map((m) => (m.permalink ? link(m.permalink, 'Ouvrir ↗') : '')) },
    ],
    widths: [110, 100, 90, 480, 80, 110, 90],
    rowHeight: 96,
    numeric: [4, 5],
  };
}

function facebookTab(b: Business): Built {
  const posts = b.page.ok ? (b.page.data.posts?.data ?? []) : [];
  return {
    rows: [
      ['Aperçu', 'Date', 'Message', 'Réactions', 'Commentaires', 'Partages', 'Lien'],
      ...posts.map((p) => ['', day(p.created_time), oneLine(p.message) || '(sans texte)', p.reactions?.summary?.total_count ?? 0, p.comments?.summary?.total_count ?? 0, p.shares?.count ?? 0, '']),
    ],
    formulas: [
      { col: 0, values: posts.map((p) => (p.full_picture ? `=IMAGE(${q(p.full_picture)})` : '')) },
      { col: 6, values: posts.map((p) => (p.permalink_url ? link(p.permalink_url, 'Ouvrir ↗') : '')) },
    ],
    widths: [110, 100, 480, 90, 110, 90, 90],
    rowHeight: 96,
    numeric: [3, 4, 5],
  };
}

function audienceTab(b: Business): Built {
  const series = b.pageInsights.ok ? b.pageInsights.data : [];
  const dates = series[0]?.dates ?? [];
  const ig = b.igInsights.ok ? b.igInsights.data : [];
  const rows: Cell[][] = [['Jour', ...series.map((s) => s.title), '', 'Instagram (28 jours)', 'Total']];
  const len = Math.max(dates.length, ig.length);
  for (let i = 0; i < len; i++) {
    rows.push([
      dates[i] ? day(dates[i]) : '',
      ...series.map((s) => (i < s.values.length ? s.values[i]! : '')),
      '',
      ig[i]?.title ?? '',
      ig[i]?.value ?? '',
    ]);
  }
  rows.push(['Total 28 jours', ...series.map((s) => s.total), '', '', '']);
  return { rows, widths: [120, 200, 150, 150, 30, 200, 110], numeric: [1, 2, 3, 6] };
}

function messagesTab(b: Business): Built {
  const convs = b.conversations.ok ? b.conversations.data : [];
  const pageId = process.env.META_PAGE_ID;
  return {
    rows: [
      ['Dernier échange', 'Contact', 'Aperçu', 'Messages', 'Non lus', 'Répondre'],
      ...convs.map((c) => [
        dayTime(c.updated_time),
        (c.participants?.data ?? []).find((p) => p.id !== pageId)?.name ?? 'Contact',
        oneLine(c.snippet, 200),
        c.message_count ?? 0,
        c.unread_count ?? 0,
        '',
      ]),
    ],
    formulas: [{ col: 5, values: convs.map(() => link('https://business.facebook.com/latest/inbox', 'Business Suite ↗')) }],
    widths: [140, 200, 460, 90, 80, 140],
    numeric: [3, 4],
  };
}

function mentionsTab(b: Business): Built {
  const list = b.mentions.ok ? b.mentions.data : [];
  return {
    rows: [
      ['Date', 'Compte', 'Publication', 'Lien'],
      ...list.map((m) => [day(m.timestamp), `@${m.username ?? ''}`, oneLine(m.caption), '']),
    ],
    formulas: [{ col: 3, values: list.map((m) => (m.permalink ? link(m.permalink, 'Voir ↗') : '')) }],
    widths: [100, 180, 620, 80],
  };
}

function reviewsTab(b: Business): Built {
  const list = b.ratings.ok ? b.ratings.data : [];
  return {
    rows: [
      ['Date', 'Auteur', 'Recommandation', 'Avis'],
      ...list.map((r) => [
        day(r.created_time),
        r.reviewer?.name ?? 'Utilisateur Facebook',
        r.recommendation_type === 'negative' ? 'Ne recommande pas' : 'Recommande',
        oneLine(r.review_text, 1000) || '(sans commentaire)',
      ]),
    ],
    widths: [100, 200, 150, 620],
  };
}

// ── Tableau de bord ───────────────────────────────────────────────────────

function monthlyLeads(rows: LeadRow[]): Cell[][] {
  const out: Cell[][] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 15));
    const key = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit', timeZone: TZ });
    out.push([label, rows.filter((r) => r[0].slice(0, 7) === key).length]);
  }
  return out;
}

function profileLeads(rows: LeadRow[]): Cell[][] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(prettify(r[5]), (counts.get(prettify(r[5])) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ── Point d'entrée ────────────────────────────────────────────────────────

await runCli(async () => {
  const { properties } = await sheetsApi<{ properties: { locale?: string } }>('?fields=properties.locale');
  const english = /^(en|ja|zh|ko|th|he)/.test(properties.locale ?? '');
  SEP = english ? ',' : ';';
  COL = english ? ',' : '\\';

  console.log('\nLecture de Meta et du Sheet…');
  const [b, leads] = await Promise.all([getBusiness(true), readLeadRows()]);
  const failures = (['page', 'ratings', 'conversations', 'instagram', 'mentions', 'pageInsights', 'igInsights'] as const)
    .filter((k) => !b[k].ok)
    .map((k) => `${k} : ${(b[k] as { error: string }).error}`);
  if (failures.length) console.log(`  ⚠ blocs Meta indisponibles :\n    ${failures.join('\n    ')}`);

  // 1. Onglets présents, dans l'ordre voulu.
  let sheets = await meta();
  if (!sheets.has(LEADS_TAB)) throw new Error(`Onglet « ${LEADS_TAB} » introuvable`);
  const wanted = [TABS.dashboard, TABS.prospects, TABS.instagram, TABS.facebook, TABS.audience, TABS.messages, TABS.mentions, TABS.reviews, LEADS_TAB, TABS.data];
  await batch(
    wanted
      .filter((t) => !sheets.has(t))
      .map((title) => ({ addSheet: { properties: { title, gridProperties: { rowCount: 200, columnCount: 14 } } } }))
  );
  sheets = await meta();
  const id = (t: string) => sheets.get(t)!.properties.sheetId;

  // 2. Nettoyage des onglets générés, puis ordre et thème.
  const generated = wanted.filter((t) => t !== LEADS_TAB);
  await batch([
    ...generated.flatMap((t) => wipe(sheets.get(t)!)),
    ...wanted.map((t, index) => ({ updateSheetProperties: { properties: { sheetId: id(t), index }, fields: 'index' } })),
    { updateSheetProperties: { properties: { sheetId: id(TABS.data), hidden: true }, fields: 'hidden' } },
    { updateSheetProperties: { properties: { sheetId: id(TABS.dashboard), tabColorStyle: { rgbColor: C.accent } }, fields: 'tabColorStyle' } },
    { updateSheetProperties: { properties: { sheetId: id(TABS.prospects), tabColorStyle: { rgbColor: C.ink } }, fields: 'tabColorStyle' } },
    { updateSheetProperties: { properties: { sheetId: id(LEADS_TAB), tabColorStyle: { rgbColor: C.muted } }, fields: 'tabColorStyle' } },
    {
      updateSpreadsheetProperties: {
        properties: {
          title: 'Pause-Com — Leads & Meta Business Suite',
          spreadsheetTheme: {
            primaryFontFamily: FONT,
            themeColors: [
              { colorType: 'TEXT', color: { rgbColor: C.ink } },
              { colorType: 'BACKGROUND', color: { rgbColor: C.white } },
              { colorType: 'ACCENT1', color: { rgbColor: C.accent } },
              { colorType: 'ACCENT2', color: { rgbColor: C.ink } },
              { colorType: 'ACCENT3', color: { rgbColor: hex('#C9A66B') } },
              { colorType: 'ACCENT4', color: { rgbColor: hex('#6B8F71') } },
              { colorType: 'ACCENT5', color: { rgbColor: hex('#8A7F72') } },
              { colorType: 'ACCENT6', color: { rgbColor: hex('#D98C5F') } },
              { colorType: 'LINK', color: { rgbColor: C.accent } },
            ],
          },
        },
        fields: 'title,spreadsheetTheme',
      },
    },
  ]);

  // 3. Onglet Leads : en-têtes lisibles et mise en forme, valeurs intactes.
  const leadsMeta = sheets.get(LEADS_TAB)!;
  await write(LEADS_TAB, 'A1', [['Date', 'Nom', 'E-mail', 'Téléphone', 'Entreprise', 'Profil', 'ID lead']]);
  await batch([
    ...(leadsMeta.bandedRanges ?? []).map((x) => ({ deleteBanding: { bandedRangeId: x.bandedRangeId } })),
    ...(leadsMeta.basicFilter ? [{ clearBasicFilter: { sheetId: id(LEADS_TAB) } }] : []),
    ...tableStyle(id(LEADS_TAB), 7, leads.length, [170, 220, 220, 150, 240, 200, 150]),
    // Texte brut : un téléphone ou un identifiant ne doit jamais redevenir un nombre.
    fmt(range(id(LEADS_TAB), 1, 5000, 3, 4), { numberFormat: { type: 'TEXT' } }, 'numberFormat'),
    fmt(range(id(LEADS_TAB), 1, 5000, 6, 7), { numberFormat: { type: 'TEXT' }, textFormat: { fontFamily: FONT, fontSize: 9, foregroundColor: C.muted } }, 'numberFormat,textFormat'),
    fmt(range(id(LEADS_TAB), 1, leads.length + 1, 1, 2), { textFormat: { fontFamily: FONT, fontSize: 10, bold: true, foregroundColor: C.ink } }, 'textFormat'),
    {
      updateCells: {
        range: range(id(LEADS_TAB), 0, 1, 0, 1),
        rows: [{ values: [{ note: 'Onglet source, alimenté automatiquement par Meta. Ne pas modifier ni trier : la synchronisation s’y appuie. Pour consulter les leads, utiliser l’onglet « Prospects ».' }] }],
        fields: 'note',
      },
    },
  ]);

  // 3 bis. Prospects : vue en direct de l'onglet source, calculée par formule.
  // Chaque lead écrit par le webhook y apparaît aussitôt, à l'heure de Paris
  // (changement d'heure compris) et avec un profil lisible.
  const L = `'${LEADS_TAB}'`;
  const a = (...xs: string[]) => xs.join(SEP);
  const view =
    `=ARRAYFORMULA(LET(${a(
      `src`, `FILTER(${L}!A2:G${SEP}${L}!G2:G<>"")`,
      `iso`, `INDEX(src${SEP}${SEP}1)`,
      `u`, `DATEVALUE(LEFT(iso${SEP}10))+TIMEVALUE(MID(iso${SEP}12${SEP}8))`,
      `y`, `YEAR(u)`,
      // Heure d'été européenne : du dernier dimanche de mars au dernier dimanche d'octobre, 1 h UTC.
      `m`, `DATE(y${SEP}3${SEP}31)-MOD(WEEKDAY(DATE(y${SEP}3${SEP}31)${SEP}2)${SEP}7)+1/24`,
      `o`, `DATE(y${SEP}10${SEP}31)-MOD(WEEKDAY(DATE(y${SEP}10${SEP}31)${SEP}2)${SEP}7)+1/24`,
      `p`, `u+IF((u>=m)*(u<o)${SEP}2${SEP}1)/24`,
      `pr`, `SUBSTITUTE(INDEX(src${SEP}${SEP}6)${SEP}"_"${SEP}" ")`,
      `pp`, `IF(pr=""${SEP}""${SEP}UPPER(LEFT(pr${SEP}1))&MID(pr${SEP}2${SEP}200))`,
      `SORT({${[`p`, `INDEX(src${SEP}${SEP}2)`, `INDEX(src${SEP}${SEP}4)`, `INDEX(src${SEP}${SEP}5)`, `pp`, `INDEX(src${SEP}${SEP}3)`].join(COL)}}${SEP}1${SEP}FALSE)`
    )}))`;
  const pid = id(TABS.prospects);
  await write(TABS.prospects, 'A1', [['Date (Paris)', 'Nom', 'Téléphone', 'Entreprise', 'Profil', 'E-mail']]);
  await write(TABS.prospects, 'A2', [[view]], 'USER_ENTERED');
  await batch([
    ...tableStyle(pid, 6, leads.length, [170, 240, 160, 280, 220, 240]),
    fmt(range(pid, 1, 5000, 0, 1), { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy "à" hh:mm' }, textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: C.muted } }, 'numberFormat,textFormat'),
    fmt(range(pid, 1, 5000, 1, 2), { textFormat: { fontFamily: FONT, fontSize: 10, bold: true, foregroundColor: C.ink } }, 'textFormat'),
    fmt(range(pid, 1, 5000, 2, 3), { numberFormat: { type: 'TEXT' } }, 'numberFormat'),
  ]);

  // 4. Onglets de détail.
  const detail: Array<[string, Built]> = [
    [TABS.instagram, instagramTab(b)],
    [TABS.facebook, facebookTab(b)],
    [TABS.audience, audienceTab(b)],
    [TABS.messages, messagesTab(b)],
    [TABS.mentions, mentionsTab(b)],
    [TABS.reviews, reviewsTab(b)],
  ];
  for (const [tab, built] of detail) {
    await write(tab, 'A1', built.rows);
    for (const f of built.formulas ?? []) {
      const col = String.fromCharCode(65 + f.col);
      await write(tab, `${col}2`, f.values.map((v) => [v]), 'USER_ENTERED');
    }
    const sid = id(tab);
    const n = built.rows.length - 1;
    await batch([
      ...tableStyle(sid, built.rows[0]!.length, n, built.widths),
      ...(built.rowHeight && n ? [rowHeight(sid, 1, n + 1, built.rowHeight)] : []),
      ...(built.numeric ?? []).map((c) =>
        fmt(range(sid, 1, n + 1, c, c + 1), { horizontalAlignment: 'RIGHT', numberFormat: { type: 'NUMBER', pattern: '#,##0' } }, 'horizontalAlignment,numberFormat')
      ),
      ...(built.rowHeight ? [fmt(range(sid, 1, n + 1, 0, built.rows[0]!.length), { wrapStrategy: 'WRAP', verticalAlignment: 'MIDDLE' }, 'wrapStrategy,verticalAlignment')] : []),
    ]);
  }
  // Ligne de total de l'onglet Audience.
  const aud = audienceTab(b).rows.length;
  await batch([
    fmt(range(id(TABS.audience), aud - 1, aud, 0, 4), { backgroundColor: C.accentSoft, textFormat: { fontFamily: FONT, bold: true, foregroundColor: C.ink } }, 'backgroundColor,textFormat'),
  ]);

  // 5. Données des graphiques (onglet masqué).
  const months = monthlyLeads(leads);
  const profiles = profileLeads(leads);
  const series = b.pageInsights.ok ? b.pageInsights.data : [];
  const daily: Cell[][] = (series[0]?.dates ?? []).map((d, i) => [day(d).slice(0, 5), ...series.map((s) => s.values[i] ?? 0)]);
  const topIg = (b.instagram.ok ? (b.instagram.data.media?.data ?? []) : [])
    .slice()
    .sort((x, y) => (y.like_count ?? 0) - (x.like_count ?? 0))
    .slice(0, 8)
    .map((m) => [oneLine(m.caption, 28) || day(m.timestamp), m.like_count ?? 0, m.comments_count ?? 0] as Cell[]);
  await write(TABS.data, 'A1', [['Mois', 'Leads'], ...months]);
  await write(TABS.data, 'D1', [['Profil', 'Leads'], ...profiles]);
  await write(TABS.data, 'G1', [['Jour', ...series.map((s) => s.title)], ...daily]);
  await write(TABS.data, 'L1', [['Publication', 'J’aime', 'Commentaires'], ...topIg]);

  // 6. Tableau de bord : titre, indicateurs, graphiques.
  const dash = id(TABS.dashboard);
  const ig = b.instagram.ok ? b.instagram.data : undefined;
  const igStat = (name: string) => (b.igInsights.ok ? b.igInsights.data.find((m) => m.name === name)?.value ?? 0 : 0);
  const pageStat = (name: string) => (b.pageInsights.ok ? b.pageInsights.data.find((m) => m.name === name)?.total ?? 0 : 0);
  const within = (days: number) => leads.filter((r) => Date.now() - +new Date(r[0]) < days * 86400_000).length;
  const unread = b.conversations.ok ? b.conversations.data.filter((c) => c.unread_count).length : 0;

  const cards: Array<[string, number, string]> = [
    ['Leads au total', leads.length, 'Instant Forms Facebook et Instagram'],
    ['Leads — 30 jours', within(30), `dont ${within(7)} sur les 7 derniers jours`],
    ['Abonnés Instagram', ig?.followers_count ?? 0, `@${ig?.username ?? ''}`],
    ['Abonnés Facebook', b.page.ok ? (b.page.data.followers_count ?? 0) : 0, 'Page Pause-Com'],
    ['Comptes touchés', igStat('reach'), 'Instagram · 28 jours'],
    ['Vues', igStat('views'), 'Instagram · 28 jours'],
    ['Interactions', pageStat('page_post_engagements') + igStat('total_interactions'), 'Facebook + Instagram · 28 jours'],
    ['Messages non lus', unread, 'Messenger'],
  ];

  const updated = new Date().toLocaleString('fr-FR', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' });
  const dashRows: Cell[][] = [
    ['Pause-Com — Tableau de bord Meta'],
    [`Leads, Instagram et Facebook · mis à jour le ${updated} · actualisation automatique toutes les heures`],
    [],
  ];
  // Deux rangées de quatre cartes ; chaque carte occupe trois colonnes.
  for (const chunk of [cards.slice(0, 4), cards.slice(4, 8)]) {
    const label: Cell[] = [], value: Cell[] = [], note: Cell[] = [];
    for (const [l, v, n] of chunk) {
      label.push(l, '', '');
      value.push(v, '', '');
      note.push(n, '', '');
    }
    dashRows.push(label, value, note, []);
  }
  await write(TABS.dashboard, 'A1', dashRows);

  const cardRequests: Request[] = [];
  for (const top of [3, 7]) {
    for (let k = 0; k < 4; k++) {
      const c0 = k * 3;
      for (const r of [top, top + 1, top + 2]) {
        cardRequests.push({ mergeCells: { range: range(dash, r, r + 1, c0, c0 + 3), mergeType: 'MERGE_ALL' } });
      }
      cardRequests.push(
        fmt(range(dash, top, top + 3, c0, c0 + 3), { backgroundColor: C.paper }, 'backgroundColor'),
        fmt(range(dash, top, top + 1, c0, c0 + 3), { textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: C.muted }, verticalAlignment: 'BOTTOM', padding: { left: 14, top: 10 } }, 'textFormat,verticalAlignment,padding'),
        fmt(range(dash, top + 1, top + 2, c0, c0 + 3), { textFormat: { fontFamily: TITLE_FONT, fontSize: 26, bold: true, foregroundColor: k === 0 && top === 3 ? C.accent : C.ink }, horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE', numberFormat: { type: 'NUMBER', pattern: '#,##0' }, padding: { left: 14 } }, 'textFormat,horizontalAlignment,verticalAlignment,numberFormat,padding'),
        fmt(range(dash, top + 2, top + 3, c0, c0 + 3), { textFormat: { fontFamily: FONT, fontSize: 9, foregroundColor: C.muted }, verticalAlignment: 'TOP', padding: { left: 14, bottom: 10 } }, 'textFormat,verticalAlignment,padding'),
        {
          updateBorders: {
            range: range(dash, top, top + 3, c0, c0 + 3),
            top: { style: 'SOLID', color: C.line },
            bottom: { style: 'SOLID', color: C.line },
            left: { style: 'SOLID_THICK', color: k === 0 && top === 3 ? C.accent : C.ink },
            right: { style: 'SOLID', color: C.line },
          },
        }
      );
    }
  }

  const dataId = id(TABS.data);
  const src = (c0: number, c1: number, r1: number) => ({ sourceRange: { sources: [range(dataId, 0, r1, c0, c1)] } });
  const anchor = (row: number, col: number, w: number, h: number) => ({
    overlayPosition: { anchorCell: { sheetId: dash, rowIndex: row, columnIndex: col }, offsetXPixels: 0, offsetYPixels: 8, widthPixels: w, heightPixels: h },
  });
  const titleStyle = { fontFamily: TITLE_FONT, fontSize: 14, bold: true, foregroundColor: C.ink };
  const axis = (title: string) => ({ position: 'LEFT_AXIS', title, format: { fontFamily: FONT, foregroundColor: C.muted } });

  const charts: Request[] = [
    {
      addChart: {
        chart: {
          spec: {
            title: 'Leads par mois',
            titleTextFormat: titleStyle,
            fontName: FONT,
            basicChart: {
              chartType: 'COLUMN',
              legendPosition: 'NO_LEGEND',
              axis: [{ position: 'BOTTOM_AXIS' }, axis('Leads')],
              domains: [{ domain: src(0, 1, months.length + 1) }],
              series: [{ series: src(1, 2, months.length + 1), targetAxis: 'LEFT_AXIS', colorStyle: { rgbColor: C.accent }, dataLabel: { type: 'DATA', placement: 'OUTSIDE_END' } }],
              headerCount: 1,
            },
          },
          position: anchor(12, 0, 560, 320),
        },
      },
    },
    {
      addChart: {
        chart: {
          spec: {
            title: 'Leads par profil',
            titleTextFormat: titleStyle,
            fontName: FONT,
            pieChart: {
              legendPosition: 'RIGHT_LEGEND',
              domain: src(3, 4, profiles.length + 1),
              series: src(4, 5, profiles.length + 1),
              pieHole: 0.55,
            },
          },
          position: anchor(12, 6, 560, 320),
        },
      },
    },
  ];
  if (daily.length) {
    charts.push({
      addChart: {
        chart: {
          spec: {
            title: 'Audience Facebook — 28 jours',
            titleTextFormat: titleStyle,
            fontName: FONT,
            basicChart: {
              chartType: 'LINE',
              legendPosition: 'BOTTOM_LEGEND',
              lineSmoothing: true,
              axis: [{ position: 'BOTTOM_AXIS' }, axis('Par jour')],
              domains: [{ domain: src(6, 7, daily.length + 1) }],
              series: series.map((_, i) => ({
                series: src(7 + i, 8 + i, daily.length + 1),
                targetAxis: 'LEFT_AXIS',
                colorStyle: { rgbColor: [C.accent, C.ink, hex('#C9A66B')][i] ?? C.muted },
              })),
              headerCount: 1,
            },
          },
          position: anchor(30, 0, 560, 320),
        },
      },
    });
  }
  if (topIg.length) {
    charts.push({
      addChart: {
        chart: {
          spec: {
            title: 'Publications Instagram les plus aimées',
            titleTextFormat: titleStyle,
            fontName: FONT,
            basicChart: {
              chartType: 'BAR',
              legendPosition: 'BOTTOM_LEGEND',
              axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS' }],
              domains: [{ domain: src(11, 12, topIg.length + 1) }],
              series: [
                { series: src(12, 13, topIg.length + 1), targetAxis: 'BOTTOM_AXIS', colorStyle: { rgbColor: C.accent } },
                { series: src(13, 14, topIg.length + 1), targetAxis: 'BOTTOM_AXIS', colorStyle: { rgbColor: C.ink } },
              ],
              headerCount: 1,
            },
          },
          position: anchor(30, 6, 560, 320),
        },
      },
    });
  }

  await batch([
    { updateSheetProperties: { properties: { sheetId: dash, gridProperties: { hideGridlines: true } }, fields: 'gridProperties.hideGridlines' } },
    ...widths(dash, Array(12).fill(94)),
    fmt(range(dash, 0, 60, 0, 12), { backgroundColor: C.white, textFormat: { fontFamily: FONT } }, 'backgroundColor,textFormat'),
    { mergeCells: { range: range(dash, 0, 1, 0, 12), mergeType: 'MERGE_ALL' } },
    { mergeCells: { range: range(dash, 1, 2, 0, 12), mergeType: 'MERGE_ALL' } },
    fmt(range(dash, 0, 2, 0, 12), { backgroundColor: C.ink }, 'backgroundColor'),
    fmt(range(dash, 0, 1, 0, 12), { textFormat: { fontFamily: TITLE_FONT, fontSize: 24, bold: true, foregroundColor: C.cream }, verticalAlignment: 'BOTTOM', padding: { left: 18, top: 12 } }, 'textFormat,verticalAlignment,padding'),
    fmt(range(dash, 1, 2, 0, 12), { textFormat: { fontFamily: FONT, fontSize: 10, foregroundColor: hex('#CFC8B8') }, verticalAlignment: 'TOP', padding: { left: 18, bottom: 12 } }, 'textFormat,verticalAlignment,padding'),
    rowHeight(dash, 0, 1, 58),
    rowHeight(dash, 1, 2, 34),
    rowHeight(dash, 2, 3, 18),
    ...[3, 7].flatMap((r) => [rowHeight(dash, r, r + 1, 30), rowHeight(dash, r + 1, r + 2, 48), rowHeight(dash, r + 2, r + 3, 28), rowHeight(dash, r + 3, r + 4, 14)]),
    ...cardRequests,
    ...charts,
  ]);

  console.log(`\n✅ Rapport écrit : ${leads.length} leads, ${instagramTab(b).rows.length - 1} publications Instagram, ${facebookTab(b).rows.length - 1} Facebook, ${messagesTab(b).rows.length - 1} conversations, ${charts.length} graphiques.`);
  console.log(`   https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}/edit`);
});
