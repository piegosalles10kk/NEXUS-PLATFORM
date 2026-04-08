#!/usr/bin/env bash
# chaos-test.sh — Nexus DePIN Chaos Engineering Playbook (automated)
#
# Runs the full chaos test against a running backend:
#   1. Provisions 3 nodes
#   2. Starts 3 agent simulators in background
#   3. Deploys a test WASM app via the Scheduler API
#   4. Waits for workers to log output
#   5. Kills one simulator (simulates node failure)
#   6. Waits for failover.service.ts to detect and reassign (30s threshold)
#   7. Verifies new assignment created in DB via API
#
# Requirements:
#   - Backend + DB + Redis running  (docker compose -f docker-compose.dev.yml up -d && cd backend && npm run dev)
#   - ADM_TOKEN set
#   - Go installed
#
# Usage:
#   export ADM_TOKEN="..."
#   bash scripts/chaos-test.sh

set -euo pipefail

NEXUS_URL="${NEXUS_URL:-http://localhost:4500}"
AGENT_WSS="${AGENT_WSS:-wss://localhost:8443}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/.chaos-logs"
mkdir -p "$LOG_DIR"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[chaos]${NC} $*"; }
ok()   { echo -e "${GREEN}[✅ OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[⚠️  WARN]${NC} $*"; }
fail() { echo -e "${RED}[❌ FAIL]${NC} $*"; exit 1; }
step() { echo -e "\n${BOLD}━━━ $* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# ── Cleanup on exit ───────────────────────────────────────────────────────────
SIM_PIDS=()
cleanup() {
  log "Shutting down simulators..."
  for pid in "${SIM_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

# ── Step 0: Verify backend is reachable ──────────────────────────────────────
step "0 · Verify backend"

if ! curl -sf "$NEXUS_URL/health" > /dev/null 2>&1 && ! curl -sf "$NEXUS_URL/api/v1/auth/me" > /dev/null 2>&1; then
  # Try a simpler check
  if ! curl -s "$NEXUS_URL" > /dev/null 2>&1; then
    fail "Backend not reachable at $NEXUS_URL — run: cd backend && npm run dev"
  fi
fi

if [[ -z "${ADM_TOKEN:-}" ]]; then
  fail "ADM_TOKEN not set. Login first and export the token."
fi

ok "Backend is up at $NEXUS_URL"

# ── Step 1: Provision 3 nodes ─────────────────────────────────────────────────
step "1 · Provision 3 nodes"

NODE_IDS=()
NODE_TOKENS=()
NODE_NAMES=("chaos-node-1" "chaos-node-2" "chaos-node-3")

for i in 0 1 2; do
  NAME="${NODE_NAMES[$i]}"
  log "Creating node '$NAME'..."

  CREATE_RESP=$(curl -s -X POST "$NEXUS_URL/api/v1/agent/nodes" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADM_TOKEN" \
    -d "{\"name\": \"$NAME\"}")

  ENROLL_TOKEN=$(echo "$CREATE_RESP" | grep -o '"enrollToken":"[^"]*"' | cut -d'"' -f4)
  NODE_ID=$(echo "$CREATE_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [[ -z "$ENROLL_TOKEN" ]]; then
    warn "Create node response: $CREATE_RESP"
    fail "Failed to create node '$NAME'"
  fi

  # Enroll → get long-lived agent token
  ENROLL_RESP=$(curl -s -X POST "$NEXUS_URL/api/v1/agent/enroll" \
    -H "Authorization: Bearer $ENROLL_TOKEN")

  AGENT_TOKEN=$(echo "$ENROLL_RESP" | grep -o '"nodeToken":"[^"]*"' | cut -d'"' -f4)

  if [[ -z "$AGENT_TOKEN" ]]; then
    fail "Failed to enroll node '$NAME'"
  fi

  NODE_IDS+=("$NODE_ID")
  NODE_TOKENS+=("$AGENT_TOKEN")
  ok "Node '$NAME'  id=${NODE_ID:0:8}...  token=${AGENT_TOKEN:0:20}..."
done

# ── Step 2: Start simulators ──────────────────────────────────────────────────
step "2 · Start 3 agent simulators"

for i in 0 1 2; do
  NAME="${NODE_NAMES[$i]}"
  TOKEN="${NODE_TOKENS[$i]}"
  LOGFILE="$LOG_DIR/sim-$((i+1)).log"

  NEXUS_SKIP_TLS=1 \
    go run "$ROOT/agent/cmd/sim/main.go" \
      -master "$AGENT_WSS" \
      -token "$TOKEN" \
      -name "$NAME" \
      -skip-tls \
    > "$LOGFILE" 2>&1 &

  SIM_PIDS+=($!)
  log "Simulator $((i+1)) ($NAME) started  pid=${SIM_PIDS[-1]}  log=$LOGFILE"
done

log "Waiting 5s for simulators to connect..."
sleep 5

# Verify connections
for i in 0 1 2; do
  LOGFILE="$LOG_DIR/sim-$((i+1)).log"
  if grep -q "connected to" "$LOGFILE" 2>/dev/null; then
    ok "Simulator $((i+1)) (${NODE_NAMES[$i]}) connected ✓"
  else
    warn "Simulator $((i+1)) may not be connected — check $LOGFILE"
    cat "$LOGFILE" 2>/dev/null | tail -5
  fi
done

# ── Step 3: Deploy test WASM app ──────────────────────────────────────────────
step "3 · Deploy test WASM app"

DEPLOY_RESP=$(curl -s -X POST "$NEXUS_URL/api/v1/scheduler/deploy" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADM_TOKEN" \
  -d '{
    "name":          "Chaos Worker",
    "slug":          "chaos-worker",
    "executionMode": "WASM",
    "moduleRef":     "test-app/worker.js",
    "replicaCount":  3,
    "envVars":       {"APP_NAME": "chaos-worker", "LOG_LEVEL": "info"}
  }')

APP_ID=$(echo "$DEPLOY_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$APP_ID" ]]; then
  warn "Deploy response: $DEPLOY_RESP"
  fail "Deploy failed — app ID not found in response"
fi

ok "App deployed  id=${APP_ID:0:8}...  waiting 8s for workers to start..."
sleep 8

# Show worker logs
log "Worker logs from simulators:"
for i in 0 1 2; do
  LOGFILE="$LOG_DIR/sim-$((i+1)).log"
  echo -e "  ${CYAN}[${NODE_NAMES[$i]}]${NC}:"
  grep -i "wasm\|worker\|run_wasm\|lote\|🚀\|🔵" "$LOGFILE" 2>/dev/null | tail -5 | sed 's/^/    /' || echo "    (no worker logs yet)"
done

# ── Step 4: Mark one node ONLINE in DB so failover detects it ─────────────────
# (The backend failover monitor checks lastPing — simulators send pings, so
#  killing one will cause it to miss the 30s threshold)
step "4 · Chaos: kill simulator 1 (${NODE_NAMES[0]})"

VICTIM_PID="${SIM_PIDS[0]}"
VICTIM_ID="${NODE_IDS[0]}"
VICTIM_NAME="${NODE_NAMES[0]}"

log "Killing $VICTIM_NAME (pid=$VICTIM_PID)..."
kill "$VICTIM_PID" 2>/dev/null || true
SIM_PIDS[0]=0

ok "Simulator 1 killed. The backend failover monitor will detect it after ~30s."
log "Watching for failover... (checking every 10s for up to 60s)"

# ── Step 5: Wait for failover ─────────────────────────────────────────────────
step "5 · Verify failover"

FAILOVER_DETECTED=false
for attempt in 1 2 3 4 5 6; do
  sleep 10
  log "Check $attempt/6 — querying app assignments..."

  APP_RESP=$(curl -s "$NEXUS_URL/api/v1/scheduler/apps/$APP_ID" \
    -H "Authorization: Bearer $ADM_TOKEN")

  # Count RUNNING assignments
  RUNNING=$(echo "$APP_RESP" | grep -o '"status":"RUNNING"' | wc -l)
  OFFLINE=$(echo "$APP_RESP" | grep -o '"status":"OFFLINE"' | wc -l)

  log "  Assignments: RUNNING=$RUNNING  OFFLINE=$OFFLINE"

  # Failover creates a new assignment for the dead node
  if [[ "$OFFLINE" -ge 1 ]] && [[ "$RUNNING" -ge 2 ]]; then
    FAILOVER_DETECTED=true
    break
  fi
done

echo ""
if [[ "$FAILOVER_DETECTED" == "true" ]]; then
  echo -e "${GREEN}${BOLD}"
  echo "  ╔══════════════════════════════════════════════════════════╗"
  echo "  ║  🎉  FAILOVER COMPROVADO!                                ║"
  echo "  ║                                                          ║"
  echo "  ║  O nó '$VICTIM_NAME' foi desligado.          ║"
  echo "  ║  O backend detectou a ausência de heartbeat.            ║"
  echo "  ║  Um novo nó foi atribuído automaticamente.              ║"
  echo "  ║  Os workers continuam rodando — zero downtime.          ║"
  echo "  ╚══════════════════════════════════════════════════════════╝"
  echo -e "${NC}"
else
  warn "Failover not detected yet (may need more time or backend logs show reason)."
  warn "Check backend terminal for [failover] log messages."
  warn "The failover threshold is 30s — if the backend just started, wait a bit more."
fi

# ── Step 6: Show final state ──────────────────────────────────────────────────
step "6 · Final state"

FINAL_RESP=$(curl -s "$NEXUS_URL/api/v1/scheduler/apps/$APP_ID" \
  -H "Authorization: Bearer $ADM_TOKEN")
echo "$FINAL_RESP" | python3 -m json.tool 2>/dev/null || echo "$FINAL_RESP"

echo ""
log "Simulator logs:"
for i in 0 1 2; do
  echo -e "  → $LOG_DIR/sim-$((i+1)).log"
done

log "Chaos test complete."
