/**
 * Diagnostic complet de la configuration.
 *
 * Chaque test est indépendant et non bloquant : le rapport va au bout même si
 * une étape échoue, pour montrer tout ce qui reste à faire en une seule fois.
 */
import 'dotenv/config';
import { errorMessage } from './lib/env.js';

const ok = (m: string): void => console.log(`  ✅ ${m}`);
const ko = (m: string): void => console.log(`  ❌ ${m}`);
const skip = (m: string): void => console.log(`  ⏭️  ${m}`);
const info = (m: string): void => console.log(`     ${m}`);

/**
 * Autorisations nécessaires au fonctionnement quotidien.
 *
 * Leur absence casse une fonctionnalité : sans `leads_retrieval` aucun lead
 * n'est lisible, sans `pages_manage_metadata` la Page ne peut pas s'abonner
 * au webhook.
 */
const RUNTIME_SCOPES: Record<string, string> = {
  leads_retrieval: 'lecture des leads',
  pages_manage_metadata: 'abonnement de la Page au webhook',
  pages_read_engagement: 'lecture de la Page',
};

/**
 * Autorisations utiles seulement à la configuration initiale.
 *
 * `pages_show_list` ne sert qu'à l'appel /me/accounts de setup-meta, qui
 * découvre la Page et récupère son jeton. Une fois ce jeton obtenu — et il
 * n'expire pas — elle ne sert plus à rien.
 */
const SETUP_SCOPES: Record<string, string> = {
  pages_show_list: 'découverte de la Page (npm run setup:meta)',
};

console.log('\n── Diagnostic ──────────────────────────────────────────\n');

// --- Google Sheets ----------------------------------------------------------
console.log('Google Sheets');

const hasCreds =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!hasCreds) {
  ko('identifiants du compte de service absents');
  info('Renseigne GOOGLE_SERVICE_ACCOUNT_JSON ou GOOGLE_APPLICATION_CREDENTIALS');
} else if (!process.env.GOOGLE_SPREADSHEET_ID) {
  ko('GOOGLE_SPREADSHEET_ID absent');
  info("L'ID se trouve dans l'URL du Sheet, entre /d/ et /edit");
} else {
  try {
    const { serviceAccountEmail, checkAccess } = await import('./lib/sheets.js');
    ok(`compte de service : ${serviceAccountEmail()}`);

    const { title, tabs } = await checkAccess();
    ok(`Sheet accessible : « ${title ?? 'sans titre'} »`);
    info(`Onglets : ${tabs.join(', ')}`);

    const wanted = (process.env.GOOGLE_SHEET_RANGE ?? 'Leads!A:G').split('!')[0] ?? 'Leads';
    if (tabs.includes(wanted)) ok(`onglet « ${wanted} » présent`);
    else {
      ko(`onglet « ${wanted} » introuvable`);
      info(`Crée-le, ou ajuste GOOGLE_SHEET_RANGE`);
    }
  } catch (err) {
    const message = errorMessage(err);
    ko(message);
    if (/permission|forbidden|403/i.test(message)) {
      info("Partage le Sheet avec l'adresse du compte de service (droit Éditeur).");
    }
  }
}

// --- Meta -------------------------------------------------------------------
console.log('\nMeta');

const pageToken = process.env.META_PAGE_ACCESS_TOKEN;
const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;

