import { requireEnv, optionalEnv } from './env.js';
import type { Lead, TokenInfo } from '../types.js';

const VERSION = optionalEnv('GRAPH_API_VERSION', 'v26.0');
const BASE = `https://graph.facebook.com/${VERSION}`;

/** Paramètres d'une requête Graph : Meta n'accepte que des scalaires. */
export type GraphParams = Record<string, string | number | boolean>;

/** Enveloppe d'erreur renvoyée par la Graph API. */
interface GraphErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    type?: string;
  };
}

/**
 * Traduit un code d'erreur Graph API en explication actionnable.
 *
 * Meta renvoie des messages génériques pour des causes très différentes : un
 * jeton expiré, une permission absente et un mot de passe changé produisent
 * tous « Invalid OAuth access token ». Le code, lui, discrimine.
 *
 * Référence : developers.facebook.com/docs/graph-api/guides/error-handling
 */
export function explainGraphError(code?: number, subcode?: number): string | null {
  if (code === 190) {
    if (subcode === 460) return 'Mot de passe Facebook changé — le jeton a été invalidé. Regénère-le.';
    if (subcode === 463) return "Jeton expiré. Un jeton de Page correct n'expire pas : npm run setup:meta";
    if (subcode === 458) return "L'application n'est plus installée sur ce compte. Réautorise-la.";
    return 'Jeton invalide ou expiré. Regénère-le : npm run setup:meta';
  }
  if (code === 102) return 'Session expirée ou révoquée. Regénère le jeton.';
  if (code === 10) return "Autorisation refusée ou retirée. Recoche les permissions dans l'explorateur d'API.";
  if (code !== undefined && code >= 200 && code <= 299) {
    return 'Permission manquante. Vérifie leads_retrieval, pages_manage_metadata, pages_show_list, pages_read_engagement.';
  }
  if (code === 4) return "Quota de l'application atteint. Patiente avant de réessayer.";
  if (code === 17) return 'Quota par utilisateur atteint. Espace les appels.';
  if (code === 613) return "Trop d'appels. Applique un délai croissant entre les tentatives.";
  if (code === 100) return 'Paramètre invalide — vérifie les identifiants passés à la requête.';
  if (code === 803) return "Objet introuvable, ou ton jeton n'y donne pas accès.";
  return null;
}

let cachedToken: string | undefined;

/** Jeton de Page longue durée, lu une seule fois. */
function token(): string {
  if (!cachedToken) {
    cachedToken = requireEnv(
      'META_PAGE_ACCESS_TOKEN',
      'Jeton de Page longue durée — voir README, workflow Meta'
    );
  }
  return cachedToken;
}

/**
 * Appelle la Graph API et lève une erreur portant le message de Meta plutôt
 * qu'un statut HTTP nu, qui n'indique jamais la cause réelle.
 *
 * Le paramètre de type décrit la réponse attendue : c'est à l'appelant de
 * déclarer ce qu'il lit, la Graph API n'ayant pas de schéma exploitable.
 */
async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  params: GraphParams = {}
): Promise<T> {
  const url = new URL(`${BASE}/${path}`);
  const init: RequestInit = { method };

  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('access_token', token());
  } else {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));
    body.set('access_token', token());
    init.body = body;
  }

  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => ({}))) as T & GraphErrorBody;

  if (!response.ok) {
    const err = payload.error ?? {};
    const hint = explainGraphError(err.code, err.error_subcode);
    throw new Error(
      `Graph API ${response.status} — ${err.message ?? 'erreur inconnue'}` +
      (err.code ? ` (code ${err.code})` : '') +
      (hint ? `\n   → ${hint}` : '')
    );
  }
  return payload;
}

export const graphGet = <T>(path: string, params?: GraphParams): Promise<T> =>
  call<T>('GET', path, params);

export const graphPost = <T>(path: string, params?: GraphParams): Promise<T> =>
  call<T>('POST', path, params);

/**
 * Retrouve l'ID du compte Instagram professionnel rattaché à une Page.
 *
 * Cet ID est distinct de celui de la Page et du @nom d'utilisateur Instagram :
 * c'est lui qu'attendent les endpoints de publication.
 */
export async function resolveInstagramUserId(pageId: string): Promise<string> {
  const explicit = process.env.IG_USER_ID;
  if (explicit) return explicit;

  const page = await graphGet<{ instagram_business_account?: { id?: string } }>(pageId, {
    fields: 'instagram_business_account',
  });
  const igId = page.instagram_business_account?.id;

  if (!igId) {
    throw new Error(
      `Aucun compte Instagram professionnel rattaché à la Page ${pageId}. ` +
      `Vérifie que le compte est en mode Business ou Creator et lié à cette Page.`
    );
  }
  return igId;
}

