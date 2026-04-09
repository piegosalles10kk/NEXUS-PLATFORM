// Package network – WireGuard mesh overlay (Sprint 12.1 + 12.3)
//
// When the master sends a "setup_mesh" command the agent:
//   1. Generates a WireGuard key pair (if not already present)
//   2. Creates a tun0 interface with the assigned mesh IP (10.50.0.x)
//   3. Adds peer entries for every other node in the cluster
//   4. Reports its public key back to the master so peers can be notified
//
// Teardown ("teardown_mesh") removes the interface cleanly.
//
// This implementation uses the `wg` and `ip` CLI tools that are available
// on any Linux host with the wireguard-tools package.  On non-Linux systems
// the functions are no-ops (logged warning).
//
// Prerequisites on the Linux host:
//   apt-get install -y wireguard-tools iproute2
package network

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	meshInterface = "nexus0"
	meshKeyDir    = "/etc/nexus/wg"
	meshPrivKey   = "/etc/nexus/wg/private.key"
	meshPubKey    = "/etc/nexus/wg/public.key"
	meshListenPort = 51820
)

// MeshPeer represents a remote cluster node.
type MeshPeer struct {
	NodeID    string `json:"nodeId"`
	PublicKey string `json:"pubKey"`
	Endpoint  string `json:"endpoint"`  // "1.2.3.4:51820"
	AllowedIP string `json:"allowedIp"` // "10.50.0.x/32"
}

// MeshConfig is received from the master via the "setup_mesh" WS command.
type MeshConfig struct {
	MeshIP  string     `json:"meshIp"`  // "10.50.0.x"
	Subnet  string     `json:"subnet"`  // "10.50.0.0/24"
	Peers   []MeshPeer `json:"peers"`
}

var meshMu sync.Mutex

// SetupMesh configures the WireGuard overlay for this node.
// Returns the node's WireGuard public key so the caller can report it back.
func SetupMesh(cfg MeshConfig) (pubKey string, err error) {
	if runtime.GOOS != "linux" {
		log.Printf("[mesh] WireGuard mesh is Linux-only; skipping on %s", runtime.GOOS)
		return "", nil
	}

	meshMu.Lock()
	defer meshMu.Unlock()

	// 1. Ensure key pair exists
	pubKey, err = ensureKeyPair()
	if err != nil {
		return "", fmt.Errorf("key pair: %w", err)
	}

	// 2. Tear down any existing interface (idempotent)
	teardownMeshLocked()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// 3. Create WireGuard interface
	if err := run(ctx, "ip", "link", "add", meshInterface, "type", "wireguard"); err != nil {
		return "", fmt.Errorf("create interface: %w", err)
	}

	// 4. Assign mesh IP
	if err := run(ctx, "ip", "address", "add", cfg.MeshIP+"/24", "dev", meshInterface); err != nil {
		return "", fmt.Errorf("assign IP: %w", err)
	}

	// 5. Configure WireGuard (private key + listen port)
	privKeyData, err := os.ReadFile(meshPrivKey)
	if err != nil {
		return "", fmt.Errorf("read private key: %w", err)
	}

	wgConf := buildWGConfig(strings.TrimSpace(string(privKeyData)), cfg.Peers)
	confPath := filepath.Join(meshKeyDir, "nexus0.conf")
	if err := os.WriteFile(confPath, []byte(wgConf), 0600); err != nil {
		return "", fmt.Errorf("write wg config: %w", err)
	}

	if err := run(ctx, "wg", "setconf", meshInterface, confPath); err != nil {
		return "", fmt.Errorf("wg setconf: %w", err)
	}

	// 6. Bring interface up
	if err := run(ctx, "ip", "link", "set", meshInterface, "up"); err != nil {
		return "", fmt.Errorf("interface up: %w", err)
	}

	// 7. Add route for the mesh subnet
	run(ctx, "ip", "route", "add", cfg.Subnet, "dev", meshInterface) //nolint:errcheck — may already exist

	log.Printf("[mesh] nexus0 up — meshIP=%s peers=%d subnet=%s", cfg.MeshIP, len(cfg.Peers), cfg.Subnet)
	return pubKey, nil
}

