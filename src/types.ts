/** Types partagés entre les modules du projet. */

/** Un lead tel que renvoyé par la Graph API, une fois ses champs aplatis. */
export interface Lead {
  id?: string;
  createdTime?: string;
  fields?: Record<string, string>;
}

/**
 * Une ligne de tableur.
 *
 * Colonnes : date, nom, email, téléphone, entreprise, profil, identifiant.
 * `entreprise` et `profil` viennent des formulaires Pausecom, qui demandent
 * `company_name` et « vous_êtes_? » mais pas d'adresse email.
 */
export type LeadRow = [string, string, string, string, string, string, string];

/** Identifiants extraits du JSON de compte de service Google. */
export interface ServiceAccountKey {
  email: string;
  key: string;
}

/** Résultat de l'inspection d'un jeton via /debug_token. */
export interface TokenInfo {
  valid: boolean;
  type?: string;
  appId?: string;
  neverExpires: boolean;
  expiresAt: Date | null;
  scopes: string[];
  error?: string;
}

/** Ce que le compte de service voit du Sheet ciblé. */
export interface SheetAccess {
  title?: string;
  tabs: string[];
}

/** Charge utile d'un webhook leadgen envoyé par Meta. */
export interface LeadgenValue {
  leadgen_id?: string;
  form_id?: string;
  page_id?: string;
}

export interface WebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: LeadgenValue & { item?: string; verb?: string } }>;
    /** Messenger et Instagram Direct livrent leurs messages ici. */
    messaging?: unknown[];
  }>;
}
