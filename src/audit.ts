/**
 * Audit complet de ce que les jetons Meta permettent d'atteindre.
 *
 * Le script interroge une à une toutes les ressources que l'app pourrait
 * vouloir lire, note pour chacune si elle répond ou pourquoi elle refuse, puis
 * écrit un rapport HTML autonome et l'ouvre dans le navigateur.
 *
 * Rien n'est écrit côté Meta : toutes les sondes sont des GET.
 *
 *   npm run audit                 rapport + ouverture du navigateur
 *   npm run audit -- --no-open    rapport seul
 *   npm run audit -- --out=x.html chemin de sortie
 */
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { requireEnv, optionalEnv, runCli } from './lib/env.js';

const VERSION = optionalEnv('GRAPH_API_VERSION', 'v26.0');
const BASE = `https://graph.facebook.com/${VERSION}`;

const PAGE_TOKEN = requireEnv('META_PAGE_ACCESS_TOKEN');
const PAGE_ID = requireEnv('META_PAGE_ID');
const USER_TOKEN = process.env.META_USER_ACCESS_TOKEN ?? '';
const APP_ID = process.env.META_APP_ID ?? '';
const APP_SECRET = process.env.META_APP_SECRET ?? '';

const args = process.argv.slice(2);
const OPEN = !args.includes('--no-open');
const OUT = args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'audit-meta.html';

// ── Sondes ────────────────────────────────────────────────────────────────

type Which = 'page' | 'user';

interface Probe {
  section: string;
  label: string;
  /** Ce que la ressource apporte concrètement, en français. */
  purpose: string;
  /** Autorisation Meta qui la conditionne. */
  scope: string;
  path: string;
  params?: Record<string, string>;
  token?: Which;
  /** Résumé d'une réponse réussie, affiché avant le JSON brut. */
  summarize?: (data: any) => string;
}

interface Result extends Probe {
  ok: boolean;
  url: string;
  status: number;
  data?: unknown;
  error?: { message: string; code?: number; subcode?: number; type?: string };
  ms: number;
}

const count = (d: any) => `${d?.data?.length ?? 0} élément(s)`;
const named = (key: string) => (d: any) =>
  (d?.data ?? [])
    .slice(0, 5)
    .map((x: any) => x[key] ?? x.id)
    .join(' · ') || 'aucun';

const PROBES: Probe[] = [
  // ── Identité ────────────────────────────────────────────────────────────
  {
    section: 'Identité & jetons',
    label: 'Profil utilisateur',
    purpose: "Le compte Facebook propriétaire de l'app",
    scope: 'public_profile',
    path: 'me',
    params: { fields: 'id,name' },
    token: 'user',
    summarize: (d) => `${d.name} (${d.id})`,
  },
  {
    section: 'Identité & jetons',
    label: 'Pages administrées',
    purpose: 'Toutes les Pages sur lesquelles le compte a un rôle',
    scope: 'pages_show_list',
    path: 'me/accounts',
    params: { fields: 'id,name,category,tasks', limit: '100' },
    token: 'user',
    summarize: named('name'),
  },

  // ── Page Facebook ───────────────────────────────────────────────────────
  {
    section: 'Page Facebook',
    label: 'Fiche de la Page',
    purpose: 'Nom, catégorie, description, contacts, adresse, horaires',
    scope: 'pages_read_engagement',
    path: PAGE_ID,
    params: {
      fields:
        'id,name,username,about,description,category,category_list,link,website,phone,emails,' +
        'location,hours,fan_count,followers_count,rating_count,overall_star_rating,talking_about_count,' +
        'verification_status,is_published,picture{url},cover{source},single_line_address',
    },
    summarize: (d) => `${d.name} — ${d.fan_count ?? '?'} fans, ${d.followers_count ?? '?'} abonnés`,
  },
  {
    section: 'Page Facebook',
    label: 'Apps abonnées au webhook',
    purpose: "Vérifie que l'app reçoit bien le champ leadgen",
    scope: 'pages_manage_metadata',
    path: `${PAGE_ID}/subscribed_apps`,
    summarize: (d) =>
      (d?.data ?? [])
        .map((a: any) => `${a.name ?? a.id} → ${(a.subscribed_fields ?? []).join(', ')}`)
        .join(' | ') || 'aucune app abonnée',
  },
  {
    section: 'Page Facebook',
    label: 'Publications',
    purpose: 'Historique des posts de la Page avec leur portée sociale',
    scope: 'pages_read_engagement',
    path: `${PAGE_ID}/posts`,
    params: {
      fields: 'id,created_time,message,permalink_url,shares,likes.summary(true),comments.summary(true)',
      limit: '25',
    },
    summarize: count,
  },
  {
    section: 'Page Facebook',
    label: 'Fil complet (feed)',
    purpose: 'Posts de la Page et des visiteurs',
    scope: 'pages_read_user_content',
    path: `${PAGE_ID}/feed`,
    params: { fields: 'id,created_time,from,message,permalink_url', limit: '25' },
    summarize: count,
  },
  {
    section: 'Page Facebook',
    label: 'Avis et notes',
    purpose: 'Recommandations laissées par les visiteurs',
    scope: 'pages_read_user_content',
    path: `${PAGE_ID}/ratings`,
    params: { fields: 'created_time,rating,recommendation_type,review_text,reviewer', limit: '25' },
    summarize: count,
  },
  {
    section: 'Page Facebook',
    label: 'Statistiques de Page',
    purpose: 'Engagement, vues de la Page et nouveaux abonnés sur 28 jours',
    scope: 'read_insights',
    path: `${PAGE_ID}/insights`,
    params: {
      metric: 'page_post_engagements,page_views_total,page_daily_follows_unique',
      period: 'days_28',
    },
    summarize: named('name'),
  },
  {
    section: 'Page Facebook',
    label: 'Rôles sur la Page',
    purpose: 'Qui administre la Page',
    scope: 'pages_manage_metadata',
    path: `${PAGE_ID}/roles`,
    params: { limit: '50' },
    summarize: count,
  },

  // ── Messagerie ──────────────────────────────────────────────────────────
  {
    section: 'Messagerie',
    label: 'Conversations Messenger',
    purpose: 'Fils de discussion reçus sur la Page',
    scope: 'pages_messaging',
    path: `${PAGE_ID}/conversations`,
    params: {
      fields:
        'id,updated_time,message_count,unread_count,participants,snippet,messages.limit(1){message,created_time,from}',
      limit: '50',
    },
    summarize: count,
  },
  {
    section: 'Messagerie',
    label: 'Conversations Instagram',
    purpose: 'DM reçus sur le compte Instagram lié',
    scope: 'instagram_manage_messages',
    path: `${PAGE_ID}/conversations`,
    params: { platform: 'instagram', fields: 'id,updated_time,message_count', limit: '25' },
    summarize: count,
  },

  // ── Leads ───────────────────────────────────────────────────────────────
  {
    section: 'Leads (Instant Forms)',
    label: 'Formulaires de la Page',
    purpose: 'Tous les Instant Forms et leur compteur de leads',
    scope: 'leads_retrieval',
    path: `${PAGE_ID}/leadgen_forms`,
    params: { fields: 'id,name,status,leads_count,created_time,questions', limit: '200' },
    summarize: (d) => {
      const forms = d?.data ?? [];
      const leads = forms.reduce((n: number, f: any) => n + (f.leads_count ?? 0), 0);
      return `${forms.length} formulaire(s), ${leads} lead(s) annoncé(s)`;
    },
  },
  {
    section: 'Leads (Instant Forms)',
    label: 'Leads de la Page',
    purpose: 'Les leads eux-mêmes, tous formulaires confondus',
    scope: 'leads_retrieval',
    path: `${PAGE_ID}/leadgen_forms`,
    params: { fields: 'id,name,leads.limit(100){id,created_time,field_data}', limit: '200' },
    summarize: (d) => {
      const total = (d?.data ?? []).reduce(
        (n: number, f: any) => n + (f.leads?.data?.length ?? 0),
        0
      );
      return `${total} lead(s) réellement lisible(s) (Meta n'en conserve que 90 jours)`;
    },
  },

  // ── Instagram ───────────────────────────────────────────────────────────
  {
    section: 'Instagram',
    label: 'Compte professionnel lié',
    purpose: "L'identifiant Instagram rattaché à la Page",
    scope: 'instagram_basic',
    path: PAGE_ID,
    params: { fields: 'instagram_business_account{id,username,name}' },
    summarize: (d) =>
      d.instagram_business_account
        ? `@${d.instagram_business_account.username} (${d.instagram_business_account.id})`
        : 'aucun compte lié',
  },

  // ── Publicité ───────────────────────────────────────────────────────────
  {
    section: 'Publicité',
    label: 'Comptes publicitaires',
    purpose: 'Comptes Ads accessibles, leur devise et leur solde',
    scope: 'ads_management',
    path: 'me/adaccounts',
    params: {
      fields: 'id,account_id,name,account_status,currency,amount_spent,balance',
      limit: '50',
    },
    token: 'user',
    summarize: named('name'),
  },
  {
    section: 'Publicité',
    label: 'Publicités liées à la Page',
    purpose: 'Campagnes qui alimentent les formulaires de la Page',
    scope: 'pages_manage_ads',
    path: `${PAGE_ID}/ads_posts`,
    params: { fields: 'id,created_time,message', limit: '25' },
    summarize: count,
  },

  // ── Business ────────────────────────────────────────────────────────────
  {
    section: 'Business Manager',
    label: 'Business Managers',
    purpose: 'Organisations propriétaires des actifs (Pages, comptes Ads)',
    scope: 'business_management',
    path: 'me/businesses',
    params: { fields: 'id,name,verification_status', limit: '25' },
    token: 'user',
    summarize: named('name'),
  },
  {
    section: 'Business Manager',
    label: 'Catalogues produits',
    purpose: 'Catalogues e-commerce rattachés au business',
    scope: 'catalog_management',
    path: 'me/businesses',
    params: { fields: 'id,name,owned_product_catalogs{id,name,product_count}', limit: '25' },
    token: 'user',
    summarize: named('name'),
  },
];