// TeardownMesh removes the WireGuard interface.
func TeardownMesh() {
	if runtime.GOOS != "linux" {
		return
	}
	meshMu.Lock()
	defer meshMu.Unlock()
	teardownMeshLocked()
}

func teardownMeshLocked() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run(ctx, "ip", "link", "del", meshInterface) //nolint:errcheck — OK if not present
}

// GetMeshPubKey returns the node's WireGuard public key, generating one if needed.
func GetMeshPubKey() (string, error) {
	if runtime.GOOS != "linux" {
		return "", nil
	}
	return ensureKeyPair()
}

// ── Key management ────────────────────────────────────────────────────────────

func ensureKeyPair() (string, error) {
	if err := os.MkdirAll(meshKeyDir, 0700); err != nil {
		return "", err
	}

	// Reuse existing keys
	if _, err := os.Stat(meshPubKey); err == nil {
		data, err := os.ReadFile(meshPubKey)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(data)), nil
	}

	// Generate new key pair
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	privBytes, err := execOutput(ctx, "wg", "genkey")
	if err != nil {
		return "", fmt.Errorf("wg genkey: %w", err)
	}
	priv := strings.TrimSpace(string(privBytes))

	if err := os.WriteFile(meshPrivKey, []byte(priv+"\n"), 0600); err != nil {
		return "", err
	}

	pubBytes, err := execOutputStdin(ctx, priv, "wg", "pubkey")
	if err != nil {
		return "", fmt.Errorf("wg pubkey: %w", err)
	}
	pub := strings.TrimSpace(string(pubBytes))

	if err := os.WriteFile(meshPubKey, []byte(pub+"\n"), 0644); err != nil {
		return "", err
	}
	log.Printf("[mesh] new WireGuard key pair generated (pub=%s…)", pub[:8])
	return pub, nil
}

// ── WireGuard config builder ──────────────────────────────────────────────────

func buildWGConfig(privateKey string, peers []MeshPeer) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("[Interface]\nPrivateKey = %s\nListenPort = %d\n\n", privateKey, meshListenPort))
	for _, p := range peers {
		if p.PublicKey == "" {
			continue // peer key not yet exchanged; will be added after handshake
		}
		sb.WriteString(fmt.Sprintf("[Peer]\nPublicKey = %s\n", p.PublicKey))
		if p.Endpoint != "" {
			sb.WriteString(fmt.Sprintf("Endpoint = %s\n", p.Endpoint))
		}
		allowedIP := p.AllowedIP
		if allowedIP == "" && p.NodeID != "" {
			allowedIP = "0.0.0.0/0" // placeholder
		}
		sb.WriteString(fmt.Sprintf("AllowedIPs = %s\n", allowedIP))
		sb.WriteString("PersistentKeepalive = 25\n\n")
	}
	return sb.String()
}

// ── WS command dispatcher (called from websocket.go) ─────────────────────────

// HandleSetupMesh processes the "setup_mesh" inbound command and sends the
// resulting public key back to the master.
func HandleSetupMesh(raw json.RawMessage, out chan<- []byte, ctx context.Context) {
	var cfg MeshConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		log.Printf("[mesh] bad setup_mesh payload: %v", err)
		return
	}
	pubKey, err := SetupMesh(cfg)
	if err != nil {
		log.Printf("[mesh] SetupMesh error: %v", err)
		return
	}
	if pubKey == "" {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"type":      "mesh_ready",
		"meshIp":    cfg.MeshIP,
		"publicKey": pubKey,
	})
	select {
	case out <- payload:
	case <-ctx.Done():
	}
}

// ── Shell helpers ─────────────────────────────────────────────────────────────

func run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %v: %w — %s", name, args, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func execOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

func execOutputStdin(ctx context.Context, stdin string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = strings.NewReader(stdin)
	return cmd.Output()
}
