#!/usr/bin/env bash
# Ouvre les pages Meta utiles au projet.
#
# Les identifiants viennent de .env : si tu changes d'application ou de Business,
# il n'y a rien à modifier ici.
#
# Usage : npm run meta            (liste les raccourcis)
#         npm run meta explorer   (explorateur d'API)
set -euo pipefail
cd "$(dirname "$0")/.."

get() { grep -E "^$1=" .env 2>/dev/null | cut -d= -f2- || true; }

APP=$(get META_APP_ID)
BIZ=590017232734195
PAGE=$(get META_PAGE_ID)

case "${1:-}" in
  explorer)  URL="https://developers.facebook.com/tools/explorer/?app_id=$APP" ;;
  app)       URL="https://developers.facebook.com/apps/$APP/settings/basic/" ;;
  roles)     URL="https://developers.facebook.com/apps/$APP/roles/roles/" ;;
  apps)      URL="https://business.facebook.com/latest/settings/apps?business_id=$BIZ&selected_asset_id=$APP&selected_asset_type=app" ;;
  system)    URL="https://business.facebook.com/settings/system-users?business_id=$BIZ" ;;
  verify)    URL="https://business.facebook.com/settings/security_center?business_id=$BIZ" ;;
  page)      URL="https://business.facebook.com/latest/settings/pages?business_id=$BIZ&selected_asset_id=$PAGE" ;;
  token)     URL="https://developers.facebook.com/tools/debug/accesstoken/?q=$(get META_PAGE_ACCESS_TOKEN)" ;;
  *)
    echo "Usage : npm run meta <raccourci>"
    echo ""
    echo "  explorer   explorateur d'API (génération de jeton)"
    echo "  app        paramètres de l'app (App ID, clé secrète)"
    echo "  roles      rôles sur l'application"
    echo "  apps       applications du Business (s'attribuer un rôle)"
    echo "  system     utilisateurs système du Business"
    echo "  verify     vérification de l'entreprise"
    echo "  page       réglages de la Page"
    echo "  token      débogueur du jeton actuel"
    echo ""
    echo "  App ID actuel : ${APP:-(non défini)}"
    exit 0 ;;
esac

echo "→ $URL"
open "$URL"