/**
 * Sondes qui dépendent d'un identifiant découvert en cours de route : elles ne
 * peuvent pas figurer dans la liste statique ci-dessus.
 */
function instagramProbes(igId: string): Probe[] {
  return [
    {
      section: 'Instagram',
      label: 'Profil du compte',
      purpose: 'Abonnés, abonnements, bio, site, nombre de publications',
      scope: 'instagram_basic',
      path: igId,
      params: {
        fields:
          'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url',
      },
      summarize: (d) =>
        `@${d.username} — ${d.followers_count} abonnés, ${d.media_count} publications`,
    },
    {
      section: 'Instagram',
      label: 'Publications',
      purpose: 'Les posts avec likes, commentaires et permalien',
      scope: 'instagram_basic',
      path: `${igId}/media`,
      params: {
        fields:
          'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
        limit: '40',
      },
      summarize: count,
    },
    {
      section: 'Instagram',
      label: 'Commentaires reçus',
      purpose: 'Les commentaires sur les publications récentes',
      scope: 'instagram_manage_comments',
      path: `${igId}/media`,
      params: { fields: 'id,comments{id,text,username,timestamp}', limit: '10' },
      summarize: (d) => {
        const n = (d?.data ?? []).reduce(
          (t: number, m: any) => t + (m.comments?.data?.length ?? 0),
          0
        );
        return `${n} commentaire(s) sur les 10 dernières publications`;
      },
    },
    {
      section: 'Instagram',
      label: 'Statistiques du compte',
      purpose: 'Comptes touchés et visites du profil sur la journée',
      scope: 'instagram_manage_insights',
      path: `${igId}/insights`,
      params: {
        metric: 'reach,profile_views,accounts_engaged,total_interactions',
        period: 'day',
        metric_type: 'total_value',
      },
      summarize: named('name'),
    },
    {
      section: 'Instagram',
      label: 'Quota de publication',
      purpose: 'Publications restantes sur 24 h — atteste du droit de publier',
      scope: 'instagram_content_publish',
      path: `${igId}/content_publishing_limit`,
      params: { fields: 'config,quota_usage' },
      summarize: (d) =>
        `${d?.data?.[0]?.quota_usage ?? 0} / ${d?.data?.[0]?.config?.quota_total ?? '?'} publications utilisées`,
    },
    {
      section: 'Instagram',
      label: 'Mentions et identifications',
      purpose: 'Publications de tiers où le compte est identifié',
      scope: 'instagram_manage_comments',
      path: `${igId}/tags`,
      params: { fields: 'id,username,caption,permalink,timestamp', limit: '25' },
      summarize: count,
    },
  ];
}

function adAccountProbes(actId: string, name: string): Probe[] {
  return [
    {
      section: 'Publicité',
      label: `Campagnes — ${name}`,
      purpose: 'Campagnes du compte, leur objectif et leur statut',
      scope: 'ads_management',
      path: `${actId}/campaigns`,
      params: { fields: 'id,name,objective,status,effective_status,created_time', limit: '50' },
      token: 'user',
      summarize: named('name'),
    },
    {
      section: 'Publicité',
      label: `Performances — ${name}`,
      purpose: 'Dépense, impressions, clics et coût par lead sur 30 jours',
      scope: 'ads_management',
      path: `${actId}/insights`,
      params: {
        fields: 'spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type',
        date_preset: 'last_30d',
        level: 'account',
      },
      token: 'user',
      summarize: (d) => {
        const row = d?.data?.[0];
        return row ? `${row.spend} dépensés · ${row.impressions} impressions · ${row.clicks} clics` : 'aucune donnée sur 30 jours';
      },
    },
  ];
}

// ── Exécution ─────────────────────────────────────────────────────────────

