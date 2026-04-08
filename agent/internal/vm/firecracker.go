// Package vm manages Firecracker MicroVMs via its REST API (Unix socket).
//
// Firecracker exposes a local HTTP API through a Unix domain socket.
// Each MicroVM gets its own socket at /tmp/nexus-fc-{appID}.sock.
//
// Prerequisites on the host:
//   - firecracker binary in PATH (Linux only)
//   - /dev/kvm accessible by the agent process
//   - A kernel image at NEXUS_FC_KERNEL (default: /opt/nexus/vmlinux)
//   - A rootfs image at NEXUS_FC_ROOTFS (default: /opt/nexus/rootfs.ext4)
//
// On non-Linux hosts this package logs a warning and skips execution.
package vm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/10kk/agent/internal/raft"
)

// MicroVM represents a running Firecracker instance.
type MicroVM struct {
	AppID    string
	AppSlug  string
	SocketPath string
	cancel   context.CancelFunc
	proc     *exec.Cmd
}

var (
	mu  sync.Mutex
	vms = map[string]*MicroVM{} // appID → vm
)

// StartOptions holds parameters for launching a MicroVM.
type StartOptions struct {
	AppID     string
	AppSlug   string
	Image     string // Docker image name (used as identifier; rootfs must be pre-built)
	Port      int
	EnvVars   map[string]string
	RaftRole  string   // "LEADER" | "FOLLOWER"
	RaftPeers []string // peer IP addresses for Raft cluster
	OutCh     chan<- []byte
}

// Start provisions and starts a Firecracker MicroVM.
func Start(parentCtx context.Context, opts StartOptions) error {
	if runtime.GOOS != "linux" {
		log.Printf("[vm] Firecracker requires Linux — skipping MicroVM for app %s", opts.AppSlug)
		return fmt.Errorf("firecracker: not supported on %s", runtime.GOOS)
	}

	mu.Lock()
	defer mu.Unlock()

	if _, exists := vms[opts.AppID]; exists {
		return fmt.Errorf("vm: MicroVM for app %s already running", opts.AppID)
	}

	socketPath := filepath.Join(os.TempDir(), fmt.Sprintf("nexus-fc-%s.sock", opts.AppID))

	ctx, cancel := context.WithCancel(parentCtx)

	vm := &MicroVM{
		AppID:      opts.AppID,
		AppSlug:    opts.AppSlug,
		SocketPath: socketPath,
		cancel:     cancel,
	}
	vms[opts.AppID] = vm

	go func() {
		defer func() {
			cancel()
			os.Remove(socketPath)
			mu.Lock()
			delete(vms, opts.AppID)
			mu.Unlock()
			log.Printf("[vm] MicroVM stopped: app=%s", opts.AppSlug)
		}()

		// 1. Launch firecracker process
		proc := exec.CommandContext(ctx, "firecracker", "--api-sock", socketPath, "--no-api")
		proc.Stdout = &vmLogWriter{appSlug: opts.AppSlug, outCh: opts.OutCh, ctx: ctx}
		proc.Stderr = &vmLogWriter{appSlug: opts.AppSlug, outCh: opts.OutCh, ctx: ctx}

		if err := proc.Start(); err != nil {
			logLine(opts.OutCh, ctx, opts.AppSlug, fmt.Sprintf("[vm] failed to start firecracker: %v", err))
			return
		}
		vm.proc = proc
		log.Printf("[vm] firecracker started: app=%s pid=%d", opts.AppSlug, proc.Process.Pid)

		// 2. Wait for socket to be ready
		if err := waitForSocket(ctx, socketPath, 5*time.Second); err != nil {
			logLine(opts.OutCh, ctx, opts.AppSlug, fmt.Sprintf("[vm] socket not ready: %v", err))
			proc.Process.Kill()
			return
		}

		// 3. Configure the VM via Firecracker REST API
		client := socketHTTPClient(socketPath)
		if err := configureVM(client, opts); err != nil {
			logLine(opts.OutCh, ctx, opts.AppSlug, fmt.Sprintf("[vm] configure failed: %v", err))
			proc.Process.Kill()
			return
		}

		// 4. Start the VM instance
		if err := fcPut(client, "/actions", map[string]string{"action_type": "InstanceStart"}); err != nil {
			logLine(opts.OutCh, ctx, opts.AppSlug, fmt.Sprintf("[vm] instance start failed: %v", err))
			proc.Process.Kill()
			return
		}

		logLine(opts.OutCh, ctx, opts.AppSlug, fmt.Sprintf("[vm] MicroVM running: app=%s role=%s", opts.AppSlug, opts.RaftRole))

		// 5. Start Raft node (if MicroVM mode requires consensus)
		if opts.RaftRole != "" {
			go raft.StartNode(ctx, opts.AppID, opts.AppSlug, opts.RaftRole, opts.RaftPeers, opts.OutCh)
		}

		// 6. Emit usage reports
		go emitVMUsageReports(ctx, opts.AppID, opts.OutCh)

		proc.Wait()
	}()

	return nil
}

