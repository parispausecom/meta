# Automatisation Meta — Instagram & Leads Instant Forms

Deux workflows, sans intermédiaire OAuth :

1. **Publication Instagram** — publier une image ou un carrousel sur un compte professionnel.
2. **Leads → Google Sheets** — recevoir les leads des Instant Forms en temps réel par webhook, et écrire une ligne par lead dans un Google Sheet.

## Architecture

```
[Instant Form soumis]
      │  webhook Graph API (champ "leadgen")
      ▼
   server.js ──(Graph API)──> détail du lead
      │
      └──(compte de service)──> Google Sheet

post-to-instagram.js ──(Graph API)──> publication
```

Deux identifiants suffisent à tout faire fonctionner : un **jeton de Page Meta
longue durée** (qui n'expire pas) et un **compte de service Google**. Aucun flux
OAuth, aucun navigateur, aucun jeton à rafraîchir.

Meta n'envoie dans le webhook que **l'ID** du lead, jamais ses données : le
serveur rappelle la Graph API pour récupérer les champs du formulaire.

## Installation

```bash
npm install
cp .env.example .env   # puis renseigne les valeurs
npm run doctor         # vérifie toute la configuration d'un coup
```

Node 20+ requis.

## Stack

TypeScript en mode `strict`, exécuté par [tsx](https://tsx.is) en développement
et compilé par `tsc` pour la production.

| Commande | Rôle |
|---|---|
| `npm run typecheck` | vérifie les types sans rien produire |
| `npm run build` | compile vers `dist/` |
| `npm test` | 24 tests |
| `npm start` | démarre le serveur compilé |
| `npm run dev` | serveur en rechargement automatique |
| `npm run audit` | audit des accès Meta → rapport HTML ouvert dans le navigateur |
| `npm run status` | état de la production en direct, dans le terminal |
| `npm run dashboard` | ouvre le tableau de bord de production |

Arborescence :

```
src/
  types.ts        types partagés
  lib/env.ts      variables d'environnement, gestion d'erreurs CLI
  lib/graph.ts    appels Graph API, traduction des codes d'erreur Meta
  lib/sheets.ts   compte de service Google, écriture dans le Sheet
  lib/leads.ts    mise en forme d'un lead en ligne, dédoublonnage
  server.ts       webhook
  backfill.ts     import de l'historique des leads
  doctor.ts       diagnostic
  setup-meta.ts   configuration Meta automatisée
  post-to-instagram.ts
test/
```

Options notables du `tsconfig` : `noUncheckedIndexedAccess` et
`exactOptionalPropertyTypes`. La première force à traiter les accès par index
comme potentiellement absents — utile ici, où presque toutes les données
viennent d'API externes dont rien ne garantit la forme.

## Configuration

### Google Sheets — compte de service

1. Dans [Google Cloud Console](https://console.cloud.google.com), crée un projet.
2. Active l'**API Google Sheets**.
3. Crée un **compte de service**, puis une clé au format JSON. Télécharge-la.
4. **Partage le Sheet** avec l'adresse du compte de service
   (`…@….iam.gserviceaccount.com`), en droit **Éditeur**. Décoche « Prévenir les
   personnes » : un compte de service n'a pas de boîte mail.
5. Renseigne les identifiants, au choix :
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — le JSON complet sur une ligne (hébergement) ;
   - `GOOGLE_APPLICATION_CREDENTIALS` — le chemin du fichier (local).

C'est le partage du fichier qui donne l'accès, pas une autorisation globale : le
compte de service ne voit que ce que tu lui partages explicitement.

### Meta — configuration automatisée

Une seule commande enchaîne tout ce qui se faisait à la main :

```bash
npm run setup:meta
```

Elle échange le jeton court contre un jeton de Page **qui n'expire pas**, résout
le compte Instagram rattaché, abonne la Page au champ `leadgen`, et écrit
`META_PAGE_ACCESS_TOKEN`, `META_PAGE_ID` et `IG_USER_ID` dans `.env` (l'ancien
fichier est sauvegardé dans `.env.backup`).

Prérequis : `META_APP_ID` et `META_APP_SECRET` dans `.env`, plus un jeton court
généré dans l'[explorateur d'API Graph](https://developers.facebook.com/tools/explorer/)
en cochant les cinq autorisations. C'est le seul geste manuel restant, et il
n'est à refaire que si le jeton de Page est révoqué.

> **Si « ça bugge » sans cesse**, c'est presque toujours un jeton court utilisé
> comme jeton de Page : il expire au bout d'une heure. `npm run doctor` affiche
> désormais le type du jeton, sa date d'expiration et ses autorisations, ce qui
> rend la panne immédiatement lisible.

### Meta — détail des échanges (pour référence)

Le jeton copié depuis l'explorateur d'API ne vaut qu'une heure. Il faut deux
échanges pour obtenir un jeton de Page qui n'expire pas :

```bash
# a. Jeton utilisateur longue durée (60 jours)
GET https://graph.facebook.com/v26.0/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id=APP_ID&client_secret=APP_SECRET
  &fb_exchange_token=JETON_COURT

# b. Jetons de Page — ceux-là n'expirent pas
GET https://graph.facebook.com/v26.0/me/accounts
  ?access_token=JETON_LONGUE_DUREE
```

Autorisations requises : `leads_retrieval`, `pages_manage_metadata`,
`pages_show_list`, `pages_read_engagement`, `ads_management`.

## Tests

```bash
npm test      # 14 tests : mise en forme des leads + surface HTTP du webhook
```

Les tests d'intégration démarrent réellement le serveur sur un port aléatoire et
vérifient la vérification Meta, le rejet des signatures invalides et le fait que
l'accusé de réception parte avant tout traitement.

## Workflow 1 — Publier sur Instagram

**Ce script ne publie rien par défaut.** Il faut `--publish` pour toucher au
compte réel :

```bash
npm run post        # vérifications seules, aucune publication
npm run post:live   # vérifie puis publie
```

Les vérifications de contenu (légende, images) tournent **sans aucun accès
Meta** : tu peux valider tes visuels avant même d'avoir configuré le jeton.
Chaque URL d'image est testée pour sa disponibilité publique, son type MIME et
son poids — c'est la première cause d'échec de publication, Meta téléchargeant
les images depuis ses propres serveurs sans aucune authentification.

Édite les constantes en haut de [post-to-instagram.js](post-to-instagram.js) :
`IMAGE_URL`, `CAPTION`, ou `CAROUSEL_URLS` (2 à 10 images).

- Les URLs d'images doivent être **publiques** : Meta les télécharge depuis ses serveurs.
- Plafond de **100 publications par 24 h glissantes**, un carrousel comptant pour une.
- Le compte Instagram doit être **Business ou Creator** et lié à la Page.

## Workflow 2 — Leads Instant Forms → Google Sheets

### Préparer le Sheet

Un onglet `Leads` avec les en-têtes : `Date | Nom | Email | Téléphone | ID Lead`.

### Déployer le serveur

Le webhook exige une URL **HTTPS publique** :

```bash
npm start                      # port 3000
npx localtunnel --port 3000    # ou ngrok http 3000
```

En production : Render, Railway ou Fly.io, avec les mêmes variables d'environnement.

### Déclarer le webhook

Dans le Dashboard Meta : produit **Webhooks** → objet **Page** → champ **leadgen**.

- **URL de rappel** : `https://ton-domaine/webhook`
- **Token de vérification** : la valeur de `META_VERIFY_TOKEN`

### Abonner la Page à l'application

Étape indispensable, absente de l'interface :

```bash
POST https://graph.facebook.com/v26.0/<PAGE_ID>/subscribed_apps
  ?subscribed_fields=leadgen&access_token=<JETON_DE_PAGE>
```

Sans elle, tout paraît configuré, la vérification passe, et **aucun lead
n'arrive jamais**. `npm run doctor` vérifie ce point.

### Tester

L'[outil de test des leads](https://developers.facebook.com/tools/lead-ads-testing)
soumet un formulaire factice. Une ligne doit apparaître dans le Sheet.

### Récupérer l'historique

Le webhook ne voit que les leads déposés après sa mise en service. Pour les
autres, `npm run backfill` parcourt tous les Instant Forms de la Page, lit
leurs leads et complète le Sheet. Il compare les identifiants déjà présents
dans la colonne G avant d'écrire : le relancer ne crée pas de doublon.

```bash
npm run backfill                 # complète le Sheet
npm run backfill -- --dry-run    # affiche ce qui serait écrit, n'écrit rien
npm run backfill -- --csv=leads.csv   # exporte sans passer par Sheets
npm run backfill -- --form=1137253001921392   # un seul formulaire
```

Un jeton de Page suffit, `leads_retrieval` compris — aucun outil tiers n'est
nécessaire. **Meta ne conserve les leads que 90 jours** : le compteur
`leads_count` d'un formulaire continue d'annoncer les plus anciens, mais
l'API ne les renvoie plus et rien ne permet de les récupérer. C'est la seule
vraie raison de mettre le webhook en service sans tarder.

## Auditer ce que les jetons permettent

`npm run audit` interroge une à une toutes les ressources que l'app pourrait
vouloir lire — Page, Instagram, leads, messagerie, publicité, Business Manager —
et écrit `audit-meta.html`, un rapport autonome ouvert dans le navigateur : pour
chaque ressource, la réponse brute quand elle passe, le message d'erreur exact
quand elle refuse, et en fin de page la liste de ce qui reste inaccessible avec
l'autorisation qui manque.

```bash
npm run audit                      # rapport + ouverture du navigateur
npm run audit -- --no-open         # rapport seul
npm run audit -- --out=/tmp/a.html # autre destination
```

Toutes les sondes sont des `GET` : rien n'est modifié côté Meta. Les jetons sont
masqués dans le rapport, mais celui-ci contient des données personnelles (leads,
conversations) — il est exclu du dépôt par `.gitignore`.

## Suivre la production

`https://pausecom-meta-webhook.onrender.com/dashboard` affiche en direct la santé de la
chaîne (jeton, abonnement Meta, Sheet, concordance Meta ↔ Sheet), les chiffres
clés, les leads par mois, l'activité du webhook depuis le démarrage et les
derniers leads. La page interroge Meta et le Sheet à chaque visite, avec un
cache de 30 s ; `Actualiser maintenant` l'ignore.

Elle contient des données personnelles : elle exige l'identifiant
`DASHBOARD_USER` (par défaut `pausecom`) et le mot de passe `DASHBOARD_PASSWORD`,
à définir à l'identique dans `.env` et sur Render. Sans mot de passe, la page
reste fermée.

```bash
npm run dashboard            # ouvre la page dans le navigateur
npm run dashboard:password   # copie le mot de passe dans le presse-papiers
npm run status               # même état, dans le terminal
npm run status -- --fresh    # sans le cache de 30 s
npm run status -- --json     # réponse brute de /api/status
```

`npm run status` sort en erreur (code 1) si un contrôle échoue : il peut servir
de sonde dans une tâche planifiée.

Le webhook consulte le Sheet avant chaque écriture : un lead déjà présent
n'est pas réécrit, même après un redémarrage du serveur.

## Synchronisation planifiée (GitHub Actions)

[.github/workflows/sync-leads.yml](.github/workflows/sync-leads.yml) sert de
filet de sécurité au webhook. Toutes les 10 minutes, il lance
`npm run backfill`, qui n'ajoute au Sheet que les leads absents, puis
`npm run status`, qui vérifie la production. Si un contrôle est au rouge,
l'exécution échoue et GitHub prévient par e-mail. Un lead manqué par le
webhook (service endormi, Meta qui ne livre pas) arrive donc dans le Sheet en
une dizaine de minutes.

Configuration, dans *Settings → Secrets and variables → Actions* du dépôt :

| Secret | Variable |
|---|---|
| `META_PAGE_ACCESS_TOKEN` | `META_PAGE_ID` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `GRAPH_API_VERSION` |
| `GOOGLE_SPREADSHEET_ID` | `GOOGLE_SHEET_RANGE` |
| `DASHBOARD_PASSWORD` | `PROD_URL` |

```bash
gh workflow run sync-leads.yml   # lancer une synchronisation tout de suite
gh run list --workflow=sync-leads.yml --limit 5
gh run watch                     # suivre l'exécution en cours
```

Le dépôt est public : ses minutes Actions sont gratuites et illimitées. S'il
redevenait privé, repasser à 30 minutes, sans quoi le quota de 2 000 minutes
du compte, partagé avec la synchro Notion de `newsletter-backend`, serait
dépassé. GitHub peut retarder une tâche planifiée de quelques minutes aux
heures chargées.

Après un renouvellement du jeton de Page, le secret `META_PAGE_ACCESS_TOKEN`
doit être mis à jour ici comme sur Render.

## Endpoints du serveur

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/webhook` | vérification de l'abonnement par Meta |
| `POST` | `/webhook` | réception des leads |
| `GET` | `/health` | contrôle de disponibilité |
| `GET` | `/` | redirige vers `/dashboard` |
| `GET` | `/dashboard` | tableau de bord (authentification) |
| `GET` | `/api/status` | état en JSON (authentification) — 503 si un contrôle échoue |

## Notes d'implémentation

- **Signature** — chaque `POST` est authentifié via `X-Hub-Signature-256` (HMAC-SHA256
  sur le corps brut, comparé en temps constant). Sans `META_APP_SECRET`, le serveur
  démarre mais **accepte n'importe quelle requête**.
- **Acquittement immédiat** — réponse `200` avant traitement : Meta considère la
  livraison échouée au-delà de quelques secondes et réessaie.
- **Doublons** — les IDs traités sont mémorisés en RAM. Cette mémoire est perdue au
  redémarrage et n'est pas partagée entre instances : pour un déploiement
  multi-instances, la remplacer par Redis ou une contrainte d'unicité en base.
- **Noms des champs** — `toRow()` teste plusieurs variantes usuelles (`full_name`,
  `email`, `phone_number`, et des libellés français). Ajoute les tiens si ton
  formulaire utilise des libellés personnalisés.

## Dépannage

Lance `npm run doctor` en premier : il teste tout et va au bout du rapport.

| Symptôme | Cause probable |
|---|---|
| Aucun lead reçu | la Page n'est pas abonnée au champ `leadgen` |
| Vérification en 403 | `META_VERIFY_TOKEN` différent de celui saisi chez Meta |
| `POST /webhook` en 401 | `META_APP_SECRET` ne correspond pas à l'app émettrice |
| `Invalid OAuth access token` | jeton court non échangé, ou lié à une autre Page |
| Erreur 403 sur le Sheet | Sheet non partagé avec le compte de service |
| `invalid_grant` | clé du compte de service invalide ou projet supprimé |
| Publication refusée | compte encore personnel, ou image non publique |

`DEBUG=1` devant toute commande donne la trace complète.
