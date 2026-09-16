/**
 * Données « Meta Business Suite » de la Page : audience, publications
 * Facebook et Instagram, avis, mentions et messagerie.
 *
 * Tout passe par le jeton de Page, dont les appels sont décomptés sur le
 * plafond de la Page et non sur celui de l'app. Chaque bloc est lu
 * indépendamment et mis en cache 5 minutes ; un webhook Meta (nouvelle
 * publication, commentaire, message) vide le cache pour que la prochaine
 * consultation montre la nouveauté.
 */
import { graphGet } from './graph.js';
import { errorMessage } from './env.js';

export type Part<T> = { ok: true; data: T } | { ok: false; error: string };

async function part<T>(fn: () => Promise<T>): Promise<Part<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

interface Edge<T> {
  data?: T[];
}

export interface PagePost {
  id: string;
  created_time?: string;
  message?: string;
  full_picture?: string;
  permalink_url?: string;
  shares?: { count?: number };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
}

export interface PageProfile {
  name?: string;
  link?: string;
  fan_count?: number;
  followers_count?: number;
  rating_count?: number;
  overall_star_rating?: number;
  picture?: { data?: { url?: string } };
  posts?: Edge<PagePost>;
}

export interface Rating {
  created_time?: string;
  recommendation_type?: string;
  review_text?: string;
  reviewer?: { name?: string };
}

export interface Conversation {
  id: string;
  updated_time?: string;
  message_count?: number;
  unread_count?: number;
  snippet?: string;
  link?: string;
  participants?: Edge<{ id?: string; name?: string }>;
}

export interface IgMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

export interface IgProfile {
  id: string;
  username?: string;
  name?: string;
  biography?: string;
  website?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  profile_picture_url?: string;
  media?: Edge<IgMedia>;
}

export interface IgMention {
  id: string;
  username?: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
}

export interface Series {
  name: string;
  title: string;
  total: number;
  values: number[];
  /** Fin de chaque journée mesurée, alignée sur `values`. */
  dates: string[];
}

export interface Business {
  generatedAt: string;
  page: Part<PageProfile>;
  ratings: Part<Rating[]>;
  conversations: Part<Conversation[]>;
  instagram: Part<IgProfile>;
  mentions: Part<IgMention[]>;
  pageInsights: Part<Series[]>;
  igInsights: Part<Array<{ name: string; title: string; value: number }>>;
}

/** Libellés français des métriques, Meta les renvoyant selon la langue de l'app. */
const TITLES: Record<string, string> = {
  page_post_engagements: 'Interactions avec les publications',
  page_views_total: 'Vues de la Page',
  page_daily_follows_unique: 'Nouveaux abonnés',
  reach: 'Comptes touchés',
  views: 'Vues',
  profile_views: 'Visites du profil',
  accounts_engaged: 'Comptes ayant interagi',
  total_interactions: 'Interactions',
};

