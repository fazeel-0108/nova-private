#!/usr/bin/env bash
# Verifies the Nova relay (relay/worker.js) against any base URL — local
# workerd or a deployed environment. Real requests, real status codes.
#
#   bash relay/verify.sh http://127.0.0.1:8788 testpass123
#   bash relay/verify.sh https://<deployed>.freebuff.page "<your passcode>"
#
# $2 = passcode (omit if NOVA_PASS is not set on that relay).
set -uo pipefail

BASE="${1:?usage: verify.sh <base-url> [passcode]}"
PASS="${2:-}"
ORIGIN="${3:-https://fazeel-0108.github.io}"
TMP="$(mktemp -d)"
fail=0

ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1  (expected: $2 | got: $3)"; fail=1; }
eq()   { [ "$2" = "$3" ] && ok "$1 ($2)" || bad "$1" "$3" "$2"; }
has()  { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "contains '$3'" "$(echo "$2" | head -c 160)" ;; esac; }

code() { curl -s -o "$TMP/body" -w "%{http_code}" "$@"; }

echo "== Nova relay verification =="
echo "base:   $BASE"
echo "origin: $ORIGIN"
echo "pass:   $([ -n "$PASS" ] && echo "provided" || echo "(none)")"
echo

echo "1) GET /api/health"
C=$(code "$BASE/api/health")
eq "health status" "$C" "200"
has "health lists providers" "$(cat "$TMP/body")" "pollinations"

echo "2) POST /api/chat (keyless free path)"
C=$(code -X POST "$BASE/api/chat" -H "Content-Type: application/json" \
  -d '{"provider":"auto","stream":false,"messages":[{"role":"user","content":"Reply with the single word: OK"}]}')
eq "chat status" "$C" "200"
has "chat returns a completion" "$(cat "$TMP/body")" '"choices"'

echo "2b) POST /api/chat streaming (SSE pass-through)"
curl -s --max-time 45 -D "$TMP/sse-h" -o "$TMP/sse" -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d '{"stream":true,"messages":[{"role":"user","content":"Count: one two three four five"}]}'
SCT=$(tr -d '\r' < "$TMP/sse-h" | awk -F': ' 'tolower($1)=="content-type"{print $2}')
has "streamed content-type" "$SCT" "text/event-stream"
has "stream carries SSE frames" "$(cat "$TMP/sse")" "data:"
SINGLE=$(tr -d '\r' < "$TMP/sse-h" | awk -F': ' 'tolower($1)=="x-nova-meta"{print $2}')
[ -n "$SINGLE" ] && ok "stream response has routing meta" || bad "stream response has routing meta" "X-Nova-Meta present" "missing"

echo "3) CORS preflight from the app origin"
C=$(code -X OPTIONS "$BASE/api/chat" -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type")
eq "preflight status" "$C" "204"
ACAO=$(curl -s -D - -o /dev/null -X OPTIONS "$BASE/api/chat" -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: POST" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
eq "preflight allows the app origin" "$ACAO" "$ORIGIN"

echo "4) CORS header on a real chat response"
META=$(curl -s -D - -o /dev/null -X POST "$BASE/api/chat" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}' | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-expose-headers"{print $2}')
has "exposes X-Nova-Meta" "$META" "X-Nova-Meta"

echo "5) Foreign origin is refused"
C=$(code -X POST "$BASE/api/chat" -H "Origin: https://evil.example" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}')
eq "foreign origin status" "$C" "403"

echo "6) GET /api/gate (is the passcode configured?)"
code "$BASE/api/gate" >/dev/null
GATEBODY="$(cat "$TMP/body")"
has "gate reports configured flag" "$GATEBODY" '"configured"'

if [ -n "$PASS" ]; then
  echo "7) POST /api/gate — wrong passcode must fail"
  C=$(code -X POST "$BASE/api/gate" -H "Content-Type: application/json" -d '{"pass":"definitely-wrong-'"$RANDOM"'"}')
  eq "wrong passcode status" "$C" "401"

  echo "8) POST /api/gate — correct passcode returns a token"
  C=$(code -X POST "$BASE/api/gate" -H "Content-Type: application/json" -d "{\"pass\":\"$PASS\"}")
  eq "login status" "$C" "200"
  TOKEN=$(python -c "import json,sys;print(json.load(open(sys.argv[1])).get('token',''))" "$TMP/body" 2>/dev/null || true)
  [ -n "$TOKEN" ] && ok "token issued" || bad "token issued" "non-empty token" "empty"

  echo "9) POST /api/gate — stored token re-verifies"
  C=$(code -X POST "$BASE/api/gate" -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}")
  eq "token verify status" "$C" "200"

  echo "10) POST /api/gate — bad token is rejected"
  C=$(code -X POST "$BASE/api/gate" -H "Content-Type: application/json" -d '{"token":"deadbeef"}')
  eq "bad token status" "$C" "401"
else
  echo "7-10) passcode checks skipped (no passcode given)"
fi

echo "11) /api/sync — push then read back"
CODE="TEST$RANDOM"
STAMP="$(date +%s)"
C=$(code -X POST "$BASE/api/sync" -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\",\"device\":\"verify-script\",\"payload\":{\"notes\":[{\"id\":\"n$STAMP\",\"text\":\"verify $STAMP\"}]}}")
eq "sync push status" "$C" "200"
has "sync push returns a revision" "$(cat "$TMP/body")" '"rev"'
C=$(code "$BASE/api/sync?code=$CODE")
eq "sync read status" "$C" "200"
has "sync read returns the pushed note" "$(cat "$TMP/body")" "verify $STAMP"

echo "12) /api/sync — bad code is refused"
C=$(code "$BASE/api/sync?code=ab")
eq "bad code status" "$C" "400"

echo "13) Static asset from the relay origin"
C=$(code "$BASE/")
eq "landing page status" "$C" "200"
has "landing page is HTML" "$(cat "$TMP/body")" "Nova relay"

rm -rf "$TMP"
echo
[ "$fail" = "0" ] && echo "RESULT: all checks passed" || echo "RESULT: failures above"
exit "$fail"
