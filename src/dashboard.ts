/**
 * Tableau de bord de production : rendu HTML de l'état collecté par
 * `lib/status.ts`.
 *
 * La page fonctionne sans JavaScript (toutes les données sont dans le HTML).
 * Le script ajoute la recherche, les filtres, la fiche détaillée d'un lead et
 * l'actualisation automatique, sans jamais construire de HTML à partir de
 * données : tout passe par `textContent`.
 */
import type { Status } from './lib/status.js';
import type { Business } from './lib/business.js';
import { renderBusiness, businessNav, businessCss, businessScript } from './dashboard-business.js';
import type { LeadRow } from './types.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

// Render tourne en UTC : tout est ramené à l'heure de Paris.
const TZ = 'Europe/Paris';

const dateTime = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(+d)
    ? esc(iso)
    : d.toLocaleString('fr-FR', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const since = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - +new Date(iso)) / 1000));
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
};

/** « 2026-09 », calculé à l'heure de Paris. */
const monthKey = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
};

/** `professionnel_de_l'hôtellerie` → « Professionnel de l'hôtellerie ». */
const prettify = (key: string) => {
  const t = key.replace(/_/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : '';
};

// ── Tendance mensuelle ────────────────────────────────────────────────────

function monthly(rows: LeadRow[]): Array<{ key: string; short: string; long: string; count: number }> {
  const now = new Date();
  const buckets = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 15));
    buckets.push({
      key: monthKey(d.toISOString()),
      short: d.toLocaleDateString('fr-FR', { month: 'short', timeZone: TZ }).replace('.', ''),
      long: d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: TZ }),
      count: 0,
    });
  }
  for (const r of rows) {
    const b = buckets.find((x) => x.key === monthKey(r[0]));
    if (b) b.count++;
  }
  return buckets;
}

// ── Page ──────────────────────────────────────────────────────────────────

