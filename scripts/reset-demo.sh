#!/bin/sh
# scripts/reset-demo.sh — reset demo personas (C001–C004) to seed state via the
# admin route on merlion-webhook. Reads the token from $ADMIN_TOKEN.
set -eu
TOKEN="${ADMIN_TOKEN:?usage: ADMIN_TOKEN=<token> scripts/reset-demo.sh}"
BASE="${MERLION_WEBHOOK_URL:-https://merlion-webhook-82dcb044-d.telnyxcompute.com}"
curl -sS -w "\n[HTTP %{http_code} %{time_total}s]\n" -X POST "$BASE/admin/reset" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