async function run(probe: Probe): Promise<Result> {
  const token = probe.token === 'user' ? USER_TOKEN : PAGE_TOKEN;
  const url = new URL(`${BASE}/${probe.path}`);
  for (const [k, v] of Object.entries(probe.params ?? {})) url.searchParams.set(k, v);
  const shown = `${url.pathname}${url.search}`;

  if (!token) {
    return {
      ...probe,
      ok: false,
      url: shown,
      status: 0,
      ms: 0,
      error: { message: `Aucun jeton ${probe.token === 'user' ? 'utilisateur' : 'de Page'} dans .env` },
    };
  }

  url.searchParams.set('access_token', token);
  const started = Date.now();
  try {
    const res = await fetch(url);
    const body: any = await res.json();
    const ms = Date.now() - started;
    if (!res.ok || body.error) {
      return {
        ...probe,
        ok: false,
        url: shown,
        status: res.status,
        ms,
        error: {
          message: body.error?.message ?? `HTTP ${res.status}`,
          code: body.error?.code,
          subcode: body.error?.error_subcode,
          type: body.error?.type,
        },
      };
    }
    return { ...probe, ok: true, url: shown, status: res.status, ms, data: body };
  } catch (err) {
    return {
      ...probe,
      ok: false,
      url: shown,
      status: 0,
      ms: Date.now() - started,
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** Détail d'un jeton : type, expiration, autorisations réellement accordées. */
async function inspectToken(token: string, label: string) {
  if (!token) return { label, present: false as const };
  if (!APP_ID || !APP_SECRET) return { label, present: true as const, unknown: true as const };
  const url = new URL(`${BASE}/debug_token`);
  url.searchParams.set('input_token', token);
  url.searchParams.set('access_token', `${APP_ID}|${APP_SECRET}`);
  const res = await fetch(url);
  const body: any = await res.json();
  const d = body.data ?? {};
  return {
    label,
    present: true as const,
    type: d.type as string | undefined,
    valid: d.is_valid as boolean | undefined,
    app: d.application as string | undefined,
    expiresAt: d.expires_at as number | undefined,
    dataAccessExpiresAt: d.data_access_expires_at as number | undefined,
    scopes: ((d.scopes ?? []) as string[]).slice().sort(),
    error: body.error?.message as string | undefined,
  };
}

// ── Rapport HTML ──────────────────────────────────────────────────────────

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!
  );

/** Un jeton ne doit jamais atterrir dans un fichier qu'on ouvre et partage. */
const redact = (s: string) => s.replace(/EAA[A-Za-z0-9]{20,}/g, 'EAA…[jeton masqué]');

const json = (v: unknown) => {
  const text = JSON.stringify(v, null, 2) ?? '';
  const clipped = text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (tronqué)` : text;
  return esc(redact(clipped));
};

const nf = new Intl.NumberFormat('fr-FR');
const num = (n: unknown) => (typeof n === 'number' ? nf.format(n) : '—');

const dateFr = (iso?: string | number) => {
  if (!iso) return '—';
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso);
  return Number.isNaN(+d) ? '—' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
};
const dateTimeFr = (iso?: string | number) => {
  if (!iso) return 'jamais';
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso);
  return Number.isNaN(+d) ? '—' : d.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
};

const trunc = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t || '—';
};

/** Autorisations que l'ancien jeton n'avait pas : ce qu'elles ouvrent est signalé « nouveau ». */
const NEW_SCOPES = new Set([
  'instagram_content_publish',
  'pages_read_user_content',
  'pages_manage_posts',
  'catalog_management',
]);

interface Ctx {
  by: (label: string) => Result | undefined;
  data: (label: string) => any;
  results: Result[];
}

// ── Briques d'affichage ───────────────────────────────────────────────────

const badgeNew = '<span class="new">nouveau</span>';

const stat = (label: string, value: string, extra = '', isNew = false) =>
  `<div class="stat"><span>${esc(label)}${isNew ? badgeNew : ''}</span><b>${value}</b>${extra ? `<i>${esc(extra)}</i>` : ''}</div>`;

const card = (title: string, inner: string, isNew = false) =>
  `<div class="card"><div class="chead">${esc(title)}${isNew ? badgeNew : ''}</div>${inner}</div>`;

/** Bloc affiché à la place d'un tableau quand la ressource a été refusée. */
const denied = (r?: Result) =>
  `<div class="pad muted">Non récupérable — ${esc(r?.error?.message ?? 'ressource indisponible')}</div>`;

const table = (headers: string[], rows: string, minWidth = 720) =>
  rows.trim()
    ? `<div class="tblwrap"><table style="min-width:${minWidth}px"><thead><tr>${headers
        .map((h) => `<th>${esc(h)}</th>`)
        .join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="pad muted">Aucune donnée.</div>`;

// ── Onglets ───────────────────────────────────────────────────────────────

function tabOverview(c: Ctx): string {
  const page = c.data('Fiche de la Page') ?? {};
  const ig = c.data('Profil du compte') ?? {};
  const forms = c.data('Formulaires de la Page')?.data ?? [];
  const leadForms = c.data('Leads de la Page')?.data ?? [];
  const leadCount = leadForms.reduce((n: number, f: any) => n + (f.leads?.data?.length ?? 0), 0);
  const convs = c.data('Conversations Messenger')?.data ?? [];
  const quota = c.data('Quota de publication')?.data?.[0];
  const ratings = c.data('Avis et notes')?.data ?? [];
  const igStats: Record<string, number> = {};
  for (const m of c.data('Statistiques du compte')?.data ?? []) igStats[m.name] = m.total_value?.value;
  const pageStats: Record<string, number> = {};
  for (const m of c.data('Statistiques de Page')?.data ?? []) {
    const v = m.values?.[m.values.length - 1]?.value;
    if (typeof v === 'number') pageStats[m.name] = v;
  }
  const igComments = (c.data('Commentaires reçus')?.data ?? []).reduce(
    (t: number, m: any) => t + (m.comments?.data?.length ?? 0),
    0
  );

  const tiles = [
    stat('Abonnés Instagram', num(ig.followers_count)),
    stat('Abonnés Page', num(page.followers_count)),
    stat('Publications Instagram', num(ig.media_count)),
    stat('Prospects lisibles', num(leadCount), `${forms.reduce((n: number, f: any) => n + (f.leads_count ?? 0), 0)} annoncés par Meta`),
    stat('Formulaires', num(forms.length)),
    stat('Conversations', num(convs.length)),
    stat('Comptes touchés (IG, 24 h)', num(igStats.reach)),
    stat('Visites du profil (IG)', num(igStats.profile_views)),
    stat('Interactions (IG)', num(igStats.total_interactions)),
    stat('Engagement Page (28 j)', num(pageStats.page_post_engagements)),
    stat('Vues de la Page (28 j)', num(pageStats.page_views_total)),
    stat('Nouveaux abonnés Page (28 j)', num(pageStats.page_daily_follows_unique)),
    stat('Commentaires Instagram', num(igComments), '10 dernières publications'),
    stat('Avis reçus', num(ratings.length), 'via pages_read_user_content', true),
    quota
      ? stat('Quota de publication IG', `${quota.quota_usage ?? 0}/${quota.config?.quota_total ?? '?'}`, 'droit de publier confirmé', true)
      : '',
  ]
    .filter(Boolean)
    .join('');

  const gains = [
    {
      scope: 'instagram_content_publish',
      titre: 'Publication Instagram',
      quoi: `Le quota répond : ${quota?.quota_usage ?? 0} publication(s) utilisée(s) sur ${quota?.config?.quota_total ?? '?'} par 24 h. <code>npm run post:live</code> peut désormais publier — l'ancien jeton en était incapable.`,
    },
    {
      scope: 'pages_read_user_content',
      titre: 'Contenu des visiteurs',
      quoi: `Le fil complet de la Page (${c.data('Fil complet (feed)')?.data?.length ?? 0} entrées) et les avis (${ratings.length}) deviennent lisibles : posts de tiers, recommandations, textes des avis.`,
    },
    {
      scope: 'pages_manage_posts',
      titre: 'Écriture sur la Page',
      quoi: "Droit de publier, modifier et supprimer des posts sur la Page Facebook. Aucune donnée à lire ici : c'est une capacité d'écriture, disponible pour une future automatisation.",
    },
    {
      scope: 'catalog_management',
      titre: 'Catalogue produits',
      quoi: "Accordé, mais inexploitable seul : Meta exige <code>business_management</code> pour atteindre les catalogues via <code>me/businesses</code>. C'est aujourd'hui la seule permission accordée qui ne donne rien.",
    },
  ]
    .map(
      (g) =>
        `<div class="gain"><div class="gtitle">${esc(g.titre)}<code>${esc(g.scope)}</code></div><p>${g.quoi}</p></div>`
    )
    .join('');

  const cover = page.cover?.source
    ? `<img class="cover" src="${esc(page.cover.source)}" alt="">`
    : '';

  return `
    ${cover}
    <h2>Chiffres clés</h2>
    <div class="grid g4">${tiles}</div>
    <h2>Ce que le nouveau jeton débloque</h2>
    <div class="gains">${gains}</div>
    <h2>Identité</h2>
    <div class="grid g2">
      ${card(
        'Page Facebook',
        `<div class="pad kv">
          <div><span>Nom</span><b>${esc(page.name)}</b></div>
          <div><span>Catégorie</span><b>${esc(page.category)}</b></div>
          <div><span>ID</span><b>${esc(page.id)}</b></div>
          <div><span>Adresse</span><b>${esc(page.single_line_address ?? '—')}</b></div>
          <div><span>Site</span><b>${esc(page.website ?? '—')}</b></div>
          <div><span>Téléphone</span><b>${esc(page.phone ?? '—')}</b></div>
          <div><span>Vérification</span><b>${esc(page.verification_status ?? '—')}</b></div>
          <div><span>Publiée</span><b>${page.is_published ? 'oui' : 'non'}</b></div>
          <div class="full"><span>À propos</span><b>${esc(trunc(page.about ?? page.description, 300))}</b></div>
        </div>`
      )}
      ${card(
        'Compte Instagram',
        `<div class="pad kv">
          <div><span>Identifiant</span><b>@${esc(ig.username)}</b></div>
          <div><span>Nom</span><b>${esc(ig.name ?? '—')}</b></div>
          <div><span>ID</span><b>${esc(ig.id)}</b></div>
          <div><span>Abonnés</span><b>${num(ig.followers_count)}</b></div>
          <div><span>Abonnements</span><b>${num(ig.follows_count)}</b></div>
          <div><span>Publications</span><b>${num(ig.media_count)}</b></div>
          <div class="full"><span>Bio</span><b>${esc(trunc(ig.biography, 300))}</b></div>
        </div>`
      )}
    </div>`;
}

function tabInstagram(c: Ctx): string {
  const ig = c.data('Profil du compte') ?? {};
  // « Publications » existe aussi côté Page : on cible explicitement la sonde Instagram.
  const posts =
    (c.results.find((r) => r.section === 'Instagram' && r.label === 'Publications')?.data as any)?.data ?? [];
  const comments = c.data('Commentaires reçus')?.data ?? [];
  const stats = c.data('Statistiques du compte')?.data ?? [];
  const quota = c.data('Quota de publication')?.data?.[0];

  const head = `<div class="phead">
    ${ig.profile_picture_url ? `<img src="${esc(ig.profile_picture_url)}" alt="">` : ''}
    <div style="flex:1">
      <h1>@${esc(ig.username)}</h1>
      <div class="pcat">${num(ig.followers_count)} abonnés · ${num(ig.follows_count)} abonnements · ${num(ig.media_count)} publications</div>
      <div class="pcat">${esc(trunc(ig.biography, 160))}</div>
    </div>
    ${quota ? `<div class="quota"><b>${quota.quota_usage ?? 0}/${quota.config?.quota_total ?? '?'}</b><span>publications 24 h</span>${badgeNew}</div>` : ''}
  </div>`;

  const statTiles = stats
    .map((m: any) => stat(m.title ?? m.name, num(m.total_value?.value)))
    .join('');

  const grid = posts
    .map((m: any) => {
      const src = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url;
      return `<a class="post" href="${esc(m.permalink)}" target="_blank" rel="noopener">
        ${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : '<div class="noimg"></div>'}
        <div class="pmeta">
          <span class="ptype">${esc(m.media_type)}</span>
          <span>❤ ${num(m.like_count)}</span><span>💬 ${num(m.comments_count)}</span>
        </div>
        <p>${esc(trunc(m.caption, 110))}</p>
        <small>${esc(dateFr(m.timestamp))}</small>
      </a>`;
    })
    .join('');

  const flat = comments.flatMap((m: any) =>
    (m.comments?.data ?? []).map((x: any) => ({ ...x, media: m.id }))
  );
  const commentRows = flat
    .slice(0, 60)
    .map(
      (x: any) =>
        `<tr><td class="date">${esc(dateFr(x.timestamp))}</td><td class="nom">@${esc(x.username)}</td><td>${esc(trunc(x.text, 220))}</td></tr>`
    )
    .join('');

  return `
    ${head}
    <h2>Audience et activité (24 h)</h2>
    <div class="grid g4">${statTiles || '<div class="pad muted">Statistiques indisponibles.</div>'}</div>
    <h2>Publications (${posts.length})</h2>
    ${
      ig.media_count && posts.length < ig.media_count
        ? `<div class="note">Le profil annonce ${num(ig.media_count)} publications ; l'API n'en sert que ${posts.length}, sans page suivante. Aucune autorisation ne lève cette limite.</div>`
        : ''
    }
    <div class="postgrid">${grid || '<div class="pad muted">Aucune publication.</div>'}</div>
    <h2>Commentaires reçus (${flat.length})</h2>
    ${table(['Date', 'Auteur', 'Commentaire'], commentRows, 600)}`;
}

function tabPage(c: Ctx): string {
  const posts = c.results.find((r) => r.section === 'Page Facebook' && r.label === 'Publications');
  const feed = c.by('Fil complet (feed)');
  const ratings = c.by('Avis et notes');
  const insights = c.data('Statistiques de Page')?.data ?? [];
  const roles = c.data('Rôles sur la Page')?.data ?? [];
  const subs = c.data('Apps abonnées au webhook')?.data ?? [];

  const insightCards = insights
    .map((m: any) => {
      const values = (m.values ?? []).map((v: any) => v.value).filter((v: any) => typeof v === 'number');
      const last = values[values.length - 1] ?? 0;
      const max = Math.max(...values, 1);
      const bars = values
        .map((v: number) => `<div class="mcol"><div class="mbar" style="height:${Math.max(3, (v / max) * 100)}%"></div></div>`)
        .join('');
      return `<div class="card"><div class="chead">${esc(m.title ?? m.name)}</div>
        <div class="pad"><div class="bignum">${num(last)}</div>
        <div class="months">${bars}</div>
        <small class="muted">${esc(trunc(m.description, 150))}</small></div></div>`;
    })
    .join('');

  const postRows = ((posts?.data as any)?.data ?? [])
    .map(
      (p: any) =>
        `<tr><td class="date">${esc(dateFr(p.created_time))}</td>
         <td>${esc(trunc(p.message, 160))}</td>
         <td>${num(p.likes?.summary?.total_count)}</td>
         <td>${num(p.comments?.summary?.total_count)}</td>
         <td>${num(p.shares?.count ?? 0)}</td>
         <td>${p.permalink_url ? `<a href="${esc(p.permalink_url)}" target="_blank" rel="noopener">voir</a>` : '—'}</td></tr>`
    )
    .join('');

  const feedRows = ((feed?.data as any)?.data ?? [])
    .map(
      (p: any) =>
        `<tr><td class="date">${esc(dateFr(p.created_time))}</td><td class="nom">${esc(p.from?.name ?? '—')}</td><td>${esc(trunc(p.message, 200))}</td><td>${p.permalink_url ? `<a href="${esc(p.permalink_url)}" target="_blank" rel="noopener">voir</a>` : '—'}</td></tr>`
    )
    .join('');

  const ratingRows = ((ratings?.data as any)?.data ?? [])
    .map(
      (r: any) =>
        `<tr><td class="date">${esc(dateFr(r.created_time))}</td>
         <td class="nom">${esc(r.reviewer?.name ?? 'Anonyme')}</td>
         <td><span class="tag ${r.recommendation_type === 'positive' ? 'ok' : 'ko'}">${esc(r.recommendation_type ?? r.rating ?? '—')}</span></td>
         <td>${esc(trunc(r.review_text, 260))}</td></tr>`
    )
    .join('');

  return `
    <h2>Statistiques de la Page (28 jours)</h2>
    <div class="grid g3">${insightCards || '<div class="pad muted">Indisponibles.</div>'}</div>

    <h2>Publications de la Page</h2>
    ${posts?.ok ? table(['Date', 'Message', 'J’aime', 'Commentaires', 'Partages', ''], postRows, 860) : denied(posts)}

    <h2>Fil complet — posts des visiteurs inclus ${badgeNew}</h2>
    ${feed?.ok ? table(['Date', 'Auteur', 'Message', ''], feedRows, 760) : denied(feed)}

    <h2>Avis et recommandations ${badgeNew}</h2>
    ${ratings?.ok ? table(['Date', 'Auteur', 'Type', 'Texte'], ratingRows, 760) : denied(ratings)}

    <h2>Administration</h2>
    <div class="grid g2">
      ${card(
        'Rôles sur la Page',
        table(
          ['Personne', 'Droits'],
          roles
            .map(
              (r: any) =>
                `<tr><td class="nom">${esc(r.name)}</td><td class="fn">${esc([...new Set(r.tasks ?? [])].join(', '))}</td></tr>`
            )
            .join(''),
          400
        )
      )}
      ${card(
        'Abonnement webhook',
        table(
          ['App', 'Champs'],
          subs
            .map(
              (a: any) =>
                `<tr><td class="nom">${esc(a.name ?? a.id)}</td><td class="fn">${esc((a.subscribed_fields ?? []).join(', '))}</td></tr>`
            )
            .join(''),
          400
        )
      )}
    </div>`;
}

function tabMessages(c: Ctx): string {
  const r = c.by('Conversations Messenger');
  const convs = (r?.data as any)?.data ?? [];
  const igr = c.by('Conversations Instagram');

  const rows = convs
    .map((conv: any) => {
      const other = (conv.participants?.data ?? []).find((p: any) => p.id !== PAGE_ID);
      const last = conv.messages?.data?.[0];
      const fromPage = last?.from?.id === PAGE_ID;
      return `<tr>
        <td class="date">${esc(dateFr(conv.updated_time))}</td>
        <td class="nom">${esc(other?.name ?? '—')}</td>
        <td>${num(conv.message_count)}</td>
        <td>${conv.unread_count ? `<span class="tag ko">${conv.unread_count} non lu</span>` : '<span class="tag ok">à jour</span>'}</td>
        <td><span class="who">${fromPage ? 'Page' : 'Client'}</span> ${esc(trunc(conv.snippet ?? last?.message, 180))}</td>
      </tr>`;
    })
    .join('');

  return `
    <h2>Conversations Messenger (${convs.length})</h2>
    ${r?.ok ? table(['Mise à jour', 'Interlocuteur', 'Messages', 'État', 'Dernier message'], rows, 900) : denied(r)}
    <h2>Messages directs Instagram</h2>
    ${
      igr?.ok
        ? table(
            ['Mise à jour', 'Messages'],
            ((igr.data as any)?.data ?? [])
              .map((x: any) => `<tr><td class="date">${esc(dateFr(x.updated_time))}</td><td>${num(x.message_count)}</td></tr>`)
              .join(''),
            400
          )
        : `<div class="na"><div class="nat">Non récupérable</div><div class="naw">${esc(igr?.error?.message ?? '')}</div>
           <ul class="nal"><li>Ajouter l'autorisation <code>instagram_manage_messages</code>, puis régénérer le jeton.</li></ul></div>`
    }`;
}

function tabLeads(c: Ctx): string {
  const r = c.by('Leads de la Page');
  const forms = (r?.data as any)?.data ?? [];

  interface Row { date: string; form: string; fields: Record<string, string>; id: string }
  const rows: Row[] = [];
  for (const f of forms) {
    for (const l of f.leads?.data ?? []) {
      const fields: Record<string, string> = {};
      for (const fd of l.field_data ?? []) fields[fd.name] = (fd.values ?? []).join(', ');
      rows.push({ date: l.created_time, form: f.name ?? f.id, fields, id: l.id });
    }
  }
  rows.sort((a, b) => +new Date(b.date) - +new Date(a.date));

  const pick = (f: Record<string, string>, keys: string[]) => {
    for (const k of Object.keys(f)) if (keys.some((x) => k.includes(x))) return f[k];
    return '';
  };

  const body = rows
    .map(
      (row, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="date">${esc(dateFr(row.date))}</td>
        <td class="nom">${esc(pick(row.fields, ['full_name', 'nom', 'name']) || '—')}</td>
        <td>${esc(pick(row.fields, ['email', 'mail']) || '—')}</td>
        <td>${esc(pick(row.fields, ['phone', 'tel']) || '—')}</td>
        <td class="fn">${esc(trunc(row.form, 60))}</td>
        <td class="idc">${esc(row.id)}</td>
      </tr>`
    )
    .join('');

  const annonces = (c.data('Formulaires de la Page')?.data ?? []).reduce(
    (n: number, f: any) => n + (f.leads_count ?? 0),
    0
  );

  return `
    <h2>Prospects lisibles (${rows.length})</h2>
    <div class="note">Meta annonce ${annonces} lead(s) via <code>leads_count</code> mais n'en restitue que ${rows.length} : au-delà de 90 jours, les données ne sont plus servies par l'API et rien ne permet de les récupérer.</div>
    ${r?.ok ? table(['#', 'Date', 'Nom', 'E-mail', 'Téléphone', 'Formulaire', 'ID'], body, 980) : denied(r)}`;
}

