import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { requireEnv, optionalEnv, errorMessage } from './env.js';
import type { LeadRow, ServiceAccountKey, SheetAccess } from '../types.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DEFAULT_RANGE = 'Leads!A:G';
/** Index de la colonne « identifiant » dans LeadRow. */
const ID_COLUMN = 6;

/** Forme du fichier JSON téléchargé depuis Google Cloud. */
interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
}

/** Réponses de l'API Sheets, réduites aux champs que l'on lit. */
interface AppendResponse {
  updates?: { updatedRange?: string; updatedRows?: number };
}

interface ValuesResponse {
  values?: string[][];
}

interface SpreadsheetResponse {
  properties?: { title?: string };
  sheets?: Array<{ properties?: { title?: string } }>;
}

/**
 * Charge les identifiants du compte de service.
 *
 * Deux sources possibles : le JSON complet dans une variable d'environnement
 * (pratique en hébergement, où déposer un fichier est pénible), ou un chemin
 * vers le fichier téléchargé depuis Google Cloud (pratique en local).
 */
function credentials(): ServiceAccountKey {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  let raw: string;
  if (inline) {
    raw = inline;
  } else if (path) {
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`Fichier de compte de service illisible (${path}) : ${errorMessage(err)}`);
    }
  } else {
    console.error(`Identifiants du compte de service manquants.`);
    console.error(`  → Renseigne GOOGLE_SERVICE_ACCOUNT_JSON (le JSON complet)`);
    console.error(`    ou GOOGLE_APPLICATION_CREDENTIALS (chemin du fichier .json)`);
    process.exit(1);
  }

  let parsed: ServiceAccountJson;
  try {
    parsed = JSON.parse(raw) as ServiceAccountJson;
  } catch {
    throw new Error(
      `Identifiants du compte de service illisibles : le contenu n'est pas du JSON valide.`
    );
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      `JSON de compte de service incomplet : client_email ou private_key absent.`
    );
  }

  return {
    email: parsed.client_email,
    // Stockée en variable d'environnement, la clé contient souvent des "\n"
    // littéraux au lieu de vrais retours à la ligne, que PEM refuse.
    key: parsed.private_key.replace(/\\n/g, '\n'),
  };
}

let client: JWT | undefined;

function auth(): JWT {
  if (!client) {
    const { email, key } = credentials();
    client = new JWT({ email, key, scopes: SCOPES });
  }
  return client;
}

/** Adresse du compte de service, à qui le Sheet doit être partagé. */
export function serviceAccountEmail(): string {
  return credentials().email;
}

/** Extrait le message d'erreur que renvoie l'API Google, s'il existe. */
function googleError(err: unknown): string {
  const response = (err as { response?: { data?: { error?: { message?: string } } } }).response;
  return response?.data?.error?.message ?? errorMessage(err);
}

/**
 * Ajoute des lignes à la fin de la plage indiquée.
 *
 * USER_ENTERED laisse Google interpréter les valeurs comme une saisie manuelle
 * (les dates deviennent des dates), et INSERT_ROWS insère plutôt que d'écraser
 * d'éventuelles lignes situées sous la plage.
 */
export async function appendRows(rows: LeadRow[]): Promise<AppendResponse> {
  const spreadsheetId = requireEnv('GOOGLE_SPREADSHEET_ID', "L'ID présent dans l'URL du Sheet");
  const range = optionalEnv('GOOGLE_SHEET_RANGE', DEFAULT_RANGE);

  const url =
    `${API}/${spreadsheetId}/values/${encodeURIComponent(range)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  try {
    const { data } = await auth().request<AppendResponse>({
      url,
      method: 'POST',
      data: { values: rows },
    });
    return data;
  } catch (err) {
    throw new Error(`Écriture dans le Sheet impossible — ${googleError(err)}`);
  }
}

/** Ajoute une ligne unique. */
export const appendRow = (row: LeadRow): Promise<AppendResponse> => appendRows([row]);

/**
 * Identifiants des leads déjà présents dans la feuille.
 *
 * C'est la seule protection contre les doublons : un import complet et le
 * webhook écrivent au même endroit, et Meta réémet un webhook tant qu'il n'a
 * pas reçu de 200. L'identifiant occupe la dernière colonne de `LeadRow`.
 */
export async function existingLeadIds(): Promise<Set<string>> {
  const spreadsheetId = requireEnv('GOOGLE_SPREADSHEET_ID');
  const range = optionalEnv('GOOGLE_SHEET_RANGE', DEFAULT_RANGE);

  try {
    const { data } = await auth().request<ValuesResponse>({
      url: `${API}/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    });

    const ids = new Set<string>();
    for (const row of data.values ?? []) {
      const id = row[ID_COLUMN];
      if (id) ids.add(id);
    }
    return ids;
  } catch (err) {
    throw new Error(`Lecture du Sheet impossible — ${googleError(err)}`);
  }
}

/** Vérifie que le compte de service peut bien lire le Sheet ciblé. */
export async function checkAccess(): Promise<SheetAccess> {
  const spreadsheetId = requireEnv('GOOGLE_SPREADSHEET_ID');

  const { data } = await auth().request<SpreadsheetResponse>({
    url: `${API}/${spreadsheetId}?fields=properties.title,sheets.properties.title`,
  });

  const access: SheetAccess = {
    tabs: (data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t)),
  };
  if (data.properties?.title) access.title = data.properties.title;
  return access;
}