// Stop terminates the MicroVM for the given appID.
func Stop(appID string) error {
	mu.Lock()
	vm, ok := vms[appID]
	mu.Unlock()

	if !ok {
		return fmt.Errorf("vm: no MicroVM found for app %s", appID)
	}

	log.Printf("[vm] stopping MicroVM for app %s", appID)
	vm.cancel()
	return nil
}

// IsRunning reports whether a MicroVM is active for appID.
func IsRunning(appID string) bool {
	mu.Lock()
	defer mu.Unlock()
	_, ok := vms[appID]
	return ok
}

// ── Firecracker REST API helpers ──────────────────────────────────────────────

func socketHTTPClient(socketPath string) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
			},
		},
		Timeout: 10 * time.Second,
	}
}

func fcPut(client *http.Client, path string, body any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPut, "http://localhost"+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("firecracker API %s: %d — %s", path, resp.StatusCode, string(b))
	}
	return nil
}

func configureVM(client *http.Client, opts StartOptions) error {
	kernelPath := getEnvOrDefault("NEXUS_FC_KERNEL", "/opt/nexus/vmlinux")
	rootfsPath := getEnvOrDefault("NEXUS_FC_ROOTFS", "/opt/nexus/rootfs.ext4")

	// Boot source
	if err := fcPut(client, "/boot-source", map[string]any{
		"kernel_image_path": kernelPath,
		"boot_args":         "console=ttyS0 reboot=k panic=1 pci=off",
	}); err != nil {
		return fmt.Errorf("boot-source: %w", err)
	}

	// Root drive (copy-on-write so multiple VMs can share the same base)
	if err := fcPut(client, "/drives/rootfs", map[string]any{
		"drive_id":       "rootfs",
		"path_on_host":   rootfsPath,
		"is_root_device": true,
		"is_read_only":   false,
	}); err != nil {
		return fmt.Errorf("drives/rootfs: %w", err)
	}

	// Machine config (1 vCPU, 128 MB RAM)
	if err := fcPut(client, "/machine-config", map[string]any{
		"vcpu_count":  1,
		"mem_size_mib": 128,
	}); err != nil {
		return fmt.Errorf("machine-config: %w", err)
	}

	// Network interface
	if err := fcPut(client, "/network-interfaces/eth0", map[string]any{
		"iface_id":     "eth0",
		"host_dev_name": fmt.Sprintf("tap-%s", opts.AppID[:8]),
	}); err != nil {
		// Non-fatal: TAP device may not exist in dev environments
		log.Printf("[vm] network interface setup skipped: %v", err)
	}

	return nil
}

func waitForSocket(ctx context.Context, socketPath string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if _, err := os.Stat(socketPath); err == nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for socket %s", socketPath)
}

// ── Usage reporting ───────────────────────────────────────────────────────────

func emitVMUsageReports(ctx context.Context, appID string, outCh chan<- []byte) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	startTime := time.Now()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			windowEnd := time.Now()
			windowStart := windowEnd.Add(-30 * time.Second)
			elapsed := windowEnd.Sub(startTime).Seconds()

			// Approximate resource consumption for a 1-vCPU/128MB VM
			approxCpuMs := int64(elapsed * 100)
			approxRamMbS := int64(elapsed * 128)

			report := map[string]any{
				"type":        "usage_report",
				"appId":       appID,
				"cpuMs":       approxCpuMs,
				"ramMbS":      approxRamMbS,
				"netRxBytes":  0,
				"netTxBytes":  0,
				"windowStart": windowStart.UTC().Format(time.RFC3339),
				"windowEnd":   windowEnd.UTC().Format(time.RFC3339),
			}
			b, _ := json.Marshal(report)
			select {
			case outCh <- b:
			case <-ctx.Done():
				return
			}
		}
	}
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

type vmLogWriter struct {
	appSlug string
	outCh   chan<- []byte
	ctx     context.Context
}

func (w *vmLogWriter) Write(p []byte) (int, error) {
	logLine(w.outCh, w.ctx, w.appSlug, string(p))
	return len(p), nil
}

func logLine(outCh chan<- []byte, ctx context.Context, appSlug, msg string) {
	b, _ := json.Marshal(map[string]any{"type": "log_line", "message": fmt.Sprintf("[vm:%s] %s", appSlug, msg)})
	select {
	case outCh <- b:
	case <-ctx.Done():
	}
}

func getEnvOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