/** Un lead brut, tel que la Graph API le renvoie. */
interface RawLead {
  id?: string;
  created_time?: string;
  field_data?: Array<{ name?: string; values?: string[] }>;
}

/** Enveloppe d'une collection paginée (une « edge » au vocabulaire de Meta). */
interface Edge<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** Aplatit `field_data` en objet { champ: valeur }. */
function flattenLead(payload: RawLead): Lead {
  const fields: Record<string, string> = {};
  for (const field of payload.field_data ?? []) {
    if (field.name) fields[field.name] = field.values?.[0] ?? '';
  }

  const lead: Lead = { fields };
  if (payload.id) lead.id = payload.id;
  if (payload.created_time) lead.createdTime = payload.created_time;
  return lead;
}

/** Récupère les réponses d'un lead, aplaties en objet { champ: valeur }. */
export async function fetchLead(leadId: string): Promise<Lead> {
  return flattenLead(await graphGet<RawLead>(leadId, { fields: 'id,created_time,field_data' }));
}

/**
 * Garde-fou : au-delà, on considère qu'on boucle sur un curseur qui n'avance
 * pas plutôt que de parcourir une collection réellement immense.
 */
const MAX_PAGES = 200;

/**
 * Parcourt une collection paginée jusqu'au bout.
 *
 * Meta plafonne silencieusement `limit` (souvent à 25 pour les leads, quelle
 * que soit la valeur demandée) : lire une seule page donne un résultat
 * tronqué sans le moindre avertissement. Seule la présence de `paging.next`
 * indique qu'il reste des éléments.
 */
export async function graphGetAll<T>(
  path: string,
  params: GraphParams = {},
  pageSize = 100
): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const query: GraphParams = { ...params, limit: pageSize };
    if (after) query.after = after;

    const body = await graphGet<Edge<T>>(path, query);
    items.push(...(body.data ?? []));

    if (!body.paging?.next) return items;
    after = body.paging.cursors?.after;
    // Sans curseur, poursuivre renverrait indéfiniment la même page.
    if (!after) return items;
  }
  return items;
}

/** Un formulaire Instant Form, réduit aux champs que l'on affiche. */
export interface LeadForm {
  id: string;
  name?: string;
  status?: string;
  leads_count?: number;
  created_time?: string;
}

/** Liste tous les Instant Forms de la Page (un jeton de Page suffit). */
export function listLeadForms(pageId: string): Promise<LeadForm[]> {
  return graphGetAll<LeadForm>(`${pageId}/leadgen_forms`, {
    fields: 'id,name,status,leads_count,created_time',
  });
}

/**
 * Récupère tous les leads d'un formulaire, du plus récent au plus ancien.
 *
 * Meta conserve les leads 90 jours pour les formulaires publicitaires : au
 * delà, l'historique n'est plus récupérable par aucun moyen, ni ici ni via un
 * outil tiers.
 */
export async function fetchFormLeads(formId: string): Promise<Lead[]> {
  const raw = await graphGetAll<RawLead>(`${formId}/leads`, {
    fields: 'id,created_time,field_data',
  });
  return raw.map(flattenLead);
}

/**
 * Inspecte un jeton via /debug_token : type, validité, expiration, permissions.
 *
 * C'est le seul moyen de savoir *pourquoi* un jeton ne marche pas. Un jeton
 * expiré, un jeton utilisateur employé là où un jeton de Page est attendu et
 * une permission manquante produisent tous des erreurs différentes mais
 * également opaques côté appelant.
 *
 * Nécessite l'App ID et l'App Secret, qui servent ici de jeton applicatif.
 */
export async function debugToken(
  inputToken: string,
  appId: string,
  appSecret: string
): Promise<TokenInfo> {
  const url = new URL('https://graph.facebook.com/debug_token');
  url.searchParams.set('input_token', inputToken);
  url.searchParams.set('access_token', `${appId}|${appSecret}`);

  const response = await fetch(url);
  const payload = (await response.json()) as GraphErrorBody & {
    data?: {
      is_valid?: boolean;
      type?: string;
      app_id?: string;
      expires_at?: number;
      scopes?: string[];
      error?: { message?: string };
    };
  };

  if (!response.ok) {
    throw new Error(payload.error?.message ?? `debug_token a échoué (${response.status})`);
  }

  const d = payload.data ?? {};
  // expires_at à 0 ou absent signifie « n'expire pas » : c'est la marque des
  // jetons de Page issus d'un jeton utilisateur longue durée.
  const neverExpires = !d.expires_at;

  const info: TokenInfo = {
    valid: Boolean(d.is_valid),
    neverExpires,
    expiresAt: neverExpires ? null : new Date((d.expires_at ?? 0) * 1000),
    scopes: d.scopes ?? [],
  };
  if (d.type) info.type = d.type;
  if (d.app_id) info.appId = d.app_id;
  if (d.error?.message) info.error = d.error.message;
  return info;
}

