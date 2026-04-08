#!/usr/bin/env bash
# Usage:
#   curl -sSL http://your-backend/install.sh | sudo bash -s -- \
#       --token  YOUR_TOKEN \
#       --master ws://your-backend/ws/agent
set -euo pipefail

# ── Argument parsing ─────────────────────────────────────────────────────────
TOKEN=""
MASTER_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)   TOKEN="$2";      shift 2 ;;
    --master)  MASTER_URL="$2"; shift 2 ;;
    --arch)    shift 2 ;;  # accepted but detected automatically
    *)         echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$TOKEN" || -z "$MASTER_URL" ]]; then
  echo "Error: --token and --master are required."
  exit 1
fi

# ── Detect OS and architecture ────────────────────────────────────────────────
OS=$(uname -s | tr '[:upper:]' '[:lower:]')   # linux | darwin
ARCH=$(uname -m)

case "$ARCH" in
  x86_64)          ARCH="amd64" ;;
  aarch64|arm64)   ARCH="arm64" ;;
  *)               echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Derive HTTP/S base URL from the WS/S master URL (supports both ws:// and wss://)
BASE_URL=$(echo "$MASTER_URL" | sed -E 's|^ws(s)?://|http\1://|' | sed 's|/ws/agent$||')
BIN_URL="${BASE_URL}/downloads/nexus-agent-${OS}-${ARCH}"
BIN_PATH="/usr/local/bin/nexus-agent"
CERT_DIR="/etc/nexus/certs"
SERVICE_NAME="nexus-agent"

echo "==> Detected: ${OS}/${ARCH}"
echo "==> Downloading nexus-agent from ${BIN_URL}"

# ── Download binary ───────────────────────────────────────────────────────────
curl -fsSL -o "$BIN_PATH" "$BIN_URL"
chmod +x "$BIN_PATH"

# ── Create cert directory ─────────────────────────────────────────────────────
mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR"

# ── Enroll: register node with the Master ────────────────────────────────────
echo "==> Enrolling with master at ${BASE_URL}"
ENROLL_RESP=$(curl -fsSL -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  "${BASE_URL}/api/v1/agent/enroll" 2>/dev/null || echo "{}")

# Store token for service use
echo "AGENT_TOKEN=${TOKEN}" > /etc/nexus/agent.env
echo "AGENT_MASTER_URL=${MASTER_URL}" >> /etc/nexus/agent.env
chmod 600 /etc/nexus/agent.env

# ── Install as system service ─────────────────────────────────────────────────
echo "==> Installing ${SERVICE_NAME} as system service"
"$BIN_PATH" -service install -master "$MASTER_URL" -token "$TOKEN"

# ── Start service ─────────────────────────────────────────────────────────────
if command -v systemctl &>/dev/null; then
  systemctl enable "$SERVICE_NAME"
  systemctl start  "$SERVICE_NAME"
  echo "==> Service started via systemctl"
elif command -v launchctl &>/dev/null; then
  launchctl load /Library/LaunchDaemons/nexus-agent.plist 2>/dev/null || true
  echo "==> Service loaded via launchctl"
fi

echo ""
echo "✓ Nexus Agent installed and running."
echo "  Master  : $MASTER_URL"
echo "  Logs    : journalctl -u nexus-agent -f    (Linux)"
echo "            tail -f /var/log/nexus-agent.log (macOS)"
