#!/bin/sh
# scripts/flag.sh on|off ["message"] — demo KV feature flag without a redeploy.
#   flag.sh on            -> default surge message + scam_surge_alert=true
#   flag.sh on "message"  -> your message + scam_surge_alert=true
#   flag.sh off           -> scam_surge_alert=false
set -eu
# shellcheck disable=SC1091
. "$HOME/.config/merlion/admin.env"
: "${ADMIN_TOKEN:?ADMIN_TOKEN required}"
BASE="${MERLION_WEBHOOK_URL:-https://merlion-webhook-82dcb044-d.telnyxcompute.com}"
DEFAULT_MSG="Warning: we are seeing a surge in scam SMS pretending to be from Merlion Bank about a 'card verification' link. Do not click any links."

put() {
  curl -sS -X POST "$BASE/admin/flag" -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'content-type: application/json' -d "$1"
  echo
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

case "${1:-}" in
  on)
    MSG="${2:-$DEFAULT_MSG}"
    put "{\"key\":\"flag/surge_message\",\"value\":\"$(json_escape "$MSG")\"}"
    put '{"key":"flag/scam_surge_alert","value":"true"}'
    ;;
  off)
    put '{"key":"flag/scam_surge_alert","value":"false"}'
    ;;
  *)
    curl -sS "$BASE/admin/flag" -H "Authorization: Bearer $ADMIN_TOKEN"
    echo
    echo "usage: flag.sh on [\"message\"] | off" >&2
    exit 1
    ;;
esac
curl -sS "$BASE/admin/flag" -H "Authorization: Bearer $ADMIN_TOKEN"
echo
