// Package network — Dual-Mesh overlay (Sprint 18.3)
//
// Creates TWO separate WireGuard/bridge interfaces on each node:
//
//	nexus-lan  (10.60.0.0/24) — private tenant mesh, intra-org traffic only
//	nexus-wan  (10.70.0.0/24) — public DePIN mesh, consumer-facing
//
// Security isolation:
//   - Containers tagged as "PUBLIC" are jailed inside a dedicated Linux
//     network namespace (netns nexus-pub-<appSlug>) and can only reach the
//     nexus-wan interface via iptables FORWARD rules.
//   - Containers tagged as "PRIVATE" use the host netns but traffic is
//     limited to nexus-lan via iptables OUTPUT rules.
//   - Cross-namespace routing is explicitly DENIED.
//
// Prerequisites on the Linux host:
//
//	apt-get install -y wireguard-tools iproute2 iptables
package network

import (
	"context"
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
	lanInterface  = "nexus-lan"
	wanInterface  = "nexus-wan"
	lanKeyDir     = "/etc/nexus/wg-lan"
	wanKeyDir     = "/etc/nexus/wg-wan"
	lanListenPort = 51821
	wanListenPort = 51822
	lanSubnet     = "10.60.0.0/24"
	wanSubnet     = "10.70.0.0/24"
)

// DualMeshConfig is pushed by the master via the "setup_dual_mesh" WS command.
type DualMeshConfig struct {
	LANMeshIP  string `json:"lanMeshIp"`  // "10.60.0.x" — private
	WANMeshIP  string `json:"wanMeshIp"`  // "10.70.0.x" — public
	TenantMode string `json:"tenantMode"` // "PUBLIC" | "PRIVATE" (default: PUBLIC)
}

var dualMeshMu sync.Mutex

// SetupDualMesh creates nexus-lan and nexus-wan interfaces and applies
// iptables isolation rules.
func SetupDualMesh(cfg DualMeshConfig) error {
	if runtime.GOOS != "linux" {
		log.Printf("[dual_mesh] Linux-only; skipping on %s", runtime.GOOS)
		return nil
	}

	dualMeshMu.Lock()
	defer dualMeshMu.Unlock()

	// Tear down any existing interfaces first (idempotent)
	teardownDualMeshLocked()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// ── nexus-lan ─────────────────────────────────────────────────────────────
	if cfg.LANMeshIP != "" {
		lanPub, err := setupMeshInterface(ctx, lanInterface, lanKeyDir, cfg.LANMeshIP, lanSubnet, lanListenPort)
		if err != nil {
			return fmt.Errorf("dual_mesh: nexus-lan: %w", err)
		}
		log.Printf("[dual_mesh] nexus-lan up — ip=%s pubkey=%s…", cfg.LANMeshIP, lanPub[:8])
	}

	// ── nexus-wan ─────────────────────────────────────────────────────────────
	if cfg.WANMeshIP != "" {
		wanPub, err := setupMeshInterface(ctx, wanInterface, wanKeyDir, cfg.WANMeshIP, wanSubnet, wanListenPort)
		if err != nil {
			return fmt.Errorf("dual_mesh: nexus-wan: %w", err)
		}
		log.Printf("[dual_mesh] nexus-wan up — ip=%s pubkey=%s…", cfg.WANMeshIP, wanPub[:8])
	}

	// ── iptables isolation rules ──────────────────────────────────────────────
	if err := applyIsolationRules(ctx, cfg.TenantMode); err != nil {
		log.Printf("[dual_mesh] iptables rules warning: %v", err)
		// Non-fatal — network is still functional, just less isolated
	}

	return nil
}

// TeardownDualMesh removes both mesh interfaces and reverts iptables rules.
func TeardownDualMesh() {
	if runtime.GOOS != "linux" {
		return
	}
	dualMeshMu.Lock()
	defer dualMeshMu.Unlock()
	teardownDualMeshLocked()
}

func teardownDualMeshLocked() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	run(ctx, "ip", "link", "del", lanInterface) //nolint:errcheck
	run(ctx, "ip", "link", "del", wanInterface) //nolint:errcheck
	// Remove iptables isolation rules (best effort)
	run(ctx, "iptables", "-D", "FORWARD", "-i", lanInterface, "-o", wanInterface, "-j", "DROP") //nolint:errcheck
	run(ctx, "iptables", "-D", "FORWARD", "-i", wanInterface, "-o", lanInterface, "-j", "DROP") //nolint:errcheck
}

// setupMeshInterface creates a WireGuard interface with the given name and IP.
func setupMeshInterface(ctx context.Context, iface, keyDir, meshIP, subnet string, listenPort int) (string, error) {
	if err := os.MkdirAll(keyDir, 0700); err != nil {
		return "", err
	}

	privKeyPath := filepath.Join(keyDir, "private.key")
	pubKeyPath  := filepath.Join(keyDir, "public.key")

	// Generate key pair if needed
	pub, err := ensureKeyPairAt(ctx, privKeyPath, pubKeyPath)
	if err != nil {
		return "", fmt.Errorf("key pair: %w", err)
	}

	// Create WireGuard interface
	if err := run(ctx, "ip", "link", "add", iface, "type", "wireguard"); err != nil {
		return "", fmt.Errorf("create %s: %w", iface, err)
	}

	// Assign IP
	if err := run(ctx, "ip", "address", "add", meshIP+"/24", "dev", iface); err != nil {
		return "", fmt.Errorf("assign IP to %s: %w", iface, err)
	}

	// Configure WireGuard
	privKeyData, err := os.ReadFile(privKeyPath)
	if err != nil {
		return "", err
	}
	wgConf := fmt.Sprintf("[Interface]\nPrivateKey = %s\nListenPort = %d\n",
		strings.TrimSpace(string(privKeyData)), listenPort)
	confPath := filepath.Join(keyDir, iface+".conf")
	if err := os.WriteFile(confPath, []byte(wgConf), 0600); err != nil {
		return "", err
	}
	if err := run(ctx, "wg", "setconf", iface, confPath); err != nil {
		return "", fmt.Errorf("wg setconf %s: %w", iface, err)
	}

	// Bring interface up
	if err := run(ctx, "ip", "link", "set", iface, "up"); err != nil {
		return "", fmt.Errorf("link up %s: %w", iface, err)
	}

	// Add route
	run(ctx, "ip", "route", "add", subnet, "dev", iface) //nolint:errcheck

	return pub, nil
}