function tabForms(c: Ctx): string {
  const forms = c.data('Formulaires de la Page')?.data ?? [];
  const leadsBy: Record<string, number> = {};
  for (const f of c.data('Leads de la Page')?.data ?? []) leadsBy[f.id] = f.leads?.data?.length ?? 0;

  const cards = [...forms]
    .sort((a: any, b: any) => (b.leads_count ?? 0) - (a.leads_count ?? 0))
    .map((f: any) => {
      const active = f.status === 'ACTIVE';
      return `<div class="fcard">
        <div class="fhead">
          <div><div class="fname">${esc(f.name ?? f.id)}</div><div class="fid">${esc(f.id)}</div></div>
          <span class="badge ${active ? 'ok' : 'arch'}">${esc(f.status ?? '—')}</span>
        </div>
        <div class="fmeta">Créé le ${esc(dateFr(f.created_time))} · ${f.leads_count ?? 0} lead(s) annoncé(s) · ${leadsBy[f.id] ?? 0} lisible(s)</div>
        <div class="fqs">${(f.questions ?? [])
          .map((q: any) => `<div class="q">${esc(q.label ?? q.key)}</div>`)
          .join('')}</div>
      </div>`;
    })
    .join('');

  return `<h2>Formulaires Instant Forms (${forms.length})</h2><div class="fgrid">${cards || '<div class="pad muted">Aucun formulaire.</div>'}</div>`;
}

