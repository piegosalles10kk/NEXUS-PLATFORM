#!/usr/bin/env bash
# provision-nodes.sh — Registers 3 test nodes and writes their agent tokens
# to .nexus-dev-tokens so chaos-test.sh can pick them up.
#
# Requirements: backend must be running at NEXUS_URL (default http://localhost:4500)
# The ADM_TOKEN must be a valid JWT for an ADM user.
#
# Usage:
#   export ADM_TOKEN="<your jwt from login>"
#   bash scripts/provision-nodes.sh

set -euo pipefail

NEXUS_URL="${NEXUS_URL:-http://localhost:4500}"
TOKENS_FILE=".nexus-dev-tokens"

if [[ -z "${ADM_TOKEN:-}" ]]; then
  echo "❌  ADM_TOKEN is not set."
  echo "   Log in first:  curl -s -X POST $NEXUS_URL/api/v1/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"admin@nexus.dev\",\"password\":\"admin123\"}' | jq -r '.data.token'"
  exit 1
fi

echo "🔑  Using backend: $NEXUS_URL"
echo ""

> "$TOKENS_FILE"

for i in 1 2 3; do
  NAME="chaos-node-$i"
  echo "📡  Creating node '$NAME'..."

  CREATE_RESP=$(curl -s -X POST "$NEXUS_URL/api/v1/agent/nodes" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADM_TOKEN" \
    -d "{\"name\": \"$NAME\"}")

  # Extract enrollToken
  ENROLL_TOKEN=$(echo "$CREATE_RESP" | grep -o '"enrollToken":"[^"]*"' | cut -d'"' -f4)
  NODE_ID=$(echo "$CREATE_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [[ -z "$ENROLL_TOKEN" || -z "$NODE_ID" ]]; then
    echo "❌  Failed to create node $NAME. Response:"
    echo "$CREATE_RESP"
    exit 1
  fi

  echo "   node_id:     $NODE_ID"
  echo "   enroll_token: ${ENROLL_TOKEN:0:30}..."

  # Enroll to get long-lived agent token
  ENROLL_RESP=$(curl -s -X POST "$NEXUS_URL/api/v1/agent/enroll" \
    -H "Authorization: Bearer $ENROLL_TOKEN")

  AGENT_TOKEN=$(echo "$ENROLL_RESP" | grep -o '"nodeToken":"[^"]*"' | cut -d'"' -f4)

  if [[ -z "$AGENT_TOKEN" ]]; then
    echo "❌  Failed to enroll node $NAME. Response:"
    echo "$ENROLL_RESP"
    exit 1
  fi

  echo "   agent_token:  ${AGENT_TOKEN:0:30}..."
  echo "   ✅ Node '$NAME' enrolled"
  echo ""

  # Save to tokens file
  echo "NODE_${i}_NAME=$NAME" >> "$TOKENS_FILE"
  echo "NODE_${i}_ID=$NODE_ID" >> "$TOKENS_FILE"
  echo "NODE_${i}_TOKEN=$AGENT_TOKEN" >> "$TOKENS_FILE"
done

echo "✅  All nodes provisioned. Tokens saved to $TOKENS_FILE"
echo ""
echo "Next steps:"
echo "  # Open 3 terminals and run each:"
echo "  source .nexus-dev-tokens"
echo "  NEXUS_SKIP_TLS=1 go run agent/cmd/sim/main.go -master wss://localhost:8443 -token \$NODE_1_TOKEN -name \$NODE_1_NAME"
echo "  NEXUS_SKIP_TLS=1 go run agent/cmd/sim/main.go -master wss://localhost:8443 -token \$NODE_2_TOKEN -name \$NODE_2_NAME"
echo "  NEXUS_SKIP_TLS=1 go run agent/cmd/sim/main.go -master wss://localhost:8443 -token \$NODE_3_TOKEN -name \$NODE_3_NAME"