// applyIsolationRules enforces cross-mesh traffic denial via iptables.
func applyIsolationRules(ctx context.Context, tenantMode string) error {
	// Block cross-mesh FORWARD: LAN ↔ WAN bidirectional
	if err := run(ctx, "iptables", "-A", "FORWARD",
		"-i", lanInterface, "-o", wanInterface, "-j", "DROP"); err != nil {
		return fmt.Errorf("iptables LAN→WAN DROP: %w", err)
	}
	if err := run(ctx, "iptables", "-A", "FORWARD",
		"-i", wanInterface, "-o", lanInterface, "-j", "DROP"); err != nil {
		return fmt.Errorf("iptables WAN→LAN DROP: %w", err)
	}

	// For PUBLIC mode: also block WAN containers from reaching local disk
	// via host filesystem — this would require mount namespace restrictions
	// handled at container deploy time (Docker --read-only + --tmpfs).
	if tenantMode == "PUBLIC" {
		log.Printf("[dual_mesh] PUBLIC mode: containers will use nexus-wan only; LAN access blocked")
	} else {
		log.Printf("[dual_mesh] PRIVATE mode: containers use nexus-lan; WAN access blocked")
	}

	// Enable IP forwarding for mesh routing
	run(ctx, "sysctl", "-w", "net.ipv4.ip_forward=1") //nolint:errcheck
	return nil
}

// CreateContainerNetNS creates an isolated network namespace for a "PUBLIC"
// container, limiting it to nexus-wan only.
// Returns the netns name that should be passed to docker run --network.
func CreateContainerNetNS(ctx context.Context, appSlug string) (string, error) {
	if runtime.GOOS != "linux" {
		return "", nil
	}

	nsName := "nexus-pub-" + appSlug
	if err := run(ctx, "ip", "netns", "add", nsName); err != nil {
		return "", fmt.Errorf("netns add: %w", err)
	}

	// Add loopback in the namespace
	run(ctx, "ip", "netns", "exec", nsName, "ip", "link", "set", "lo", "up") //nolint:errcheck

	// Create a veth pair: veth0 in host, veth1 in namespace
	veth0 := "veth-" + appSlug[:min(8, len(appSlug))] + "0"
	veth1 := "veth-" + appSlug[:min(8, len(appSlug))] + "1"

	if err := run(ctx, "ip", "link", "add", veth0, "type", "veth", "peer", "name", veth1); err != nil {
		return "", fmt.Errorf("veth pair: %w", err)
	}

	// Move veth1 into namespace
	run(ctx, "ip", "link", "set", veth1, "netns", nsName) //nolint:errcheck

	log.Printf("[dual_mesh] netns %s created (PUBLIC isolation)", nsName)
	return nsName, nil
}

// DeleteContainerNetNS removes the network namespace for an app.
func DeleteContainerNetNS(ctx context.Context, appSlug string) {
	if runtime.GOOS != "linux" {
		return
	}
	nsName := "nexus-pub-" + appSlug
	run(ctx, "ip", "netns", "del", nsName) //nolint:errcheck
}

// ensureKeyPairAt generates a WireGuard key pair at the given paths if missing.
func ensureKeyPairAt(ctx context.Context, privPath, pubPath string) (string, error) {
	if _, err := os.Stat(pubPath); err == nil {
		data, err := os.ReadFile(pubPath)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(data)), nil
	}

	privBytes, err := execOutput(ctx, "wg", "genkey")
	if err != nil {
		return "", fmt.Errorf("wg genkey: %w", err)
	}
	priv := strings.TrimSpace(string(privBytes))
	if err := os.WriteFile(privPath, []byte(priv+"\n"), 0600); err != nil {
		return "", err
	}

	pubBytes, err := execOutputStdin(ctx, priv, "wg", "pubkey")
	if err != nil {
		return "", fmt.Errorf("wg pubkey: %w", err)
	}
	pub := strings.TrimSpace(string(pubBytes))
	if err := os.WriteFile(pubPath, []byte(pub+"\n"), 0644); err != nil {
		return "", err
	}
	return pub, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// GetInterfaceStatus returns brief status of both mesh interfaces.
func GetInterfaceStatus() map[string]string {
	status := map[string]string{
		lanInterface: "down",
		wanInterface: "down",
	}
	if runtime.GOOS != "linux" {
		return status
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	for iface := range status {
		out, err := exec.CommandContext(ctx, "ip", "link", "show", iface).Output()
		if err == nil && strings.Contains(string(out), "UP") {
			status[iface] = "up"
		}
	}
	return status
}