function tabAds(c: Ctx): string {
  const accounts = c.data('Comptes publicitaires')?.data ?? [];
  const accRows = accounts
    .map(
      (a: any) =>
        `<tr><td class="nom">${esc(a.name)}</td><td class="idc">${esc(a.id)}</td>
         <td>${esc(a.currency)}</td><td>${esc(a.amount_spent)}</td>
         <td>${a.account_status === 1 ? '<span class="tag ok">actif</span>' : `<span class="tag arch">statut ${esc(a.account_status)}</span>`}</td></tr>`
    )
    .join('');

  const campaignBlocks = c.results
    .filter((r) => r.label.startsWith('Campagnes — '))
    .map((r) => {
      const rows = ((r.data as any)?.data ?? [])
        .map(
          (x: any) =>
            `<tr><td class="nom">${esc(x.name)}</td><td>${esc(x.objective ?? '—')}</td><td>${esc(x.effective_status ?? x.status)}</td><td class="date">${esc(dateFr(x.created_time))}</td></tr>`
        )
        .join('');
      return card(r.label, r.ok ? table(['Campagne', 'Objectif', 'Statut', 'Créée'], rows, 560) : denied(r));
    })
    .join('');

  const perf = c.results
    .filter((r) => r.label.startsWith('Performances — '))
    .map((r) => {
      const row = (r.data as any)?.data?.[0];
      return card(
        r.label,
        row
          ? `<div class="pad kv">
              <div><span>Dépense</span><b>${esc(row.spend)}</b></div>
              <div><span>Impressions</span><b>${esc(row.impressions)}</b></div>
              <div><span>Clics</span><b>${esc(row.clicks)}</b></div>
              <div><span>CTR</span><b>${esc(row.ctr)}</b></div>
            </div>`
          : `<div class="pad muted">Aucune dépense sur les 30 derniers jours.</div>`
      );
    })
    .join('');

  return `
    <h2>Comptes publicitaires</h2>
    ${table(['Compte', 'ID', 'Devise', 'Dépensé', 'Statut'], accRows, 640)}
    <h2>Campagnes et performances</h2>
    <div class="grid g2">${campaignBlocks}${perf}</div>`;
}

