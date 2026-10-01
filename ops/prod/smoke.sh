#!/bin/sh
# Post-deploy smoke test for a running POD Studio stack (no credentials needed).
#
#   ops/prod/smoke.sh https://studio.example.com [bucket]
#
# Checks liveness, database readiness, the auth gate, security headers, and that the object
# bucket is reachable through Caddy but private. Set SMOKE_INSECURE=1 for a self-signed local CA.
set -eu

base=${1:?usage: ops/prod/smoke.sh <base-url> [bucket]}
bucket=${2:-pod-studio}
k=""
[ "${SMOKE_INSECURE:-0}" = "1" ] && k="-k"
fail=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected $2, got $3"; fail=1; fi
}

check "GET /api/health" 200 "$(curl -s $k -o /dev/null -w '%{http_code}' "$base/api/health")"
check "GET /api/health/ready" 200 "$(curl -s $k -o /dev/null -w '%{http_code}' "$base/api/health/ready")"
check "GET /login" 200 "$(curl -s $k -o /dev/null -w '%{http_code}' "$base/login")"
check "anonymous /stores redirects" 307 "$(curl -s $k -o /dev/null -w '%{http_code}' "$base/stores")"
check "anonymous object read denied" 403 "$(curl -s $k -o /dev/null -w '%{http_code}' "$base/$bucket/smoke-probe")"

headers=$(curl -s $k -o /dev/null -D - "$base/login" | tr -d '\r' | tr 'A-Z' 'a-z')
for h in "strict-transport-security: max-age=31536000" "x-content-type-options: nosniff" "x-frame-options: deny"; do
  case "$headers" in *"$h"*) echo "ok   header $h" ;; *) echo "FAIL header $h missing"; fail=1 ;; esac
done
case "$headers" in *"x-powered-by"*) echo "FAIL x-powered-by header present"; fail=1 ;; *) echo "ok   no x-powered-by" ;; esac

[ "$fail" = 0 ] && echo "smoke: all checks passed" || { echo "smoke: FAILED"; exit 1; }
