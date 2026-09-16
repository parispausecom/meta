/**
 * Sections « Meta Business Suite » du tableau de bord : audience, Instagram,
 * Facebook, mentions et messagerie. Chaque élément ouvre un panneau de
 * détail ; les données du panneau voyagent dans des attributs `data-*` et
 * sont insérées côté client par `textContent`.
 */
import type { Business, Part, Series } from './lib/business.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

const TZ = 'Europe/Paris';
const nf = new Intl.NumberFormat('fr-FR');
const num = (n?: number) => (typeof n === 'number' ? nf.format(n) : '—');
const day = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString('fr-FR', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const dayTime = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString('fr-FR', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';
const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const unavailable = (p: Part<unknown>, what: string) =>
  p.ok ? '' : `<p class="empty">${esc(what)} indisponible : ${esc(p.error)}</p>`;

/** Mini-courbe SVG, décorative : la valeur totale est donnée en texte. */
function spark(values: number[]): string {
  if (values.length < 2) return '';
  const max = Math.max(1, ...values);
  const w = 200;
  const h = 44;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}

function audience(b: Business): string {
  const ig = b.igInsights.ok ? b.igInsights.data : [];
  const page: Series[] = b.pageInsights.ok ? b.pageInsights.data : [];
  const igTiles = ig
    .map((m) => `<li><div class="tile"><span class="tile-label">${esc(m.title)}</span><span class="tile-value">${num(m.value)}</span><span class="tile-note">Instagram · 28 jours</span></div></li>`)
    .join('');
  const pageTiles = page
    .map(
      (m) => `<li><div class="tile tile-spark"><span class="tile-label">${esc(m.title)}</span><span class="tile-value">${num(m.total)}</span>${spark(m.values)}<span class="tile-note">Facebook · 28 jours</span></div></li>`
    )
    .join('');
  return `<section id="audience" aria-labelledby="h-audience">
    <div class="section-head">
      <h2 id="h-audience">Audience</h2>
      <p class="section-note">28 derniers jours · source Meta Business Suite</p>
    </div>
    ${igTiles || pageTiles ? `<ul class="tiles">${igTiles}${pageTiles}</ul>` : ''}
    ${unavailable(b.igInsights, 'Statistiques Instagram')}${unavailable(b.pageInsights, 'Statistiques Facebook')}
  </section>`;
}

function instagram(b: Business): string {
  if (!b.instagram.ok) {
    return `<section id="instagram" aria-labelledby="h-instagram"><div class="section-head"><h2 id="h-instagram">Instagram</h2></div>${unavailable(b.instagram, 'Compte Instagram')}</section>`;
  }
  const p = b.instagram.data;
  const media = p.media?.data ?? [];
  const grid = media
    .map((m) => {
      const img = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url;
      const type = m.media_type === 'VIDEO' ? 'Vidéo' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carrousel' : 'Photo';
      const label = `${type} du ${day(m.timestamp)} : ${num(m.like_count)} j’aime, ${num(m.comments_count)} commentaires`;
      return `<li><button type="button" class="post" data-panel="instagram" data-id="${esc(m.id)}"
          data-title="${esc(type)} du ${esc(day(m.timestamp))}" data-caption="${esc(m.caption ?? '')}" data-img="${esc(img ?? '')}"
          data-link="${esc(m.permalink ?? '')}" data-stats="${esc(`${num(m.like_count)} j’aime · ${num(m.comments_count)} commentaires`)}"
          aria-haspopup="dialog" aria-label="${esc(label)}">
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="noimg" aria-hidden="true"></span>'}
        <span class="post-meta" aria-hidden="true"><span class="badge-type">${esc(type)}</span><span>♥ ${num(m.like_count)}</span><span>💬 ${num(m.comments_count)}</span></span>
        <span class="post-caption" aria-hidden="true">${esc(clip(m.caption, 90))}</span>
      </button></li>`;
    })
    .join('');

  const mentions = b.mentions.ok ? b.mentions.data : [];
  const mentionRows = mentions
    .map(
      (m) => `<tr>
        <td data-label="Date" class="c-date"><time datetime="${esc(m.timestamp ?? '')}">${day(m.timestamp)}</time></td>
        <th scope="row" data-label="Compte">@${esc(m.username ?? '—')}</th>
        <td data-label="Publication">${esc(clip(m.caption, 140) || '—')}</td>
        <td data-label="Lien">${m.permalink ? `<a href="${esc(m.permalink)}" target="_blank" rel="noopener">Voir<span class="sr-only"> la publication de @${esc(m.username ?? '')} (nouvel onglet)</span></a>` : '—'}</td>
      </tr>`
    )
    .join('');

  return `<section id="instagram" aria-labelledby="h-instagram">
    <div class="section-head">
      <h2 id="h-instagram">Instagram</h2>
      <p class="section-note">Cliquer sur une publication pour lire ses commentaires</p>
    </div>
    <div class="card profile">
      ${p.profile_picture_url ? `<img src="${esc(p.profile_picture_url)}" alt="" width="72" height="72" referrerpolicy="no-referrer">` : ''}
      <div class="profile-text">
        <p class="profile-name"><a href="https://www.instagram.com/${esc(p.username ?? '')}/" target="_blank" rel="noopener">@${esc(p.username)}<span class="sr-only"> sur Instagram (nouvel onglet)</span></a></p>
        <p class="muted">${esc(clip(p.biography, 160))}</p>
      </div>
      <dl class="profile-stats">
        <div><dt>Abonnés</dt><dd>${num(p.followers_count)}</dd></div>
        <div><dt>Abonnements</dt><dd>${num(p.follows_count)}</dd></div>
        <div><dt>Publications</dt><dd>${num(p.media_count)}</dd></div>
      </dl>
    </div>
    <h3 class="sub">Dernières publications</h3>
    <ul class="posts">${grid || '<li class="empty">Aucune publication.</li>'}</ul>
    <h3 class="sub">Mentions et identifications (${mentions.length})</h3>
    <div class="card table-wrap">${
      mentionRows
        ? `<table class="stack"><caption class="sr-only">Publications où le compte est identifié</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Compte</th><th scope="col">Publication</th><th scope="col">Lien</th></tr></thead>
          <tbody>${mentionRows}</tbody></table>`
        : unavailable(b.mentions, 'Mentions') || '<p class="empty">Aucune mention récente.</p>'
    }</div>
  </section>`;
}

function facebook(b: Business): string {
  if (!b.page.ok) {
    return `<section id="facebook" aria-labelledby="h-facebook"><div class="section-head"><h2 id="h-facebook">Facebook</h2></div>${unavailable(b.page, 'Page Facebook')}</section>`;
  }
  const p = b.page.data;
  const posts = p.posts?.data ?? [];
  const grid = posts
    .map((m) => {
      const r = m.reactions?.summary?.total_count ?? 0;
      const c = m.comments?.summary?.total_count ?? 0;
      const sh = m.shares?.count ?? 0;
      const stats = `${num(r)} réactions · ${num(c)} commentaires · ${num(sh)} partages`;
      return `<li><button type="button" class="post" data-panel="facebook" data-id="${esc(m.id)}"
          data-title="Publication du ${esc(day(m.created_time))}" data-caption="${esc(m.message ?? '')}" data-img="${esc(m.full_picture ?? '')}"
          data-link="${esc(m.permalink_url ?? '')}" data-stats="${esc(stats)}" aria-haspopup="dialog"
          aria-label="${esc(`Publication du ${day(m.created_time)} : ${stats}`)}">
        ${m.full_picture ? `<img src="${esc(m.full_picture)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="noimg text" aria-hidden="true">${esc(clip(m.message, 120))}</span>`}
        <span class="post-meta" aria-hidden="true"><span>👍 ${num(r)}</span><span>💬 ${num(c)}</span><span>↗ ${num(sh)}</span></span>
        <span class="post-caption" aria-hidden="true">${esc(clip(m.message, 90))}</span>
      </button></li>`;
    })
    .join('');

  const ratings = b.ratings.ok ? b.ratings.data : [];
  const reviews = ratings
    .map(
      (r) => `<li class="card review">
        <p class="review-head"><strong>${esc(r.reviewer?.name ?? 'Utilisateur Facebook')}</strong>
        <span class="status ${r.recommendation_type === 'negative' ? 'status-ko' : 'status-ok'}">${r.recommendation_type === 'negative' ? 'Ne recommande pas' : 'Recommande'}</span>
        <time class="muted" datetime="${esc(r.created_time ?? '')}">${day(r.created_time)}</time></p>
        <details><summary>Lire l’avis</summary><p class="review-text">${esc(r.review_text ?? 'Sans commentaire.')}</p></details>
      </li>`
    )
    .join('');

  return `<section id="facebook" aria-labelledby="h-facebook">
    <div class="section-head">
      <h2 id="h-facebook">Facebook</h2>
      <p class="section-note">${num(p.followers_count)} abonnés · ${num(p.fan_count)} mentions J’aime</p>
    </div>
    <ul class="posts">${grid || '<li class="empty">Aucune publication.</li>'}</ul>
    <h3 class="sub">Avis (${ratings.length})</h3>
    ${reviews ? `<ul class="reviews">${reviews}</ul>` : unavailable(b.ratings, 'Avis') || '<p class="empty">Aucun avis.</p>'}
  </section>`;
}

function messages(b: Business): string {
  const convs = b.conversations.ok ? b.conversations.data : [];
  const pageId = process.env.META_PAGE_ID;
  const unread = convs.reduce((n, c) => n + (c.unread_count ? 1 : 0), 0);
  const rows = convs
    .map((c) => {
      const who = (c.participants?.data ?? []).find((x) => x.id !== pageId)?.name ?? 'Contact';
      return `<tr data-conv="${esc(c.id)}">
        <td data-label="Dernier échange" class="c-date"><time datetime="${esc(c.updated_time ?? '')}">${dayTime(c.updated_time)}</time></td>
        <th scope="row" data-label="Contact"><button type="button" class="link" data-panel="thread" data-id="${esc(c.id)}" data-title="${esc(who)}" aria-haspopup="dialog">${esc(who)}</button></th>
        <td data-label="Aperçu">${esc(clip(c.snippet, 110) || '—')}</td>
        <td data-label="Messages">${num(c.message_count)}</td>
        <td data-label="État">${c.unread_count ? `<span class="status status-ko">${c.unread_count} non lu${c.unread_count > 1 ? 's' : ''}</span>` : '<span class="status status-neutral">Lu</span>'}</td>
      </tr>`;
    })
    .join('');
  return `<section id="messages" aria-labelledby="h-messages">
    <div class="section-head">
      <h2 id="h-messages">Messages Messenger</h2>
      <p class="section-note">${convs.length} conversation(s)${unread ? ` · ${unread} non lue(s)` : ''} · <a href="https://business.facebook.com/latest/inbox" target="_blank" rel="noopener">Répondre dans Business Suite<span class="sr-only"> (nouvel onglet)</span></a></p>
    </div>
    <div class="card table-wrap">${
      rows
        ? `<table class="stack"><caption class="sr-only">Conversations Messenger de la Page</caption>
          <thead><tr><th scope="col">Dernier échange</th><th scope="col">Contact</th><th scope="col">Aperçu</th><th scope="col">Messages</th><th scope="col">État</th></tr></thead>
          <tbody>${rows}</tbody></table>`
        : unavailable(b.conversations, 'Messagerie') || '<p class="empty">Aucune conversation.</p>'
    }</div>
  </section>`;
}

export const businessNav = `
    <li><a href="#audience">Audience</a></li>
    <li><a href="#instagram">Instagram</a></li>
    <li><a href="#facebook">Facebook</a></li>
    <li><a href="#messages">Messages</a></li>`;

export function renderBusiness(b: Business): string {
  return [audience(b), instagram(b), facebook(b), messages(b)].join('\n');
}

export const businessCss = `
h3.sub { font: 600 12px var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 26px 0 12px; }
.tile-spark .spark { width: 100%; height: 36px; color: var(--accent); margin: 4px 0; }
.profile { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; padding: 18px; }
.profile img { border-radius: 50%; object-fit: cover; }
.profile-text { flex: 1; min-width: 220px; }
.profile-text p { margin: 0; }
.profile-name { font: 600 20px var(--serif); }
.profile-name a { text-decoration: none; }
.profile-stats { display: flex; gap: 24px; margin: 0; }
.profile-stats div { text-align: center; }
.profile-stats dt { color: var(--muted); font-size: 12.5px; }
.profile-stats dd { margin: 0; font: 600 22px var(--serif); font-variant-numeric: tabular-nums; }
.posts { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
.post { width: 100%; height: 100%; display: flex; flex-direction: column; padding: 0; text-align: left; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; cursor: pointer; font: inherit; box-shadow: var(--shadow); transition: transform .15s, border-color .15s; }
.post:hover { transform: translateY(-2px); border-color: var(--accent); }
.post img, .post .noimg { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: var(--line); }
.post .noimg.text { padding: 14px; font-size: 13px; color: var(--muted); overflow: hidden; }
.post-meta { display: flex; gap: 10px; align-items: center; padding: 10px 12px 2px; font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.badge-type { margin-right: auto; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--ink); }
.post-caption { padding: 0 12px 12px; font-size: 13px; color: var(--muted); line-height: 1.4; }
.reviews { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.review { padding: 14px 18px; }
.review-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 0 0 6px; }
.review details summary { cursor: pointer; color: var(--accent); font-weight: 600; min-height: 32px; display: inline-flex; align-items: center; }
.review-text { white-space: pre-line; margin: 8px 0 0; color: var(--muted); max-height: 320px; overflow: auto; }
.media { width: 100%; max-height: 360px; object-fit: contain; background: #000; border-radius: 12px; display: block; }
.caption { white-space: pre-line; margin: 12px 0 0; }
.thread { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.bubble { max-width: 85%; padding: 10px 14px; border-radius: 16px; background: var(--paper); border: 1px solid var(--line); }
.bubble.mine { align-self: flex-end; background: var(--ink); color: var(--paper); border-color: var(--ink); }
.bubble small { display: block; opacity: .75; font-size: 11.5px; margin-top: 4px; }
.comments { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.comments li { padding: 10px 14px; border: 1px solid var(--line); border-radius: 12px; }
.comments small { color: var(--muted); }
@media (max-width: 760px) { .posts { grid-template-columns: repeat(2, 1fr); } .profile-stats { width: 100%; justify-content: space-around; } }
`;

/** Script client : panneaux de publication et de conversation. */
export const businessScript = `
  function openPanel(el) {
    returnFocus = el;
    var kind = el.dataset.panel;
    sub.textContent = kind === 'thread' ? 'Conversation Messenger' : kind === 'instagram' ? 'Publication Instagram' : 'Publication Facebook';
    title.textContent = el.dataset.title || '';
    body.textContent = '';
    if (kind !== 'thread') {
      if (el.dataset.img) {
        var img = h('img', { class: 'media', src: el.dataset.img, alt: '', referrerpolicy: 'no-referrer' });
        body.appendChild(img);
      }
      body.appendChild(h('p', { class: 'muted', text: el.dataset.stats || '' }));
      if (el.dataset.caption) body.appendChild(h('p', { class: 'caption', text: el.dataset.caption }));
      if (el.dataset.link) {
        body.appendChild(h('div', { class: 'quick' }, [h('a', { class: 'primary', href: el.dataset.link, target: '_blank', rel: 'noopener', text: 'Ouvrir sur ' + (kind === 'instagram' ? 'Instagram' : 'Facebook') })]));
      }
      body.appendChild(h('h3', { text: 'Commentaires' }));
    }
    var loading = h('p', { class: 'loading', text: 'Chargement depuis Meta…' });
    body.appendChild(loading);
    if (!dialog.open) dialog.showModal();

    var url = kind === 'thread' ? '/api/conversations/' + encodeURIComponent(el.dataset.id)
      : '/api/comments/' + kind + '/' + encodeURIComponent(el.dataset.id);
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Lecture impossible'); return j; }); })
      .then(function (j) {
        loading.remove();
        if (kind === 'thread') {
          var list = h('ol', { class: 'thread', 'aria-label': 'Messages, du plus ancien au plus récent' });
          j.messages.forEach(function (m) {
            var mine = m.from && m.from.id === j.pageId;
            list.appendChild(h('li', { class: 'bubble' + (mine ? ' mine' : '') }, [
              h('span', { text: m.message || '(pièce jointe)' }),
              h('small', { text: (mine ? 'Pause-Com' : (m.from && m.from.name) || 'Contact') + ' · ' + when(m.created_time) })
            ]));
          });
          body.appendChild(j.messages.length ? list : h('p', { class: 'muted', text: 'Aucun message lisible.' }));
          body.appendChild(h('div', { class: 'quick' }, [h('a', { class: 'primary', href: 'https://business.facebook.com/latest/inbox', target: '_blank', rel: 'noopener', text: 'Répondre dans Business Suite' })]));
          return;
        }
        if (!j.comments.length) { body.appendChild(h('p', { class: 'muted', text: 'Aucun commentaire.' })); return; }
        var ul = h('ul', { class: 'comments' });
        j.comments.forEach(function (c) {
          ul.appendChild(h('li', {}, [
            h('strong', { text: c.author }),
            h('p', { text: c.text, style: 'margin:4px 0' }),
            h('small', { text: when(c.created_time) + (c.likes ? ' · ♥ ' + c.likes : '') })
          ]));
        });
        body.appendChild(ul);
      })
      .catch(function (err) { loading.remove(); body.appendChild(h('p', { class: 'notice', text: err.message })); });
  }
`;