async function collect(): Promise<Business> {
  const pageId = process.env.META_PAGE_ID ?? '';
  const now = Math.floor(Date.now() / 1000);
  const since = String(now - 28 * 86400);
  const until = String(now);

  // L'identifiant Instagram conditionne trois blocs : on le résout une fois.
  const igId = graphGet<{ instagram_business_account?: { id?: string } }>(pageId, {
    fields: 'instagram_business_account',
  }).then((r) => {
    const id = process.env.IG_USER_ID || r.instagram_business_account?.id;
    if (!id) throw new Error('Aucun compte Instagram professionnel lié à la Page');
    return id;
  });

  const [page, ratings, conversations, instagram, mentions, pageInsights, igInsights] = await Promise.all([
    part(() =>
      graphGet<PageProfile>(pageId, {
        fields:
          'name,link,fan_count,followers_count,rating_count,overall_star_rating,picture{url},' +
          'posts.limit(12){id,created_time,message,full_picture,permalink_url,shares,' +
          'reactions.summary(true).limit(0),comments.summary(true).limit(0)}',
      })
    ),
    part(async () =>
      (await graphGet<Edge<Rating>>(`${pageId}/ratings`, {
        fields: 'created_time,recommendation_type,review_text,reviewer{name}',
        limit: 20,
      })).data ?? []
    ),
    part(async () =>
      (await graphGet<Edge<Conversation>>(`${pageId}/conversations`, {
        fields: 'id,updated_time,message_count,unread_count,snippet,participants,link',
        limit: 30,
      })).data ?? []
    ),
    part(async () =>
      graphGet<IgProfile>(await igId, {
        fields:
          'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,' +
          'media.limit(24){id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count}',
      })
    ),
    part(async () =>
      (await graphGet<Edge<IgMention>>(`${await igId}/tags`, {
        fields: 'id,username,caption,permalink,timestamp',
        limit: 20,
      })).data ?? []
    ),
    part(async () => {
      const r = await graphGet<Edge<{ name: string; values?: Array<{ value?: number; end_time?: string }> }>>(`${pageId}/insights`, {
        metric: 'page_post_engagements,page_views_total,page_daily_follows_unique',
        period: 'day',
        since,
        until,
      });
      return (r.data ?? []).map((m) => {
        const values = (m.values ?? []).map((v) => (typeof v.value === 'number' ? v.value : 0));
        const dates = (m.values ?? []).map((v) => v.end_time ?? '');
        return { name: m.name, title: TITLES[m.name] ?? m.name, total: values.reduce((a, b) => a + b, 0), values, dates };
      });
    }),
    part(async () => {
      const r = await graphGet<Edge<{ name: string; total_value?: { value?: number } }>>(`${await igId}/insights`, {
        metric: 'reach,views,profile_views,accounts_engaged,total_interactions',
        period: 'day',
        metric_type: 'total_value',
        since,
        until,
      });
      return (r.data ?? []).map((m) => ({ name: m.name, title: TITLES[m.name] ?? m.name, value: m.total_value?.value ?? 0 }));
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    page,
    ratings,
    conversations,
    instagram,
    mentions,
    pageInsights,
    igInsights,
  };
}

const TTL_MS = 5 * 60_000;
let cached: { at: number; value: Promise<Business> } | undefined;

export function getBusiness(fresh = false): Promise<Business> {
  if (!fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = collect();
  cached = { at: Date.now(), value };
  value.catch(() => (cached = undefined));
  return value;
}

export function invalidateBusiness(): void {
  cached = undefined;
}

// ── Détails chargés à la demande ──────────────────────────────────────────

export interface ThreadMessage {
  id?: string;
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
}

export async function fetchConversation(id: string): Promise<ThreadMessage[]> {
  const r = await graphGet<{ messages?: Edge<ThreadMessage> }>(id, {
    fields: 'messages.limit(50){id,message,created_time,from}',
  });
  // Meta renvoie du plus récent au plus ancien ; un fil se lit dans l'autre sens.
  return (r.messages?.data ?? []).reverse();
}

export interface Comment {
  id: string;
  text: string;
  author: string;
  created_time?: string;
  likes?: number;
}

export async function fetchInstagramComments(mediaId: string): Promise<Comment[]> {
  const r = await graphGet<Edge<{ id: string; text?: string; username?: string; timestamp?: string; like_count?: number }>>(
    `${mediaId}/comments`,
    { fields: 'id,text,username,timestamp,like_count', limit: 50 }
  );
  return (r.data ?? []).map((c) => {
    const out: Comment = { id: c.id, text: c.text ?? '', author: c.username ? `@${c.username}` : '—' };
    if (c.timestamp) out.created_time = c.timestamp;
    if (c.like_count !== undefined) out.likes = c.like_count;
    return out;
  });
}

export async function fetchPostComments(postId: string): Promise<Comment[]> {
  const r = await graphGet<Edge<{ id: string; message?: string; from?: { name?: string }; created_time?: string; like_count?: number }>>(
    `${postId}/comments`,
    { fields: 'id,message,from,created_time,like_count', limit: 50 }
  );
  return (r.data ?? []).map((c) => {
    const out: Comment = { id: c.id, text: c.message ?? '', author: c.from?.name ?? 'Utilisateur Facebook' };
    if (c.created_time) out.created_time = c.created_time;
    if (c.like_count !== undefined) out.likes = c.like_count;
    return out;
  });
}
