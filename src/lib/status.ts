/**
 * État en direct de l'automatisation : ce que voit Meta, ce que contient le
 * Sheet, et si les deux concordent.
 *
 * Chaque bloc est interrogé indépendamment : une panne côté Google ne doit pas
 * masquer l'état de Meta, et inversement. Un bloc en échec porte son message
 * d'erreur au lieu de faire échouer l'ensemble.
 */
import { graphGet, listLeadForms, fetchFormLeads, debugToken } from './graph.js';
import { readLeadRows, checkAccess } from './sheets.js';
import { errorMessage } from './env.js';
import { isTestLead } from './leads.js';
import type { LeadRow } from '../types.js';

// ── Activité du webhook ───────────────────────────────────────────────────

export type ActivityStatus = 'écrit' | 'déjà présent' | 'test Meta ignoré' | 'échec';

export interface Activity {
  at: string;
  leadId: string;
  status: ActivityStatus;
  name?: string;
  error?: string;
}

/**
 * Journal des notifications reçues depuis le démarrage du serveur.
 *
 * Il vit en mémoire et repart à zéro à chaque redémarrage : le Sheet reste la
 * seule trace durable. Il sert à voir, sans ouvrir les logs Render, si Meta
 * appelle bien le serveur et si le traitement aboutit.
 */
const MAX_ACTIVITY = 50;
const activity: Activity[] = [];
const counters = { reçues: 0, écrites: 0, échecs: 0 };
const startedAt = new Date();

export function recordActivity(entry: Omit<Activity, 'at'>): void {
  activity.unshift({ at: new Date().toISOString(), ...entry });
  activity.length = Math.min(activity.length, MAX_ACTIVITY);
  counters.reçues++;
  if (entry.status === 'écrit') counters.écrites++;
  if (entry.status === 'échec') counters.échecs++;
}

// ── Collecte ──────────────────────────────────────────────────────────────

/** Un bloc réussi porte ses données, un bloc en échec son message. */
export type Block<T> = { ok: true; data: T } | { ok: false; error: string };

async function block<T>(fn: () => Promise<T>): Promise<Block<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export interface Status {
  generatedAt: string;
  healthy: boolean;
  server: {
    startedAt: string;
    uptimeSeconds: number;
    notifications: typeof counters;
    activity: Activity[];
  };
  token: Block<{ valid: boolean; type?: string; neverExpires: boolean; expiresAt: string | null }>;
  subscription: Block<{ active: boolean; callbackUrl?: string; fields: string[]; pageSubscribed: boolean; pointsHere: boolean | null }>;
  sheet: Block<{ title?: string; total: number; rows: LeadRow[] }>;
  meta: Block<{ forms: number; activeForms: number; announced: number; retrievable: number }>;
  sync: Block<{ missing: Array<{ id: string; createdTime?: string; form?: string }> }>;
}

interface AppSubscription {
  object?: string;
  callback_url?: string;
  active?: boolean;
  fields?: Array<{ name?: string }>;
}

/**
 * Les données Meta (jeton, abonnement, formulaires, leads) changent peu et
 * coûtent cher : une app en mode Développement n'a droit qu'à quelques
 * centaines d'appels par heure, et une page restée ouverte les épuisait. Elles
 * sont gardées 5 minutes ; le Sheet, où arrivent les leads, est relu à chaque
 * collecte.
 */
const META_TTL_MS = 5 * 60_000;
let metaCache: { at: number; value: Promise<MetaBlocks> } | undefined;

type MetaBlocks = [Status['token'], Status['subscription'], Block<{ forms: import('./graph.js').LeadForm[]; perForm: Array<{ form: import('./graph.js').LeadForm; leads: import('../types.js').Lead[] }> }>];