/** Une question d'Instant Form, avec ses choix possibles. */
export interface FormQuestion {
  key: string;
  label?: string;
  type?: string;
  options?: Array<{ key: string; value: string }>;
}

export interface FormDetail {
  id: string;
  name?: string;
  status?: string;
  questions?: FormQuestion[];
}

// Un formulaire ne change pas d'une consultation à l'autre : inutile de le
// relire pour chaque lead affiché.
const formCache = new Map<string, Promise<FormDetail>>();

export function fetchFormDetail(formId: string): Promise<FormDetail> {
  let hit = formCache.get(formId);
  if (!hit) {
    hit = graphGet<FormDetail>(formId, { fields: 'id,name,status,questions' });
    hit.catch(() => formCache.delete(formId));
    formCache.set(formId, hit);
  }
  return hit;
}

/** Libellés français des questions standards, que Meta renvoie en anglais. */
const STANDARD_LABELS: Record<string, string> = {
  FULL_NAME: 'Nom complet',
  FIRST_NAME: 'Prénom',
  LAST_NAME: 'Nom',
  EMAIL: 'E-mail',
  PHONE: 'Téléphone',
  COMPANY_NAME: 'Entreprise',
  JOB_TITLE: 'Poste',
  CITY: 'Ville',
  ZIP: 'Code postal',
  STREET_ADDRESS: 'Adresse',
  WORK_EMAIL: 'E-mail professionnel',
  WORK_PHONE_NUMBER: 'Téléphone professionnel',
};

export interface LeadAnswer {
  question: string;
  answer: string;
  type?: string;
}

export interface LeadDetail {
  id: string;
  createdTime?: string;
  platform?: string;
  isOrganic?: boolean;
  form?: { id: string; name?: string; status?: string };
  campaign?: string;
  adset?: string;
  ad?: string;
  answers: LeadAnswer[];
}

interface RawLeadDetail {
  id: string;
  created_time?: string;
  field_data?: Array<{ name?: string; values?: string[] }>;
  form_id?: string;
  platform?: string;
  is_organic?: boolean;
  campaign_name?: string;
  adset_name?: string;
  ad_name?: string;
}

/**
 * Détail complet d'un lead : chaque réponse accompagnée du libellé de sa
 * question et, pour les choix multiples, du libellé du choix plutôt que de sa
 * clé technique (`chef_d'entreprise` → « Chef d'entreprise »).
 */
export async function fetchLeadDetail(leadId: string): Promise<LeadDetail> {
  const raw = await graphGet<RawLeadDetail>(leadId, {
    fields: 'id,created_time,field_data,form_id,platform,is_organic,campaign_name,adset_name,ad_name',
  });

  const form = raw.form_id ? await fetchFormDetail(raw.form_id).catch(() => undefined) : undefined;
  const byKey = new Map((form?.questions ?? []).map((q) => [q.key, q]));

  const answers = (raw.field_data ?? []).map((f): LeadAnswer => {
    const q = f.name ? byKey.get(f.name) : undefined;
    const values = (f.values ?? []).map((v) => q?.options?.find((o) => o.key === v)?.value ?? v);
    const question =
      (q?.type && STANDARD_LABELS[q.type]) || q?.label || (f.name ?? '').replace(/_/g, ' ');
    const answer: LeadAnswer = { question, answer: values.join(', ') };
    if (q?.type) answer.type = q.type;
    return answer;
  });

  const detail: LeadDetail = { id: raw.id, answers };
  if (raw.created_time) detail.createdTime = raw.created_time;
  if (raw.platform) detail.platform = raw.platform;
  if (raw.is_organic !== undefined) detail.isOrganic = raw.is_organic;
  if (raw.form_id) {
    detail.form = { id: raw.form_id };
    if (form?.name) detail.form.name = form.name;
    if (form?.status) detail.form.status = form.status;
  }
  if (raw.campaign_name) detail.campaign = raw.campaign_name;
  if (raw.adset_name) detail.adset = raw.adset_name;
  if (raw.ad_name) detail.ad = raw.ad_name;
  return detail;
}