function tabAccess(c: Ctx, tokens: any[]): string {
  const cards = tokens
    .map((t) => {
      if (!t.present) return `<div class="card"><div class="chead">${esc(t.label)}</div><div class="pad muted">Absent de .env</div></div>`;
      if (t.unknown)
        return `<div class="card"><div class="chead">${esc(t.label)}</div><div class="pad muted">META_APP_ID / META_APP_SECRET manquants : inspection impossible.</div></div>`;
      const never = !t.expiresAt;
      return `<div class="card"><div class="chead">${esc(t.label)}<span class="tag ${t.valid ? 'ok' : 'ko'}">${t.valid ? 'valide' : 'invalide'}</span></div>
        <div class="pad">
          <div class="kv">
            <div><span>Type</span><b>${esc(t.type)}</b></div>
            <div><span>App</span><b>${esc(t.app)}</b></div>
            <div><span>Expiration</span><b>${never ? 'n’expire pas' : esc(dateTimeFr(t.expiresAt))}</b></div>
            <div><span>Accès données</span><b>${esc(dateTimeFr(t.dataAccessExpiresAt))}</b></div>
          </div>
          <div class="scopes">${(t.scopes ?? [])
            .map((s: string) => `<span class="chip ${NEW_SCOPES.has(s) ? 'chip-new' : ''}">${esc(s)}</span>`)
            .join('')}</div>
          <small class="muted">Les autorisations en couleur sont celles ajoutées avec ce jeton.</small>
        </div></div>`;
    })
    .join('');

  const probes = c.results
    .map(
      (r) => `<details class="probe">
        <summary><span class="dot ${r.ok ? 'on' : 'off'}"></span>
        <span class="lbl">${esc(r.label)}</span>
        <span class="sum">${r.ok ? esc(r.summarize?.(r.data) ?? 'réponse reçue') : esc(r.error?.message ?? 'échec')}</span>
        <code class="scope">${esc(r.scope)}</code></summary>
        <p class="meta"><code>GET ${esc(redact(r.url))}</code> — ${r.status || '—'} · ${r.ms} ms<br><em>${esc(r.purpose)}</em></p>
        <pre${r.ok ? '' : ' class="err"'}>${r.ok ? json(r.data) : esc(r.error?.message ?? '')}</pre>
      </details>`
    )
    .join('');

  return `<h2>Jetons</h2><div class="grid g2">${cards}</div>
    <h2>Les ${c.results.length} appels, réponse brute comprise</h2>${probes}`;
}

function tabMissing(c: Ctx): string {
  const ko = c.results.filter((r) => !r.ok);

  const manual = [
    {
      titre: 'Business Manager et catalogues produits',
      pourquoi: "L'app n'a pas <code>business_management</code> : <code>me/businesses</code> répond « Missing Permission », ce qui rend aussi <code>catalog_management</code> inutilisable.",
      faire: [
        'Ajouter <code>business_management</code> dans Utilisation de l’API sur le Dashboard Meta',
        'Régénérer le jeton, puis <code>npm run audit</code>',
        'Bonus : un jeton de System User devient alors possible — il survit à un changement de mot de passe',
      ],
    },
    {
      titre: 'Messages directs Instagram',
      pourquoi: "L'API refuse la plateforme <code>instagram</code> sur <code>/conversations</code> sans <code>instagram_manage_messages</code>.",
      faire: ['Ajouter <code>instagram_manage_messages</code>', 'Régénérer le jeton'],
    },
    {
      titre: 'Mentions et identifications Instagram',
      pourquoi: "<code>/tags</code> renvoie « Application does not have permission » : il faut <code>instagram_manage_comments</code>, qui ouvre aussi la réponse aux commentaires.",
      faire: ['Ajouter <code>instagram_manage_comments</code>', 'Régénérer le jeton'],
    },
    {
      titre: 'Leads de plus de 90 jours',
      pourquoi: "Meta purge les données de lead au bout de 90 jours. <code>leads_count</code> continue de les compter, l'API ne les renvoie plus.",
      faire: ['Aucune permission n’y change quoi que ce soit — seul le webhook en service évite la perte future'],
    },
    {
      titre: 'Publications Instagram anciennes',
      pourquoi: `Le profil annonce ${c.data('Profil du compte')?.media_count ?? '?'} publications, mais <code>/media</code> n'en sert que ${
        (c.results.find((r) => r.section === 'Instagram' && r.label === 'Publications')?.data as any)?.data?.length ?? 0
      } et ne propose aucune page suivante.`,
      faire: [
        'Aucune permission ne change cela : la limite vient de l’API, pas du jeton',
        'Les publications manquantes restent visibles sur le profil public',
      ],
    },
    {
      titre: 'Anciennes métriques de Page',
      pourquoi: "<code>page_impressions</code>, <code>page_fans</code> et <code>page_fan_adds</code> ont été retirées de la Graph API v22+.",
      faire: ['Utiliser les remplaçantes déjà affichées : engagement, vues, nouveaux abonnés'],
    },
  ]
    .map(
      (m) => `<div class="na"><div class="nat">${m.titre}</div><div class="naw">${m.pourquoi}</div>
        <ul class="nal">${m.faire.map((f) => `<li>${f}</li>`).join('')}</ul></div>`
    )
    .join('');

  const rows = ko
    .map(
      (r) =>
        `<tr><td class="nom">${esc(r.label)}<br><small>${esc(r.purpose)}</small></td><td><code>${esc(r.scope)}</code></td><td>${esc(r.error?.message ?? '')}</td></tr>`
    )
    .join('');

  return `
    <h2>Appels refusés (${ko.length})</h2>
    ${table(['Ressource', 'Autorisation requise', 'Réponse de Meta'], rows, 700)}
    <h2>Ce qu'il faudrait pour chacune</h2>
    ${manual}`;
}