if (!pageToken) {
  ko('META_PAGE_ACCESS_TOKEN absent');
  info('Lance : npm run setup:meta');
} else {
  try {
    const { graphGet, resolveInstagramUserId, debugToken } = await import('./lib/graph.js');

    // Inspecter le jeton d'abord : c'est ce qui explique la plupart des pannes,
    // et un jeton court qui vient d'expirer produit sinon une erreur opaque.
    if (appId && appSecret) {
      try {
        const t = await debugToken(pageToken, appId, appSecret);

        if (!t.valid) {
          ko(`jeton invalide — ${t.error ?? 'raison inconnue'}`);
          info('Régénère-le : npm run setup:meta');
        } else if (t.neverExpires) {
          ok(`jeton de type ${t.type ?? 'inconnu'} — n'expire pas`);
        } else if (t.expiresAt) {
          const restant = Math.round((t.expiresAt.getTime() - Date.now()) / 86_400_000);
          if (restant < 0) {
            ko(`jeton EXPIRÉ depuis ${-restant} jour(s)`);
            info('Régénère-le : npm run setup:meta');
          } else if (restant < 2) {
            ko(`jeton expirant dans moins de 2 jours — c'est un jeton court`);
            info("Un jeton de Page correct n'expire jamais.");
            info('Régénère-le : npm run setup:meta');
          } else {
            ok(`jeton valide encore ${restant} jour(s)`);
          }
        }

        if (t.valid && t.type && t.type !== 'PAGE') {
          ko(`jeton de type ${t.type} au lieu de PAGE`);
          info('Un jeton utilisateur ne permet ni de lire les leads ni de publier.');
        }

        if (t.valid) {
          const manquantes = Object.keys(RUNTIME_SCOPES).filter((r) => !t.scopes.includes(r));
          if (manquantes.length) {
            ko(`autorisations manquantes : ${manquantes.join(', ')}`);
            manquantes.forEach((m) => info(`${m} → ${RUNTIME_SCOPES[m]}`));
          } else {
            ok('autorisations de fonctionnement présentes');
          }

          // Distinguées des précédentes : leur absence n'empêche rien de
          // tourner, seulement de relancer la configuration.
          const setup = Object.keys(SETUP_SCOPES).filter((r) => !t.scopes.includes(r));
          if (setup.length) {
            skip(`absentes mais sans effet à l'usage : ${setup.join(', ')}`);
            setup.forEach((m) => info(`${m} → ${SETUP_SCOPES[m]}`));
          }
        }
      } catch (err) {
        info(`inspection du jeton impossible : ${errorMessage(err)}`);
      }
    } else {
      skip('META_APP_ID ou META_APP_SECRET absents — inspection du jeton impossible');
    }

    const me = await graphGet<{ id?: string; name?: string }>('me', { fields: 'id,name' });
    ok(`jeton actif — Page « ${me.name ?? '?'} » (${me.id ?? '?'})`);

    const pageId = process.env.META_PAGE_ID ?? me.id;
    if (!process.env.META_PAGE_ID) info(`META_PAGE_ID absent, déduit du jeton : ${pageId}`);

    if (pageId) {
      try {
        ok(`compte Instagram professionnel : ${await resolveInstagramUserId(pageId)}`);
      } catch (err) {
        ko(errorMessage(err));
      }

      try {
        const subs = await graphGet<{ data?: Array<{ subscribed_fields?: string[] }> }>(
          `${pageId}/subscribed_apps`
        );
        const fields = subs.data?.flatMap((a) => a.subscribed_fields ?? []) ?? [];
        if (fields.includes('leadgen')) ok('Page abonnée au champ leadgen');
        else {
          ko('Page non abonnée au champ leadgen');
          info(`POST /${pageId}/subscribed_apps?subscribed_fields=leadgen`);
          info('Sans cet abonnement, aucun lead ne parviendra jamais au serveur.');
        }
      } catch (err) {
        ko(`abonnement invérifiable — ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    ko(errorMessage(err));
  }
}

// --- Webhook ----------------------------------------------------------------
console.log('\nWebhook');
if (process.env.META_VERIFY_TOKEN) ok('META_VERIFY_TOKEN défini');
else ko('META_VERIFY_TOKEN absent — la vérification par Meta échouera');

if (appSecret) ok('META_APP_SECRET défini — requêtes authentifiées');
else skip("META_APP_SECRET absent — le serveur acceptera n'importe quelle requête");

console.log('\n── Fin du diagnostic ───────────────────────────────────\n');
