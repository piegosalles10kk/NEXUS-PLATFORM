// Package vm – Nexus-Shield gateway MicroVM (T10.2)
//
// When the scheduler promotes a node to a transit gateway it sends the agent a
// "activate_transit" WebSocket command.  The agent calls StartGatewayVM() which
// launches an isolated Docker container named "nexus-gateway-shield" running
// nginx:alpine as a reverse proxy.
//
// Security isolation guarantees:
//   - 64 MB RAM hard limit  (--memory 64m)
//   - 0.25 CPU quota        (--cpus 0.25)
//   - Network namespace      (--network bridge)
//   - Read-only rootfs       (--read-only)
//   - No new privileges      (--security-opt no-new-privileges)
//   - Only port 8080 exposed
//
// On non-Linux platforms the function logs a notice and returns nil (no-op).
package vm

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	gatewayContainerName = "nexus-gateway-shield"
	gatewayListenPort    = "8080"
)

var gatewayMu sync.Mutex

// GatewayConfig holds parameters for the Nexus-Shield container.
type GatewayConfig struct {
	// UpstreamAddr is the backend address the proxy forwards traffic to.
	// e.g. "10.0.1.5:3000"
	UpstreamAddr  string
	// BandwidthMbps is the rate limit applied to the proxy (informational; nginx
	// limit_rate is set accordingly).
	BandwidthMbps int
	// ExternalPort is the host port mapped to the container's 8080.
	// Defaults to 8080 if 0.
	ExternalPort  int
}

// StartGatewayVM launches (or restarts) the Nexus-Shield reverse proxy
// container.  It is safe to call from multiple goroutines.
func StartGatewayVM(cfg GatewayConfig) error {
	if runtime.GOOS != "linux" {
		log.Printf("[gateway] Nexus-Shield is only supported on Linux; skipping on %s", runtime.GOOS)
		return nil
	}

	gatewayMu.Lock()
	defer gatewayMu.Unlock()

	// Stop any running instance first (idempotent)
	stopGateway()

	if cfg.ExternalPort == 0 {
		cfg.ExternalPort = 8080
	}

	nginxConf := buildNginxConfig(cfg)
	portMapping := fmt.Sprintf("%d:%s", cfg.ExternalPort, gatewayListenPort)

	// nginx:alpine doesn't support inline config via env; write it to a tmpfs.
	// We use a shell entry-point to write the config before starting nginx.
	entryPoint := fmt.Sprintf(
		`sh -c 'echo "%s" > /etc/nginx/conf.d/nexus.conf && nginx -g "daemon off;"'`,
		escapeShell(nginxConf),
	)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	args := []string{
		"run", "-d",
		"--name", gatewayContainerName,
		"--rm",
		"--memory", "64m",
		"--memory-swap", "64m",
		"--cpus", "0.25",
		"--network", "bridge",
		"--read-only",
		"--tmpfs", "/tmp",
		"--tmpfs", "/var/cache/nginx",
		"--tmpfs", "/var/run",
		"--security-opt", "no-new-privileges",
		"-p", portMapping,
		"nginx:alpine",
		"sh", "-c", entryPoint,
	}

	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("gateway start failed: %w — %s", err, strings.TrimSpace(string(out)))
	}

	log.Printf("[gateway] Nexus-Shield started: upstream=%s port=%d bandwidth=%dMbps",
		cfg.UpstreamAddr, cfg.ExternalPort, cfg.BandwidthMbps)
	return nil
}

// StopGatewayVM stops the Nexus-Shield container.  It is safe to call even if
// no container is running.
func StopGatewayVM() {
	gatewayMu.Lock()
	defer gatewayMu.Unlock()
	stopGateway()
}

// stopGateway is the internal (non-locking) stop helper.
func stopGateway() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "stop", gatewayContainerName).CombinedOutput()
	if err != nil {
		// Container not running is not an error we care about.
		if !strings.Contains(string(out), "No such container") {
			log.Printf("[gateway] stop: %v — %s", err, strings.TrimSpace(string(out)))
		}
	} else {
		log.Printf("[gateway] Nexus-Shield stopped")
	}
}

// IsGatewayRunning returns true if the Nexus-Shield container is currently up.
func IsGatewayRunning() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "ps", "--filter",
		"name="+gatewayContainerName, "--format", "{{.Names}}").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), gatewayContainerName)
}

// ── nginx config builder ──────────────────────────────────────────────────────

func buildNginxConfig(cfg GatewayConfig) string {
	// Convert Mbps → bytes/s for nginx limit_rate (0 = unlimited)
	var limitRate string
	if cfg.BandwidthMbps > 0 {
		bytesPerSec := cfg.BandwidthMbps * 125_000 // Mbps × 125_000 = bytes/s
		limitRate = fmt.Sprintf("limit_rate %d;", bytesPerSec)
	}

	upstream := cfg.UpstreamAddr
	if upstream == "" {
		upstream = "127.0.0.1:3000"
	}

	return fmt.Sprintf(`
server {
    listen %s;
    server_name _;

    access_log off;
    error_log  /dev/stderr warn;

    location / {
        proxy_pass         http://%s;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Nexus-Transit   "1";
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 60s;
        proxy_buffering    off;
        %s
    }
}`, gatewayListenPort, upstream, limitRate)
}

// escapeShell escapes double-quotes and backslashes so the config can be
// embedded in a shell double-quoted string.
func escapeShell(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}