export function renderDashboard(s: Status, b: Business, refreshSeconds: number, version: number): string {
  const rows = s.sheet.ok ? [...s.sheet.data.rows].sort((a, b) => +new Date(b[0]) - +new Date(a[0])) : [];
  const within = (days: number) => rows.filter((r) => Date.now() - +new Date(r[0]) < days * 86400_000).length;
  const last = rows[0];
  const months = monthly(rows);
  const max = Math.max(1, ...months.map((m) => m.count));
  const n = s.server.notifications;
  const profiles = [...new Set(rows.map((r) => r[5]).filter(Boolean))].sort();
  const origin = (process.env.RENDER_EXTERNAL_URL ?? '').replace(/\/$/, '');
  const sheetUrl = process.env.GOOGLE_SPREADSHEET_ID
    ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(process.env.GOOGLE_SPREADSHEET_ID)}/edit`
    : '';

  // Le détail des contrôles relève du développement (`npm run status`) : la
  // page n'en garde que la synthèse.
  const statusText = s.healthy ? 'Automatisation opérationnelle' : 'Synchronisation à vérifier';

  // Les tuiles actionnables sont de vrais boutons : clavier et lecteur d'écran
  // les annoncent comme tels.
  const tile = (label: string, value: string, note: string, action = '') =>
    action
      ? `<li><button type="button" class="tile" ${action}><span class="tile-label">${esc(label)}</span><span class="tile-value">${esc(value)}</span><span class="tile-note">${esc(note)}</span></button></li>`
      : `<li><div class="tile"><span class="tile-label">${esc(label)}</span><span class="tile-value">${esc(value)}</span><span class="tile-note">${esc(note)}</span></div></li>`;

  const tiles = [
    tile('Leads au total', s.sheet.ok ? String(s.sheet.data.total) : '—', 'Afficher tous les leads', 'data-period="all"'),
    tile('7 derniers jours', String(within(7)), 'Filtrer la liste', 'data-period="7"'),
    tile('30 derniers jours', String(within(30)), 'Filtrer la liste', 'data-period="30"'),
    tile('Dernier lead', last ? since(last[0]) : '—', last ? `${last[1] || 'Sans nom'} — voir la fiche` : '', last ? `data-open="${esc(last[6])}"` : ''),
    tile('Disponibles chez Meta', s.meta.ok ? String(s.meta.data.retrievable) : '—', 'Meta purge après 90 jours'),
    tile('Formulaires actifs', s.meta.ok ? `${s.meta.data.activeForms} / ${s.meta.data.forms}` : '—', 'Instant Forms de la Page'),
    tile('Notifications reçues', String(n.reçues), `${n.écrites} écrite(s), ${n.échecs} échec(s) — voir l'activité`, 'data-jump="activite"'),
  ].join('');

  const bars = months
    .map(
      (m) => `<li><button type="button" class="bar" data-month="${m.key}" aria-pressed="false" aria-label="${esc(m.long)} : ${m.count} lead${m.count > 1 ? 's' : ''}${m.count ? ', filtrer la liste' : ''}"${m.count ? '' : ' disabled'}>
        <span class="bar-value" aria-hidden="true">${m.count || ''}</span>
        <span class="bar-fill" style="--h:${Math.round((m.count / max) * 100)}%" aria-hidden="true"></span>
        <span class="bar-label" aria-hidden="true">${esc(m.short)}</span>
      </button></li>`
    )
    .join('');

  const leadRows = rows
    .map((r) => {
      const search = [r[1], r[2], r[3], r[4], prettify(r[5])].join(' ').toLowerCase();
      return `<tr data-id="${esc(r[6])}" data-date="${esc(r[0])}" data-month="${monthKey(r[0])}" data-profile="${esc(r[5])}" data-search="${esc(search)}">
        <td data-label="Date" class="c-date"><time datetime="${esc(r[0])}">${dateTime(r[0])}</time></td>
        <th scope="row" data-label="Nom" class="c-name"><button type="button" class="link" data-open="${esc(r[6])}" aria-haspopup="dialog">${esc(r[1] || 'Sans nom')}</button></th>
        <td data-label="Téléphone">${r[3] ? `<a href="tel:${esc(r[3])}">${esc(r[3])}</a>` : '<span class="muted">—</span>'}</td>
        <td data-label="E-mail">${r[2] ? `<a href="mailto:${esc(r[2])}">${esc(r[2])}</a>` : '<span class="muted">—</span>'}</td>
        <td data-label="Entreprise">${esc(r[4] || '—')}</td>
        <td data-label="Profil">${r[5] ? `<span class="chip">${esc(prettify(r[5]))}</span>` : '<span class="muted">—</span>'}</td>
      </tr>`;
    })
    .join('');

  const activityRows = s.server.activity
    .map(
      (a) => `<tr>
        <td data-label="Reçu" class="c-date"><time datetime="${esc(a.at)}">${dateTime(a.at)}</time></td>
        <td data-label="Résultat"><span class="status status-${a.status === 'échec' ? 'ko' : a.status === 'écrit' ? 'ok' : 'neutral'}">${esc(a.status)}</span></td>
        <th scope="row" data-label="Élément">${a.leadId ? `<button type="button" class="link" data-open="${esc(a.leadId)}" aria-haspopup="dialog">${esc(a.name || a.leadId)}</button>` : esc(a.kind ?? '—')}</th>
        <td data-label="Erreur" class="c-error">${esc(a.error ?? '')}</td>
      </tr>`
    )
    .join('');

  const missing = s.sync.ok ? s.sync.data.missing : [];
  const missingRows = missing
    .map(
      (m) => `<tr>
        <td data-label="Déposé" class="c-date"><time datetime="${esc(m.createdTime ?? '')}">${dateTime(m.createdTime)}</time></td>
        <th scope="row" data-label="Lead"><button type="button" class="link" data-open="${esc(m.id)}" aria-haspopup="dialog">${esc(m.id)}</button></th>
        <td data-label="Formulaire">${esc(m.form ?? '—')}</td>
      </tr>`
    )
    .join('');

  const description =
    'Tableau de bord Pause-Com : suivi en temps réel des leads Meta (Facebook et Instagram) synchronisés automatiquement vers Google Sheets.';

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Leads Meta — Pause-Com</title>
<meta name="description" content="${esc(description)}">
<meta name="author" content="Pause-Com">
<meta name="application-name" content="Leads Pause-Com">
<!-- Page privée : elle affiche des données personnelles et ne doit jamais être indexée. -->
<meta name="robots" content="noindex, nofollow, noarchive">
${origin ? `<link rel="canonical" href="${esc(origin)}/dashboard">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Pause-Com">
<meta property="og:title" content="Leads Meta — Pause-Com">
<meta property="og:description" content="${esc(description)}">
<meta property="og:locale" content="fr_FR">
${origin ? `<meta property="og:image" content="${esc(origin)}/logo.png">` : ''}
<meta name="twitter:card" content="summary">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0b0b0b">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap">
<style>
:root {
  color-scheme: light dark;
  --ink: #141312; --paper: #f6f2ea; --surface: #fffdf8; --raised: #ffffff;
  --muted: #5d5850; --line: #e6dfd2; --line-strong: #d4cbbb;
  --brand: #0b0b0b; --cream: #f7f3e8; --accent: #b3261e; --accent-soft: #b3261e14;
  --ok: #1d6f3a; --ok-soft: #1d6f3a14; --ko: #b3261e; --ko-soft: #b3261e12;
  --focus: #b3261e; --shadow: 0 1px 2px #1413120a, 0 8px 24px -12px #14131226;
  --radius: 14px;
  --serif: 'Fraunces', Georgia, 'Times New Roman', serif;
  --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #f2ede3; --paper: #0d0c0b; --surface: #161513; --raised: #1c1b18;
    --muted: #b8b0a3; --line: #2a2824; --line-strong: #3a3732;
    --accent: #ff7a6e; --accent-soft: #ff7a6e1a; --ok: #6fd394; --ok-soft: #6fd3941a;
    --ko: #ff7a6e; --ko-soft: #ff7a6e1a; --focus: #ff9d93; --shadow: 0 1px 2px #0006, 0 8px 24px -12px #000c;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 76px; -webkit-text-size-adjust: 100%; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { transition: none !important; animation: none !important; } }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.6 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--accent); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 6px; }
code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--accent-soft); padding: 1px 6px; border-radius: 5px; }
.sr-only { position: absolute !important; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.muted { color: var(--muted); }

.skip { position: absolute; left: 16px; top: -60px; z-index: 50; background: var(--cream); color: #0b0b0b; padding: 10px 16px; border-radius: 10px; font-weight: 600; }
.skip:focus { top: 12px; }

/* En-tête de marque */
.masthead { background: var(--brand); color: var(--cream); }
.masthead-inner { max-width: 1200px; margin: 0 auto; padding: 28px 20px 30px; display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
.masthead img { height: 64px; width: auto; display: block; }
.masthead-text { flex: 1; min-width: 240px; }
.eyebrow { font-size: 12px; letter-spacing: .16em; text-transform: uppercase; color: #cfc8b8; margin: 0 0 4px; }
h1 { font: 600 clamp(26px, 4vw, 36px)/1.1 var(--serif); margin: 0; letter-spacing: -.01em; }
.updated { margin: 8px 0 0; color: #cfc8b8; font-size: 13.5px; }
.state { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; font-weight: 600; font-size: 13.5px; border: 1px solid #ffffff26; background: #ffffff0d; }
.state::before { content: ''; width: 9px; height: 9px; border-radius: 50%; background: #6fd394; box-shadow: 0 0 0 4px #6fd3942e; }
.state.is-ko::before { background: #ff7a6e; box-shadow: 0 0 0 4px #ff7a6e2e; }
.masthead-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.btn { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: 11px; font: 600 14px var(--sans); cursor: pointer; text-decoration: none; border: 1px solid transparent; }
.btn-light { background: var(--cream); color: #0b0b0b; }
.btn-light:hover { background: #fff; }
.btn-ghost { background: transparent; color: var(--cream); border-color: #ffffff38; }
.btn-ghost:hover { border-color: var(--cream); }
.toggle { display: inline-flex; align-items: center; gap: 8px; color: #cfc8b8; font-size: 13.5px; min-height: 44px; cursor: pointer; }
.toggle input { width: 18px; height: 18px; accent-color: #ff7a6e; }

/* Navigation des sections */
.sections { position: sticky; top: 0; z-index: 20; background: color-mix(in srgb, var(--paper) 88%, transparent); backdrop-filter: saturate(1.4) blur(10px); border-bottom: 1px solid var(--line); }
.sections ul { max-width: 1200px; margin: 0 auto; padding: 0 12px; list-style: none; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
.sections a { display: block; padding: 16px 12px; white-space: nowrap; text-decoration: none; color: var(--muted); font-weight: 500; font-size: 14px; border-bottom: 2px solid transparent; }
.sections a:hover, .sections a[aria-current="true"] { color: var(--ink); border-bottom-color: var(--accent); }

main { max-width: 1200px; margin: 0 auto; padding: 8px 20px 64px; }
section { margin-top: 40px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
h2 { font: 600 22px/1.2 var(--serif); margin: 0; letter-spacing: -.005em; }
.section-note { color: var(--muted); font-size: 13.5px; margin: 0; }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }

/* Chiffres */
.tiles { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
.tile { width: 100%; height: 100%; text-align: left; display: flex; flex-direction: column; gap: 2px; padding: 18px; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); font: inherit; }
button.tile { cursor: pointer; transition: border-color .15s, transform .15s; }
button.tile:hover { border-color: var(--accent); transform: translateY(-1px); }
button.tile[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), var(--shadow); }
.tile-label { color: var(--muted); font-size: 13px; }
.tile-value { font: 600 30px/1.15 var(--serif); letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
.tile-note { color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.tile .tile-note { color: var(--accent); }

/* Tendance */
.chart { list-style: none; margin: 0; padding: 22px 16px 14px; display: grid; grid-template-columns: repeat(12, 1fr); gap: 6px; height: 220px; }
.chart li { min-width: 0; }
.bar { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 6px; background: none; border: 0; padding: 4px 0; border-radius: 10px; cursor: pointer; color: var(--ink); font: inherit; }
.bar:disabled { cursor: default; }
.bar:not(:disabled):hover { background: var(--accent-soft); }
.bar[aria-pressed="true"] { background: var(--accent-soft); }
.bar-fill { width: min(70%, 40px); height: var(--h); min-height: 3px; border-radius: 6px 6px 2px 2px; background: var(--ink); }
.bar[aria-pressed="true"] .bar-fill, .bar:not(:disabled):hover .bar-fill { background: var(--accent); }
.bar:disabled .bar-fill { background: var(--line); }
.bar-value { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.bar-label { font-size: 11.5px; color: var(--muted); text-transform: capitalize; }

/* Barre de filtres */
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; padding: 16px; border-bottom: 1px solid var(--line); }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 180px; flex: 1; }
.field label { font-size: 12.5px; font-weight: 600; color: var(--muted); }
.field input, .field select { min-height: 44px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line-strong); background: var(--raised); color: var(--ink); font: inherit; }
.field input:focus-visible, .field select:focus-visible { outline-offset: 0; }
.pill-group { display: flex; gap: 6px; flex-wrap: wrap; border: 0; padding: 0; margin: 0; }
.pill-group legend { font-size: 12.5px; font-weight: 600; color: var(--muted); margin-bottom: 4px; padding: 0; }
.pill { min-height: 44px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line-strong); background: var(--raised); color: var(--ink); font: 500 13.5px var(--sans); cursor: pointer; }
.pill[aria-pressed="true"] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.btn-reset { min-height: 44px; padding: 0 14px; background: none; border: 0; color: var(--accent); font: 600 13.5px var(--sans); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.result-count { padding: 12px 16px 0; margin: 0; color: var(--muted); font-size: 13.5px; }

/* Tableaux */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
caption { text-align: left; }
thead th { text-align: left; font: 600 12px var(--sans); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); padding: 14px 16px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td, tbody th { padding: 12px 16px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; font-weight: 400; }
tbody tr:last-child > * { border-bottom: 0; }
tbody tr[data-id] { cursor: pointer; transition: background .12s; }
tbody tr[data-id]:hover { background: var(--accent-soft); }
.c-date { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.c-error { color: var(--ko); font-size: 13px; }
.link { background: none; border: 0; padding: 4px 0; min-height: 32px; font: 600 14.5px var(--sans); color: var(--ink); cursor: pointer; text-align: left; text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 4px; }
.link:hover { text-decoration-color: var(--accent); color: var(--accent); }
.chip { display: inline-block; padding: 3px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--ink); font-size: 12.5px; white-space: nowrap; }
.status { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; }
.status-ok { background: var(--ok-soft); color: var(--ok); }
.status-ko { background: var(--ko-soft); color: var(--ko); }
.status-neutral { background: var(--line); color: var(--muted); }
.empty { padding: 24px 18px; margin: 0; color: var(--muted); }

/* Mobile : chaque ligne devient une carte */
@media (max-width: 760px) {
  .masthead-inner { padding: 22px 16px; gap: 16px; }
  .masthead img { height: 48px; }
  main { padding: 0 16px 48px; }
  .chart { height: 180px; gap: 2px; padding: 16px 8px 10px; }
  .bar-label { font-size: 10px; }
  table.stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  table.stack, table.stack tbody, table.stack tr, table.stack td, table.stack tbody th { display: block; width: 100%; }
  table.stack tr { padding: 12px 16px; border-bottom: 1px solid var(--line); }
  table.stack tbody tr:last-child { border-bottom: 0; }
  table.stack td, table.stack tbody th { border: 0; padding: 3px 0; display: flex; justify-content: space-between; gap: 16px; text-align: right; }
  table.stack td::before, table.stack tbody th::before { content: attr(data-label); color: var(--muted); font-size: 12.5px; font-weight: 600; text-align: left; flex: none; }
  table.stack .link { text-align: right; }
}

/* Fiche détaillée */
dialog { width: min(640px, calc(100vw - 24px)); max-height: min(88vh, 900px); padding: 0; border: 1px solid var(--line); border-radius: 18px; background: var(--surface); color: var(--ink); box-shadow: 0 30px 80px -20px #000a; }
dialog::backdrop { background: #0b0b0bb3; backdrop-filter: blur(3px); }
.sheet-head { position: sticky; top: 0; background: var(--brand); color: var(--cream); padding: 20px 22px; display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; }
.sheet-head p { margin: 0 0 2px; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #cfc8b8; }
.sheet-head h2 { color: var(--cream); font-size: 26px; overflow-wrap: anywhere; }
.close { flex: none; width: 44px; height: 44px; border-radius: 50%; border: 1px solid #ffffff38; background: transparent; color: var(--cream); font-size: 22px; line-height: 1; cursor: pointer; }
.close:hover { border-color: var(--cream); }
.sheet-body { padding: 20px 22px 26px; overflow-y: auto; }
.sheet-body h3 { font: 600 12px var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 22px 0 10px; }
.sheet-body h3:first-child { margin-top: 0; }
.quick { display: flex; flex-wrap: wrap; gap: 8px; }
.quick a, .quick button { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 14px; border-radius: 11px; border: 1px solid var(--line-strong); background: var(--raised); color: var(--ink); font: 600 13.5px var(--sans); text-decoration: none; cursor: pointer; }
.quick a:hover, .quick button:hover { border-color: var(--accent); }
.quick .primary { background: var(--ink); color: var(--paper); border-color: var(--ink); }
dl.facts { margin: 0; display: grid; grid-template-columns: minmax(120px, 38%) 1fr; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
dl.facts dt, dl.facts dd { margin: 0; padding: 10px 14px; border-bottom: 1px solid var(--line); }
dl.facts dt { color: var(--muted); font-size: 13.5px; background: var(--paper); }
dl.facts dd { overflow-wrap: anywhere; font-weight: 500; }
dl.facts dt:last-of-type, dl.facts dd:last-of-type { border-bottom: 0; }
.notice { padding: 12px 14px; border-radius: 12px; background: var(--accent-soft); font-size: 13.5px; margin: 12px 0 0; }
.loading { color: var(--muted); }

footer { border-top: 1px solid var(--line); }
.footer-inner { max-width: 1200px; margin: 0 auto; padding: 24px 20px 40px; color: var(--muted); font-size: 13px; display: flex; gap: 12px 24px; flex-wrap: wrap; justify-content: space-between; }
footer p { margin: 0; }
.footer-links { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px 20px; }
.footer-links a { color: var(--ink); }
${businessCss}
</style>
</head>
<body>
<a class="skip" href="#contenu">Aller au contenu principal</a>

<header class="masthead">
  <div class="masthead-inner">
    <img src="/logo.png" alt="Pause-Com" width="128" height="64">
    <div class="masthead-text">
      <p class="eyebrow">Automatisation Meta → Google Sheets</p>
      <h1>Leads en temps réel</h1>
      <p class="updated">Données lues en direct chez Meta et dans le Sheet · <span id="age">${since(s.generatedAt)}</span> <span class="sr-only">(${dateTime(s.generatedAt)})</span></p>
    </div>
    <div class="masthead-actions">
      <p class="state${s.healthy ? '' : ' is-ko'}" role="status">${esc(statusText)}</p>
    </div>
    <div class="masthead-actions">
      ${sheetUrl ? `<a class="btn btn-ghost" href="${esc(sheetUrl)}" target="_blank" rel="noopener">Ouvrir le Google Sheet<span class="sr-only"> (nouvel onglet)</span></a>` : ''}
      <a class="btn btn-light" href="?fresh=1">Actualiser maintenant</a>
      <label class="toggle"><input type="checkbox" id="auto" checked> Actualisation auto (${refreshSeconds} s)</label>
    </div>
  </div>
</header>

<nav class="sections" aria-label="Sections du tableau de bord">
  <ul>
    <li><a href="#chiffres">Chiffres clés</a></li>
    <li><a href="#tendance">Tendance</a></li>
    ${missing.length ? '<li><a href="#manquants">À rattraper</a></li>' : ''}
    <li><a href="#leads">Leads</a></li>${businessNav}
    <li><a href="#activite">Activité</a></li>
  </ul>
</nav>

<main id="contenu" tabindex="-1">
  <section id="chiffres" aria-labelledby="h-chiffres">
    <div class="section-head">
      <h2 id="h-chiffres">Chiffres clés</h2>
      <p class="section-note">Les tuiles soulignées filtrent la liste ou ouvrent une fiche</p>
    </div>
    <ul class="tiles">${tiles}</ul>
  </section>

  <section id="tendance" aria-labelledby="h-tendance">
    <div class="section-head">
      <h2 id="h-tendance">Leads par mois</h2>
      <p class="section-note">12 derniers mois · cliquer sur un mois pour filtrer</p>
    </div>
    <div class="card"><ul class="chart" aria-label="Nombre de leads par mois">${bars}</ul></div>
  </section>

  ${
    missing.length
      ? `<section id="manquants" aria-labelledby="h-manquants">
    <div class="section-head">
      <h2 id="h-manquants">Leads chez Meta absents du Sheet</h2>
      <p class="section-note">À rattraper avec <code>npm run backfill</code></p>
    </div>
    <div class="card table-wrap"><table class="stack">
      <caption class="sr-only">${missing.length} lead(s) présents chez Meta mais absents du Sheet</caption>
      <thead><tr><th scope="col">Déposé</th><th scope="col">Lead</th><th scope="col">Formulaire</th></tr></thead>
      <tbody>${missingRows}</tbody>
    </table></div>
  </section>`
      : ''
  }

  <section id="leads" aria-labelledby="h-leads">
    <div class="section-head">
      <h2 id="h-leads">Leads</h2>
      <p class="section-note">Cliquer sur une ligne pour ouvrir la fiche complète</p>
    </div>
    <div class="card">
      <form class="toolbar" role="search" aria-label="Filtrer les leads" onsubmit="return false">
        <div class="field">
          <label for="q">Rechercher</label>
          <input id="q" type="search" autocomplete="off" placeholder="Nom, téléphone, entreprise…">
        </div>
        <div class="field">
          <label for="profile">Profil</label>
          <select id="profile">
            <option value="">Tous les profils</option>
            ${profiles.map((p) => `<option value="${esc(p)}">${esc(prettify(p))}</option>`).join('')}
          </select>
        </div>
        <fieldset class="pill-group">
          <legend>Période</legend>
          <button type="button" class="pill" data-period="all" aria-pressed="true">Tout</button>
          <button type="button" class="pill" data-period="7" aria-pressed="false">7 jours</button>
          <button type="button" class="pill" data-period="30" aria-pressed="false">30 jours</button>
        </fieldset>
        <button type="button" class="btn-reset" id="reset">Réinitialiser</button>
      </form>
      <p class="result-count" id="count" role="status" aria-live="polite">${rows.length} lead${rows.length > 1 ? 's' : ''}</p>
      ${
        rows.length
          ? `<div class="table-wrap"><table class="stack" id="leads-table">
        <caption class="sr-only">Liste des leads, du plus récent au plus ancien</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Nom</th><th scope="col">Téléphone</th><th scope="col">E-mail</th><th scope="col">Entreprise</th><th scope="col">Profil</th></tr></thead>
        <tbody>${leadRows}</tbody></table></div>
        <p class="empty" id="none" hidden>Aucun lead ne correspond à ces filtres.</p>`
          : `<p class="empty">${s.sheet.ok ? 'Aucun lead pour le moment.' : esc(s.sheet.ok ? '' : s.sheet.error)}</p>`
      }
    </div>
  </section>
${renderBusiness(b)}

  <section id="activite" aria-labelledby="h-activite">
    <div class="section-head">
      <h2 id="h-activite">Activité en temps réel</h2>
      <p class="section-note">Depuis le démarrage du serveur, le ${dateTime(s.server.startedAt)}</p>
    </div>
    <div class="card table-wrap">${
      activityRows
        ? `<table class="stack">
        <caption class="sr-only">Notifications reçues de Meta depuis le démarrage</caption>
        <thead><tr><th scope="col">Reçu</th><th scope="col">Résultat</th><th scope="col">Élément</th><th scope="col">Erreur</th></tr></thead>
        <tbody>${activityRows}</tbody></table>`
        : `<p class="empty">Aucune notification de Meta depuis le démarrage. Les leads arrivent aussi par la synchronisation automatique toutes les 10 minutes ; ce journal repart à zéro à chaque redémarrage.</p>`
    }</div>
  </section>

</main>

<dialog id="sheet" aria-labelledby="sheet-title" aria-describedby="sheet-sub">
  <div class="sheet-head">
    <div><p id="sheet-sub">Fiche lead</p><h2 id="sheet-title">—</h2></div>
    <button type="button" class="close" id="sheet-close" aria-label="Fermer la fiche">×</button>
  </div>
  <div class="sheet-body" id="sheet-body" aria-live="polite"></div>
</dialog>

<footer>
  <div class="footer-inner">
    <p>© ${new Date().getFullYear()} Pause-Com · Page privée : elle contient des données personnelles.</p>
    <nav aria-label="Informations légales">
      <ul class="footer-links">
        <li><a href="/confidentialite">Politique de confidentialité</a></li>
        <li><a href="/suppression-des-donnees">Suppression des données</a></li>
        <li><a href="/api/status">Données brutes</a></li>
      </ul>
    </nav>
  </div>
</footer>

<script>
(function () {
  'use strict';
  var REFRESH = ${refreshSeconds * 1000};
  var generated = new Date(${JSON.stringify(s.generatedAt)});
  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  };

  // ── Âge des données ──
  var age = document.getElementById('age');
  function tick() {
    var s = Math.round((Date.now() - generated) / 1000);
    age.textContent = s < 60 ? 'il y a ' + s + ' s' : 'il y a ' + Math.round(s / 60) + ' min';
  }
  setInterval(tick, 5000);

  // ── Filtres ──
  var table = document.getElementById('leads-table');
  var rows = table ? Array.prototype.slice.call(table.tBodies[0].rows) : [];
  var q = document.getElementById('q');
  var profile = document.getElementById('profile');
  var count = document.getElementById('count');
  var none = document.getElementById('none');
  var state = { q: '', profile: '', period: 'all', month: '' };
  try { Object.assign(state, JSON.parse(store.get('filters') || '{}')); } catch (e) {}

  function pressed(selector, attr, value) {
    document.querySelectorAll(selector).forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value));
    });
  }

  function apply() {
    var needle = state.q.trim().toLowerCase();
    var now = Date.now();
    var shown = 0;
    rows.forEach(function (tr) {
      var ok = true;
      if (needle && tr.dataset.search.indexOf(needle) === -1) ok = false;
      if (state.profile && tr.dataset.profile !== state.profile) ok = false;
      if (state.period !== 'all' && now - new Date(tr.dataset.date) > Number(state.period) * 864e5) ok = false;
      if (state.month && tr.dataset.month !== state.month) ok = false;
      tr.hidden = !ok;
      if (ok) shown++;
    });
    if (q) q.value = state.q;
    if (profile) profile.value = state.profile;
    pressed('.pill[data-period], .tile[data-period]', 'data-period', state.month ? '' : state.period);
    pressed('.bar[data-month]', 'data-month', state.month);
    if (count) {
      var label = shown + ' lead' + (shown > 1 ? 's' : '') + (shown !== rows.length ? ' sur ' + rows.length : '');
      if (state.month) {
        var bar = document.querySelector('.bar[data-month="' + state.month + '"]');
        if (bar) label += ' · ' + bar.getAttribute('aria-label').split(' :')[0];
      }
      count.textContent = label;
    }
    if (none) none.hidden = shown !== 0;
    store.set('filters', JSON.stringify(state));
  }

  function goToLeads() {
    var target = document.getElementById('leads');
    if (target) target.scrollIntoView();
  }

  if (q) q.addEventListener('input', function () { state.q = q.value; apply(); });
  if (profile) profile.addEventListener('change', function () { state.profile = profile.value; apply(); });

  document.addEventListener('click', function (event) {
    var el = event.target.closest('[data-panel], [data-period], [data-month], [data-jump], [data-open], #reset, tr[data-id], tr[data-conv]');
    if (!el) return;
    if (el.dataset.panel) { openPanel(el); return; }
    if (el.dataset.conv) { if (!event.target.closest('a, button')) openPanel(el.querySelector('[data-panel]')); return; }
    if (el.id === 'reset') { state = { q: '', profile: '', period: 'all', month: '' }; apply(); q && q.focus(); return; }
    if (el.dataset.open) { openLead(el.dataset.open, el); return; }
    if (el.dataset.jump) { document.getElementById(el.dataset.jump).scrollIntoView(); return; }
    if (el.dataset.period) {
      state.period = el.dataset.period; state.month = '';
      apply();
      if (el.classList.contains('tile')) goToLeads();
      return;
    }
    if (el.dataset.month) {
      state.month = state.month === el.dataset.month ? '' : el.dataset.month;
      state.period = 'all';
      apply();
      return;
    }
    // Clic ailleurs sur une ligne : même effet que le bouton du nom, sans
    // détourner les liens tel: et mailto:.
    if (el.tagName === 'TR' && !event.target.closest('a, button')) {
      var trigger = el.querySelector('[data-open]');
      if (trigger) openLead(el.dataset.id, trigger);
    }
  });

  // ── Section courante dans la navigation ──
  var links = Array.prototype.slice.call(document.querySelectorAll('.sections a'));
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + e.target.id)); });
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    document.querySelectorAll('main section[id]').forEach(function (s) { io.observe(s); });
  }

  // ── Fiche détaillée ──
  var dialog = document.getElementById('sheet');
  var sub = document.getElementById('sheet-sub');
  var body = document.getElementById('sheet-body');
  var title = document.getElementById('sheet-title');
  var returnFocus = null;

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }

  function facts(pairs) {
    var dl = h('dl', { class: 'facts' });
    pairs.forEach(function (p) {
      if (p[1] === undefined || p[1] === null || p[1] === '') return;
      dl.appendChild(h('dt', { text: p[0] }));
      dl.appendChild(h('dd', { text: String(p[1]) }));
    });
    return dl;
  }

  var fmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Paris' });
  function when(iso) { var d = new Date(iso); return isNaN(d) ? iso : fmt.format(d); }
  function pretty(k) { k = String(k || '').replace(/_/g, ' ').trim(); return k ? k.charAt(0).toUpperCase() + k.slice(1) : ''; }

  function render(data) {
    var s = data.sheet || {};
    var m = data.meta;
    var name = s.name || (m && (m.answers.find(function (a) { return a.type === 'FULL_NAME'; }) || {}).answer) || 'Sans nom';
    var phone = s.phone || (m && (m.answers.find(function (a) { return a.type === 'PHONE'; }) || {}).answer) || '';
    var email = s.email || (m && (m.answers.find(function (a) { return a.type === 'EMAIL'; }) || {}).answer) || '';
    title.textContent = name;
    body.textContent = '';

    var actions = [];
    if (phone) {
      actions.push(h('a', { class: 'primary', href: 'tel:' + phone, text: 'Appeler ' + phone }));
      actions.push(h('a', { href: 'https://wa.me/' + phone.replace(/\\D/g, ''), target: '_blank', rel: 'noopener', text: 'WhatsApp' }));
    }
    if (email) actions.push(h('a', { href: 'mailto:' + email, text: 'Écrire un e-mail' }));
    var copy = h('button', { type: 'button', text: 'Copier les coordonnées' });
    copy.addEventListener('click', function () {
      var text = [name, phone, email, s.company].filter(Boolean).join(' · ');
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
        function () { copy.textContent = 'Copié ✓'; },
        function () { copy.textContent = 'Copie impossible'; }
      );
    });
    actions.push(copy);
    body.appendChild(h('h3', { text: 'Contacter' }));
    body.appendChild(h('div', { class: 'quick' }, actions));

    if (m && m.answers.length) {
      body.appendChild(h('h3', { text: 'Réponses au formulaire' }));
      body.appendChild(facts(m.answers.map(function (a) { return [a.question, a.answer]; })));
    } else if (data.sheet) {
      body.appendChild(h('h3', { text: 'Informations enregistrées' }));
      body.appendChild(facts([['Nom', s.name], ['Téléphone', s.phone], ['E-mail', s.email], ['Entreprise', s.company], ['Profil', pretty(s.profile)]]));
    }

    body.appendChild(h('h3', { text: 'Origine' }));
    var platform = m && m.platform ? ({ fb: 'Facebook', ig: 'Instagram' }[m.platform] || m.platform) : '';
    body.appendChild(facts([
      ['Reçu le', when((m && m.createdTime) || s.date)],
      ['Formulaire', m && m.form ? (m.form.name || m.form.id) : ''],
      ['Plateforme', platform],
      ['Acquisition', m && m.isOrganic !== undefined ? (m.isOrganic ? 'Organique' : 'Publicité') : ''],
      ['Campagne', m && m.campaign],
      ['Ensemble de publicités', m && m.adset],
      ['Publicité', m && m.ad],
      ['Identifiant du lead', data.id],
      ['Présent dans le Sheet', data.sheet ? 'Oui' : 'Non']
    ]));

    if (!m) {
      body.appendChild(h('p', { class: 'notice', text: 'Détail Meta indisponible' + (data.metaError ? ' : ' + data.metaError : '') + '. Meta ne conserve les leads que 90 jours ; les informations ci-dessus proviennent du Sheet.' }));
    }
  }

  function openLead(id, trigger) {
    returnFocus = trigger || document.activeElement;
    sub.textContent = 'Fiche lead';
    title.textContent = 'Chargement…';
    body.textContent = '';
    body.appendChild(h('p', { class: 'loading', text: 'Lecture du lead chez Meta et dans le Sheet…' }));
    if (!dialog.open) dialog.showModal();
    fetch('/api/leads/' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || 'Lecture impossible');
        render(res.j);
      })
      .catch(function (err) {
        title.textContent = 'Lead ' + id;
        body.textContent = '';
        body.appendChild(h('p', { class: 'notice', text: err.message }));
      });
  }

${businessScript}
  document.getElementById('sheet-close').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', function () { if (returnFocus && returnFocus.focus) returnFocus.focus(); });

  // ── Actualisation automatique ──
  // Jamais pendant une lecture de fiche ou une saisie (WCAG 2.2.1) ; désactivable.
  var auto = document.getElementById('auto');
  auto.checked = store.get('auto') !== 'off';
  auto.addEventListener('change', function () { store.set('auto', auto.checked ? 'on' : 'off'); });
  setInterval(function () {
    var typing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement !== auto;
    if (!auto.checked || dialog.open || typing || document.hidden) return;
    store.set('scroll', String(window.scrollY));
    location.replace(location.pathname);
  }, REFRESH);

  // Temps réel : le serveur signale chaque nouveauté reçue de Meta (lead,
  // publication, commentaire, message). Cette vérification ne coûte aucun
  // appel à Meta ; la page ne se recharge que si quelque chose a changé.
  var version = ${JSON.stringify(String(version))};
  setInterval(function () {
    if (!auto.checked || document.hidden) return;
    fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || String(j.version) === version) return;
        var typing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement !== auto;
        if (dialog.open || typing) return;
        store.set('scroll', String(window.scrollY));
        location.replace(location.pathname);
      })
      .catch(function () {});
  }, 10000);

  var y = Number(store.get('scroll'));
  if (y) { window.scrollTo(0, y); store.set('scroll', ''); }
  apply();
})();
</script>
</body>
</html>`;
}
