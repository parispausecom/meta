/**
 * Tableau de bord de production : rendu HTML de l'état collecté par
 * `lib/status.ts`. Aucune dépendance, aucun appel externe côté navigateur.
 */
import type { Status, Block } from './lib/status.js';
import type { LeadRow } from './types.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

// Render tourne en UTC : les dates sont affichées à l'heure de Paris.
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

const duration = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} j ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

function checks(s: Status): Check[] {
  const err = (b: Block<unknown>) => (b.ok ? '' : b.error);
  return [
    {
      label: 'Serveur en ligne',
      ok: true,
      detail: `démarré ${dateTime(s.server.startedAt)} · actif depuis ${duration(s.server.uptimeSeconds)}`,
    },
    {
      label: 'Jeton Meta',
      ok: s.token.ok && s.token.data.valid,
      detail: s.token.ok
        ? `${esc(s.token.data.type ?? '?')} · ${s.token.data.valid ? 'valide' : 'INVALIDE'} · ${s.token.data.neverExpires ? "n'expire pas" : `expire le ${dateTime(s.token.data.expiresAt)}`}`
        : esc(err(s.token)),
    },
    {
      label: 'Webhook déclaré chez Meta',
      ok: s.subscription.ok && s.subscription.data.active && s.subscription.data.fields.includes('leadgen'),
      detail: s.subscription.ok
        ? `${s.subscription.data.active ? 'actif' : 'INACTIF'} → ${esc(s.subscription.data.callbackUrl ?? 'aucune URL')} · champs : ${esc(s.subscription.data.fields.join(', ') || 'aucun')}`
        : esc(err(s.subscription)),
    },
    {
      label: 'Page abonnée aux leads',
      ok: s.subscription.ok && s.subscription.data.pageSubscribed,
      detail: s.subscription.ok
        ? s.subscription.data.pageSubscribed ? 'Pause-Com envoie ses leads à l’app' : 'la Page n’est PAS abonnée au champ leadgen'
        : esc(err(s.subscription)),
    },
    {
      label: 'Google Sheet',
      ok: s.sheet.ok,
      detail: s.sheet.ok ? `« ${esc(s.sheet.data.title ?? '?')} » · ${s.sheet.data.total} leads` : esc(err(s.sheet)),
    },
    {
      label: 'Synchronisation Meta → Sheet',
      ok: s.sync.ok && s.sync.data.missing.length === 0,
      detail: s.sync.ok
        ? s.sync.data.missing.length === 0
          ? 'tous les leads disponibles chez Meta sont dans le Sheet'
          : `${s.sync.data.missing.length} lead(s) chez Meta absent(s) du Sheet`
        : esc(err(s.sync)),
    },
  ];
}

/** Leads par mois sur les 12 derniers mois, à partir du Sheet. */
function monthly(rows: LeadRow[]): Array<{ label: string; count: number }> {
  const now = new Date();
  const buckets: Array<{ key: string; label: string; count: number }> = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      key: `${d.getFullYear()}-${d.getMonth()}`,
      label: d.toLocaleDateString('fr-FR', { month: 'short' }),
      count: 0,
    });
  }
  for (const r of rows) {
    const d = new Date(r[0]);
    if (Number.isNaN(+d)) continue;
    const b = buckets.find((x) => x.key === `${d.getFullYear()}-${d.getMonth()}`);
    if (b) b.count++;
  }
  return buckets;
}