// ── Assemblage ────────────────────────────────────────────────────────────

function render(results: Result[], tokens: any[]): string {
  const by = (label: string) => results.find((r) => r.label === label);
  const c: Ctx = { by, data: (label) => by(label)?.data as any, results };

  const page = c.data('Fiche de la Page') ?? {};
  const forms = c.data('Formulaires de la Page')?.data ?? [];
  const leadCount = (c.data('Leads de la Page')?.data ?? []).reduce(
    (n: number, f: any) => n + (f.leads?.data?.length ?? 0),
    0
  );
  const ok = results.filter((r) => r.ok).length;

  const tabs: Array<[string, string, string]> = [
    ['over', "Vue d'ensemble", tabOverview(c)],
    ['insta', 'Instagram', tabInstagram(c)],
    ['page', 'Page Facebook', tabPage(c)],
    ['msg', 'Messagerie', tabMessages(c)],
    ['leads', `Prospects (${leadCount})`, tabLeads(c)],
    ['forms', `Formulaires (${forms.length})`, tabForms(c)],
    ['ads', 'Publicité', tabAds(c)],
    ['acces', `Accès (${ok}/${results.length})`, tabAccess(c, tokens)],
    ['na', `À récupérer (${results.length - ok})`, tabMissing(c)],
  ];

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Compte Meta — ${esc(page.name ?? 'Pause-Com')}</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}
body{margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f5f7;color:#1a1d21}
@media(prefers-color-scheme:dark){body{background:#0e1014;color:#e6e8eb}}
.wrap{max-width:1200px;margin:0 auto;padding:24px 20px 70px}
h1{font-size:22px;margin:0}
a{color:#3b82f6;text-decoration:none}
.phead{display:flex;gap:16px;align-items:center;background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 3px #0000000f;margin-bottom:8px}
@media(prefers-color-scheme:dark){.phead{background:#171a20}}
.phead img{width:64px;height:64px;border-radius:50%;object-fit:cover;flex:none}
.pcat{color:#6b7280;font-size:13px;margin-top:2px}
.pill{background:#16a34a1a;color:#16a34a;padding:2px 10px;border-radius:20px;font-weight:600;font-size:12px;vertical-align:middle}
.cover{width:100%;height:180px;object-fit:cover;border-radius:16px;margin-bottom:4px;display:block}
.tabs{display:flex;gap:6px;margin:18px 0;flex-wrap:wrap;position:sticky;top:0;background:#f4f5f7;padding:10px 0;z-index:5}
@media(prefers-color-scheme:dark){.tabs{background:#0e1014}}
.tab{padding:8px 15px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;cursor:pointer;font-weight:600;font-size:13px;color:#6b7280}
@media(prefers-color-scheme:dark){.tab{background:#171a20;border-color:#262b33}}
.tab.active{background:#3b82f6;color:#fff;border-color:#3b82f6}
h2{font-size:13px;margin:26px 0 12px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em}
.grid{display:grid;gap:12px}
.g4{grid-template-columns:repeat(auto-fit,minmax(165px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.g2{grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.stat{background:#fff;border-radius:12px;padding:15px 16px;box-shadow:0 1px 3px #0000000f}
@media(prefers-color-scheme:dark){.stat{background:#171a20}}
.stat b{font-size:25px;display:block;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat span{color:#6b7280;font-size:12px;display:block}
.stat i{color:#9099a5;font-size:11px;font-style:normal}
.new{display:inline-block;background:#f59e0b1f;color:#b45309;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 6px;border-radius:20px;margin-left:6px;vertical-align:middle}
@media(prefers-color-scheme:dark){.new{color:#fbbf24;background:#f59e0b26}}
.card{background:#fff;border-radius:14px;box-shadow:0 1px 3px #0000000f;overflow:hidden}
@media(prefers-color-scheme:dark){.card{background:#171a20}}
.chead{padding:14px 18px;font-weight:700;border-bottom:1px solid #f0f1f3;display:flex;align-items:center;gap:8px;justify-content:space-between}
@media(prefers-color-scheme:dark){.chead{border-color:#22262e}}
.pad{padding:16px 18px}
.muted{color:#9099a5}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kv>div{min-width:0}.kv .full{grid-column:1/-1}
.kv span{display:block;color:#9099a5;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.kv b{font-weight:600;word-break:break-word}
.bignum{font-size:30px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.months{display:flex;gap:3px;align-items:flex-end;height:56px;margin:10px 0}
.mcol{flex:1;display:flex;align-items:flex-end;height:100%}
.mbar{width:100%;background:#3b82f6;border-radius:3px 3px 0 0;min-height:3px}
.gains{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.gain{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 3px #0000000f;border-left:3px solid #f59e0b}
@media(prefers-color-scheme:dark){.gain{background:#171a20}}
.gtitle{font-weight:700;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gain p{margin:8px 0 0;color:#6b7280;font-size:13px}
.tblwrap{overflow-x:auto;background:#fff;border-radius:14px;box-shadow:0 1px 3px #0000000f}
@media(prefers-color-scheme:dark){.tblwrap{background:#171a20}}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9099a5;padding:11px 14px;border-bottom:1px solid #e5e7eb;background:#fafbfc;white-space:nowrap}
@media(prefers-color-scheme:dark){th{background:#1c2027;border-color:#262b33}}
td{padding:10px 14px;border-bottom:1px solid #f0f1f3;vertical-align:top}
@media(prefers-color-scheme:dark){td{border-color:#22262e}}
tr:last-child td{border-bottom:none}
.num{color:#b0b7c0;width:30px}
.date{color:#6b7280;white-space:nowrap;font-variant-numeric:tabular-nums}
.nom{font-weight:600}.fn{font-size:12px;color:#6b7280}
.idc{color:#b0b7c0;font-size:11px;white-space:nowrap}
.tag{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11.5px;white-space:nowrap;font-weight:600}
.tag.ok{background:#16a34a1a;color:#16a34a}.tag.ko{background:#dc26261a;color:#dc2626}.tag.arch{background:#9099a51a;color:#9099a5}
.who{display:inline-block;font-size:10.5px;font-weight:700;color:#9099a5;text-transform:uppercase;letter-spacing:.04em;margin-right:6px}
.postgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.post{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px #0000000f;display:block;color:inherit}
@media(prefers-color-scheme:dark){.post{background:#171a20}}
.post img,.post .noimg{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:#e9ebef}
@media(prefers-color-scheme:dark){.post .noimg{background:#22262e}}
.post p{margin:0 12px 4px;font-size:12.5px;color:#6b7280;line-height:1.4}
.post small{display:block;margin:0 12px 12px;color:#b0b7c0;font-size:11px}
.pmeta{display:flex;gap:8px;align-items:center;padding:10px 12px 6px;font-size:12px;color:#6b7280;font-variant-numeric:tabular-nums}
.ptype{font-size:9.5px;font-weight:700;letter-spacing:.05em;background:#3b82f61a;color:#3b82f6;padding:2px 6px;border-radius:20px;margin-right:auto}
.quota{text-align:center;background:#16a34a12;border-radius:12px;padding:12px 18px;flex:none}
.quota b{display:block;font-size:22px;font-weight:700}
.quota span{font-size:11px;color:#6b7280;display:block}
.fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.fcard{background:#fff;border-radius:12px;box-shadow:0 1px 3px #0000000f;padding:16px}
@media(prefers-color-scheme:dark){.fcard{background:#171a20}}
.fhead{display:flex;justify-content:space-between;gap:8px}
.fname{font-weight:700}.fid{color:#9099a5;font-size:11px;word-break:break-all}
.badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;height:fit-content;white-space:nowrap}
.badge.ok{background:#16a34a1a;color:#16a34a}.badge.arch{background:#9099a51a;color:#9099a5}
.fmeta{color:#6b7280;font-size:12px;margin:8px 0}
.fqs .q{font-size:12.5px;padding:6px 0;border-top:1px solid #f0f1f3;color:#6b7280}
@media(prefers-color-scheme:dark){.fqs .q{border-color:#22262e}}
.na{background:#fff;border-radius:12px;padding:16px;margin-bottom:10px;box-shadow:0 1px 3px #0000000f;border-left:3px solid #eab308}
@media(prefers-color-scheme:dark){.na{background:#171a20}}
.nat{font-weight:700}.naw{color:#6b7280;font-size:13px;margin:5px 0 8px}
.nal{margin:0;padding-left:20px;font-size:13px}.nal li{margin:3px 0;color:#6b7280}
.note{background:#3b82f612;border-left:3px solid #3b82f6;border-radius:10px;padding:12px 16px;font-size:13px;color:#6b7280;margin-bottom:12px}
.chip{display:inline-block;background:#0000000d;border-radius:5px;padding:2px 7px;margin:2px 3px 2px 0;font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace}
@media(prefers-color-scheme:dark){.chip{background:#ffffff12}}
.chip-new{background:#f59e0b26;color:#b45309;font-weight:600}
@media(prefers-color-scheme:dark){.chip-new{color:#fbbf24}}
.scopes{margin:12px 0 8px}
.probe{background:#fff;border-radius:12px;box-shadow:0 1px 3px #0000000f;margin-bottom:8px;overflow:hidden}
@media(prefers-color-scheme:dark){.probe{background:#171a20}}
summary{cursor:pointer;padding:12px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;list-style:none}
summary::-webkit-details-marker{display:none}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:#16a34a}.dot.off{background:#dc2626}
.lbl{font-weight:600}.sum{color:#6b7280;font-size:13px;flex:1;min-width:200px}
.scope{font:11.5px ui-monospace,Menlo,monospace;background:#0000000d;padding:2px 7px;border-radius:5px;color:#9099a5}
@media(prefers-color-scheme:dark){.scope{background:#ffffff12}}
.meta{margin:0;padding:0 16px 8px;color:#9099a5;font-size:12px}
pre{margin:0;padding:14px 16px;background:#0000000a;overflow-x:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:420px}
@media(prefers-color-scheme:dark){pre{background:#0d0f13}}
pre.err{color:#dc2626}
code{background:#0000000f;padding:1px 5px;border-radius:4px;font-size:12px;font-family:ui-monospace,Menlo,monospace}
@media(prefers-color-scheme:dark){code{background:#ffffff14}}
footer{margin-top:40px;padding-top:16px;border-top:1px solid #e5e7eb;color:#9099a5;font-size:12.5px}
@media(prefers-color-scheme:dark){footer{border-color:#262b33}}
</style></head><body><div class="wrap">

<div class="phead">
  ${page.picture?.data?.url ? `<img src="${esc(page.picture.data.url)}" alt="">` : ''}
  <div style="flex:1">
    <h1>${esc(page.name ?? 'Pause-Com')} <span class="pill">${ok}/${results.length} accès</span></h1>
    <div class="pcat">${esc(page.category ?? '')} · ID Page ${esc(page.id ?? PAGE_ID)} · <a href="${esc(page.link ?? '#')}" target="_blank" rel="noopener">voir la Page</a></div>
    <div class="pcat">Audit du ${esc(dateTimeFr(new Date().toISOString()))} · Graph API ${esc(VERSION)}</div>
  </div>
</div>

<div class="tabs">${tabs
    .map(([id, label], i) => `<div class="tab${i === 0 ? ' active' : ''}" data-t="${id}">${esc(label)}</div>`)
    .join('')}</div>

${tabs.map(([id, , html], i) => `<section data-s="${id}"${i === 0 ? '' : ' hidden'}>${html}</section>`).join('')}

<footer>Les jetons sont masqués dans ce rapport, mais il contient des données personnelles (prospects, conversations, avis) : à ne pas partager tel quel.<br>Régénérer à tout moment : <code>npm run audit</code></footer>
</div>
<script>
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((t) => t.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('section[data-s]').forEach((s) => {
      s.hidden = s.dataset.s !== t.dataset.t;
    });
    window.scrollTo({ top: 0 });
  }));
</script>
</body></html>`;
}

// ── Point d'entrée ────────────────────────────────────────────────────────

await runCli(async () => {
  console.log(`\nAudit des accès Meta…\n`);

  const tokens = await Promise.all([
    inspectToken(PAGE_TOKEN, 'Jeton de Page'),
    inspectToken(USER_TOKEN, 'Jeton utilisateur'),
  ]);

  // Les sondes Instagram et publicitaires ont besoin d'identifiants qu'on ne
  // connaît qu'après un premier appel : on les résout avant de lancer la série.
  const queue = [...PROBES];

  const igLookup = await run(PROBES.find((p) => p.label === 'Compte professionnel lié')!);
  const igId = (igLookup.data as any)?.instagram_business_account?.id ?? process.env.IG_USER_ID;
  if (igId) queue.push(...instagramProbes(igId));

  if (USER_TOKEN) {
    const accounts = await run(PROBES.find((p) => p.label === 'Comptes publicitaires')!);
    for (const a of ((accounts.data as any)?.data ?? []).slice(0, 3)) {
      queue.push(...adAccountProbes(a.id, a.name ?? a.id));
    }
  }

  const results: Result[] = [];
  for (const probe of queue) {
    const r = await run(probe);
    results.push(r);
    const note = r.ok ? (r.summarize?.(r.data) ?? 'réponse reçue') : (r.error?.message ?? 'échec');
    console.log(`${r.ok ? '✅' : '❌'} ${r.section} › ${r.label}\n     ${note}`);
  }

  writeFileSync(OUT, render(results, tokens));
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${okCount}/${results.length} ressources accessibles.`);
  console.log(`Rapport écrit : ${OUT}`);

  if (OPEN) spawn('open', [OUT], { detached: true, stdio: 'ignore' }).unref();
});