/** Lit Meta et le Sheet, puis confronte les deux. */
export async function collectStatus(fresh = false): Promise<Status> {
  const pageId = process.env.META_PAGE_ID ?? '';
  // Sans identifiant, les chemins Graph deviennent « /subscribed_apps » et Meta
  // répond une erreur obscure : on nomme la vraie cause.
  const needPage = () => {
    if (!pageId) throw new Error('META_PAGE_ID absent de la configuration du serveur');
  };
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN ?? '';
  const appSecret = process.env.META_APP_SECRET ?? '';

  // L'App ID n'est pas forcément défini en production : le jeton le connaît.
  const appId = async () =>
    process.env.META_APP_ID || (await graphGet<{ id: string }>('app', { fields: 'id' })).id;

  const readMeta = (): Promise<MetaBlocks> =>
    Promise.all([
    block(async () => {
      if (!appSecret) throw new Error('META_APP_SECRET absent : inspection impossible');
      const info = await debugToken(pageToken, await appId(), appSecret);
      if (info.error) throw new Error(info.error);
      const result: { valid: boolean; type?: string; neverExpires: boolean; expiresAt: string | null } = {
        valid: info.valid,
        neverExpires: info.neverExpires,
        expiresAt: info.expiresAt?.toISOString() ?? null,
      };
      if (info.type) result.type = info.type;
      return result;
    }),

    block(async () => {
      const id = await appId();
      const url = new URL(`https://graph.facebook.com/${process.env.GRAPH_API_VERSION || 'v26.0'}/${id}/subscriptions`);
      url.searchParams.set('access_token', `${id}|${appSecret}`);
      const body = (await (await fetch(url)).json()) as { data?: AppSubscription[]; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message);
      const page = (body.data ?? []).find((s) => s.object === 'page');
      needPage();

      const apps = await graphGet<{ data?: Array<{ id?: string; subscribed_fields?: string[] }> }>(
        `${pageId}/subscribed_apps`
      );
      const mine = (apps.data ?? []).find((a) => a.id === id);

      // Render fournit l'adresse publique du service. Un webhook « actif » qui
      // vise un autre serveur ne livre rien ici : c'est ce que ce test attrape.
      const self = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, '');
      const result: { active: boolean; callbackUrl?: string; fields: string[]; pageSubscribed: boolean; pointsHere: boolean | null } = {
        active: Boolean(page?.active),
        fields: (page?.fields ?? []).map((f) => f.name ?? '').filter(Boolean),
        pageSubscribed: Boolean(mine?.subscribed_fields?.includes('leadgen')),
        pointsHere: self ? page?.callback_url === `${self}/webhook` : null,
      };
      if (page?.callback_url) result.callbackUrl = page.callback_url;
      return result;
    }),

    block(async () => {
      needPage();
      const forms = await listLeadForms(pageId);
      // Seuls les formulaires qui annoncent des leads valent un appel.
      const withLeads = forms.filter((f) => (f.leads_count ?? 0) > 0);
      const perForm = await Promise.all(
        withLeads.map(async (f) => ({ form: f, leads: await fetchFormLeads(f.id) }))
      );
      return { forms, perForm };
    }),
    ]) as Promise<MetaBlocks>;

  if (fresh || !metaCache || Date.now() - metaCache.at > META_TTL_MS) {
    const value = readMeta();
    metaCache = { at: Date.now(), value };
    value.catch(() => (metaCache = undefined));
  }

  const [[token, subscription, metaLeads], sheet] = await Promise.all([
    metaCache.value,
    block(async () => {
      const [access, rows] = await Promise.all([checkAccess(), readLeadRows()]);
      const result: { title?: string; total: number; rows: LeadRow[] } = { total: rows.length, rows };
      if (access.title) result.title = access.title;
      return result;
    }),
  ]);

  const meta: Status['meta'] = metaLeads.ok
    ? {
        ok: true,
        data: {
          forms: metaLeads.data.forms.length,
          activeForms: metaLeads.data.forms.filter((f) => f.status === 'ACTIVE').length,
          announced: metaLeads.data.forms.reduce((n, f) => n + (f.leads_count ?? 0), 0),
          retrievable: metaLeads.data.perForm.reduce((n, p) => n + p.leads.filter((l) => !isTestLead(l)).length, 0),
        },
      }
    : metaLeads;

  let sync: Status['sync'];
  if (!metaLeads.ok) sync = { ok: false, error: `Meta illisible — ${metaLeads.error}` };
  else if (!sheet.ok) sync = { ok: false, error: `Sheet illisible — ${sheet.error}` };
  else {
    const known = new Set(sheet.data.rows.map((r) => r[6]));
    const missing: Array<{ id: string; createdTime?: string; form?: string }> = [];
    const seen = new Set<string>();
    for (const { form, leads } of metaLeads.data.perForm) {
      for (const lead of leads) {
        if (!lead.id || isTestLead(lead) || known.has(lead.id) || seen.has(lead.id)) continue;
        seen.add(lead.id);
        const m: { id: string; createdTime?: string; form?: string } = { id: lead.id };
        if (lead.createdTime) m.createdTime = lead.createdTime;
        if (form.name) m.form = form.name;
        missing.push(m);
      }
    }
    sync = { ok: true, data: { missing } };
  }

  const healthy =
    token.ok && token.data.valid &&
    subscription.ok && subscription.data.active && subscription.data.pageSubscribed &&
    subscription.data.pointsHere !== false &&
    sheet.ok &&
    sync.ok && sync.data.missing.length === 0;

  return {
    generatedAt: new Date().toISOString(),
    healthy,
    server: {
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      notifications: { ...counters },
      activity: [...activity],
    },
    token,
    subscription,
    sheet,
    meta,
    sync,
  };
}

/**
 * Meta et Google limitent le nombre d'appels : une page rechargée en boucle
 * ne doit pas épuiser les quotas. Trente secondes restent du « temps réel »
 * à l'échelle d'un formulaire rempli par un prospect.
 */
const TTL_MS = 30_000;
let cached: { at: number; value: Promise<Status> } | undefined;

export function getStatus(fresh = false): Promise<Status> {
  if (!fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = collectStatus(fresh);
  cached = { at: Date.now(), value };
  // Une collecte ratée ne doit pas rester en cache.
  value.catch(() => (cached = undefined));
  return value;
}

/** Après un lead écrit, la prochaine consultation doit le montrer. */
export function invalidateStatus(): void {
  cached = undefined;
}