export function renderDashboard(s: Status, refreshSeconds: number): string {
  const list = checks(s);
  const rows = s.sheet.ok ? [...s.sheet.data.rows].sort((a, b) => +new Date(b[0]) - +new Date(a[0])) : [];
  const count = (days: number) => rows.filter((r) => Date.now() - +new Date(r[0]) < days * 86400_000).length;
  const last = rows[0];
  const months = monthly(rows);
  const max = Math.max(1, ...months.map((m) => m.count));
  const n = s.server.notifications;

  const tiles = [
    ['Leads dans le Sheet', s.sheet.ok ? String(s.sheet.data.total) : '—', 'base complète'],
    ['7 derniers jours', String(count(7)), 'nouveaux leads'],
    ['30 derniers jours', String(count(30)), 'nouveaux leads'],
    ['Dernier lead', last ? since(last[0]) : '—', last ? `${last[1]} · ${dateTime(last[0])}` : ''],
    ['Disponibles chez Meta', s.meta.ok ? String(s.meta.data.retrievable) : '—', 'Meta purge après 90 jours'],
    ['Formulaires actifs', s.meta.ok ? `${s.meta.data.activeForms}/${s.meta.data.forms}` : '—', 'Instant Forms'],
    ['Notifications reçues', String(n.reçues), `${n.écrites} écrites · ${n.échecs} échec(s) depuis le démarrage`],
  ];

  const activityRows = s.server.activity
    .map(
      (a) => `<tr>
        <td class="date">${dateTime(a.at)}</td>
        <td><span class="tag ${a.status === 'échec' ? 'ko' : a.status === 'écrit' ? 'ok' : 'mid'}">${esc(a.status)}</span></td>
        <td class="nom">${esc(a.name ?? '—')}</td>
        <td class="idc">${esc(a.leadId)}</td>
        <td class="err">${esc(a.error ?? '')}</td>
      </tr>`
    )
    .join('');

  const missingRows = s.sync.ok
    ? s.sync.data.missing
        .map((m) => `<tr><td class="date">${dateTime(m.createdTime)}</td><td class="idc">${esc(m.id)}</td><td>${esc(m.form ?? '')}</td></tr>`)
        .join('')
    : '';

  const leadRows = rows
    .slice(0, 100)
    .map(
      (r, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="date">${dateTime(r[0])}</td>
        <td class="nom">${esc(r[1] || '—')}</td>
        <td>${r[3] ? `<a href="tel:${esc(r[3])}">${esc(r[3])}</a>` : '—'}</td>
        <td>${r[2] ? `<a href="mailto:${esc(r[2])}">${esc(r[2])}</a>` : '—'}</td>
        <td>${esc(r[4] || '—')}</td>
        <td><span class="tag mid">${esc(r[5] || '—')}</span></td>
      </tr>`
    )
    .join('');

  const sheetUrl = process.env.GOOGLE_SPREADSHEET_ID
    ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(process.env.GOOGLE_SPREADSHEET_ID)}/edit`
    : '';

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Leads Pause-Com — production</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--fg:#1a1d21;--dim:#6b7280;--faint:#9099a5;--line:#eef0f2;--th:#fafbfc;--blue:#3b82f6;--ok:#16a34a;--ko:#dc2626;--mid:#6b7280}
@media(prefers-color-scheme:dark){:root{--bg:#0e1014;--card:#171a20;--fg:#e6e8eb;--dim:#9aa3ae;--faint:#7b8490;--line:#22262e;--th:#1c2027;--ok:#4ade80;--ko:#f87171}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.wrap{max-width:1200px;margin:0 auto;padding:24px 16px 60px}
a{color:var(--blue);text-decoration:none}
header{display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:var(--card);border-radius:16px;padding:20px;box-shadow:0 1px 3px #0000000f}
h1{font-size:22px;margin:0;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:13px;margin-top:2px}
.pill{padding:4px 12px;border-radius:20px;font-weight:700;font-size:12.5px;white-space:nowrap}
.pill.ok{background:#16a34a1a;color:var(--ok)}.pill.ko{background:#dc26261a;color:var(--ko)}
.actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.btn{border:1px solid var(--line);background:var(--card);color:var(--fg);padding:8px 14px;border-radius:10px;font-weight:600;font-size:13px;cursor:pointer}
.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}
h2{font-size:12px;margin:28px 0 12px;color:var(--dim);text-transform:uppercase;letter-spacing:.07em}
.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}
.check{background:var(--card);border-radius:12px;padding:14px 16px;box-shadow:0 1px 3px #0000000f;display:flex;gap:12px;align-items:flex-start}
.ico{width:22px;height:22px;border-radius:50%;flex:none;display:grid;place-items:center;color:#fff;font-weight:700;font-size:13px;margin-top:1px}
.ico.ok{background:var(--ok)}.ico.ko{background:var(--ko)}
.check b{display:block}.check span{color:var(--dim);font-size:12.5px;word-break:break-word}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.stat{background:var(--card);border-radius:12px;padding:14px 16px;box-shadow:0 1px 3px #0000000f;min-width:0}
.stat span{color:var(--dim);font-size:12px;display:block}
.stat b{font-size:24px;display:block;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin:2px 0}
.stat i{color:var(--faint);font-size:11.5px;font-style:normal;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card{background:var(--card);border-radius:14px;box-shadow:0 1px 3px #0000000f;overflow:hidden}
.chart{display:flex;gap:6px;align-items:flex-end;height:160px;padding:18px 16px 10px}
.col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0}
.bar{width:70%;max-width:36px;background:var(--blue);border-radius:4px 4px 0 0;min-height:2px}
.bar.zero{background:var(--line)}
.cv{font-size:12px;font-weight:600;margin-bottom:3px;font-variant-numeric:tabular-nums}
.cl{font-size:10.5px;color:var(--faint);margin-top:5px}
.tblwrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:760px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);padding:10px 14px;border-bottom:1px solid var(--line);background:var(--th);white-space:nowrap}
td{padding:9px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
.num{color:var(--faint);width:30px}.date{color:var(--dim);white-space:nowrap;font-variant-numeric:tabular-nums}
.nom{font-weight:600}.idc{color:var(--faint);font-size:11.5px;white-space:nowrap}.err{color:var(--ko);font-size:12px}
.tag{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11.5px;font-weight:600;white-space:nowrap}
.tag.ok{background:#16a34a1a;color:var(--ok)}.tag.ko{background:#dc26261a;color:var(--ko)}.tag.mid{background:#6b72801a;color:var(--dim)}
.empty{padding:18px;color:var(--faint)}
.note{color:var(--faint);font-size:12px;margin:8px 2px 0}
footer{margin-top:36px;color:var(--faint);font-size:12px}
code{background:#0000000f;padding:1px 5px;border-radius:4px;font-size:12px}
</style></head><body><div class="wrap">

<header>
  <div>
    <h1>Leads Pause-Com <span class="pill ${s.healthy ? 'ok' : 'ko'}">${s.healthy ? '● Automatisation opérationnelle' : '● Attention requise'}</span></h1>
    <div class="sub">Données lues en direct chez Meta et dans le Google Sheet · mis à jour <b id="age">${since(s.generatedAt)}</b> (${dateTime(s.generatedAt)})</div>
  </div>
  <div class="actions">
    ${sheetUrl ? `<a class="btn" href="${esc(sheetUrl)}" target="_blank" rel="noopener">Ouvrir le Sheet</a>` : ''}
    <a class="btn primary" href="?fresh=1">Actualiser maintenant</a>
  </div>
</header>

<h2>Santé de la chaîne Meta → serveur → Sheet</h2>
<div class="checks">${list
    .map((c) => `<div class="check"><div class="ico ${c.ok ? 'ok' : 'ko'}">${c.ok ? '✓' : '!'}</div><div><b>${esc(c.label)}</b><span>${c.detail}</span></div></div>`)
    .join('')}</div>

<h2>Chiffres clés</h2>
<div class="grid">${tiles
    .map(([l, v, x]) => `<div class="stat"><span>${esc(l)}</span><b>${esc(v)}</b><i title="${esc(x)}">${esc(x)}</i></div>`)
    .join('')}</div>

<h2>Leads par mois</h2>
<div class="card"><div class="chart">${months
    .map(
      (m) => `<div class="col"><div class="cv">${m.count || ''}</div><div class="bar${m.count ? '' : ' zero'}" style="height:${Math.round((m.count / max) * 100)}%"></div><div class="cl">${esc(m.label)}</div></div>`
    )
    .join('')}</div></div>

${
  s.sync.ok && s.sync.data.missing.length
    ? `<h2>Leads chez Meta absents du Sheet (${s.sync.data.missing.length})</h2>
<div class="card tblwrap"><table><thead><tr><th>Déposé</th><th>Identifiant</th><th>Formulaire</th></tr></thead><tbody>${missingRows}</tbody></table></div>
<p class="note">Pour les rattraper depuis un terminal : <code>npm run backfill</code></p>`
    : ''
}

<h2>Activité du webhook depuis le démarrage (${s.server.activity.length})</h2>
<div class="card tblwrap">${
    activityRows
      ? `<table><thead><tr><th>Reçu</th><th>Résultat</th><th>Nom</th><th>Identifiant</th><th>Erreur</th></tr></thead><tbody>${activityRows}</tbody></table>`
      : `<div class="empty">Aucune notification depuis le démarrage du serveur (${dateTime(s.server.startedAt)}). Le journal repart à zéro à chaque redémarrage ; le Sheet, lui, garde tout.</div>`
  }</div>

<h2>Derniers leads (${Math.min(rows.length, 100)} sur ${rows.length})</h2>
<div class="card tblwrap">${
    leadRows
      ? `<table><thead><tr><th>#</th><th>Date</th><th>Nom</th><th>Téléphone</th><th>E-mail</th><th>Entreprise</th><th>Profil</th></tr></thead><tbody>${leadRows}</tbody></table>`
      : `<div class="empty">${s.sheet.ok ? 'Aucun lead.' : esc(s.sheet.ok ? '' : s.sheet.error)}</div>`
  }</div>

<footer>Page réservée : elle contient des données personnelles. Rechargement automatique toutes les ${refreshSeconds} s. Données JSON : <code>/api/status</code></footer>
</div>
<script>
  const generated = ${JSON.stringify(s.generatedAt)};
  const age = document.getElementById('age');
  setInterval(() => {
    const sec = Math.round((Date.now() - new Date(generated)) / 1000);
    age.textContent = sec < 60 ? 'il y a ' + sec + ' s' : 'il y a ' + Math.round(sec / 60) + ' min';
  }, 1000);
  // Recharge sans ?fresh=1 : le cache serveur de 30 s protège les quotas.
  setTimeout(() => location.replace(location.pathname), ${refreshSeconds * 1000});
</script>
</body></html>`;
}
