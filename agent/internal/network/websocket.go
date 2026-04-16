package network

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/10kk/agent/internal/benchmark"
	"github.com/10kk/agent/internal/docker"
	agentfs "github.com/10kk/agent/internal/fs"
	"github.com/10kk/agent/internal/metrics"
	agentml "github.com/10kk/agent/internal/ml"
	"github.com/10kk/agent/internal/policy"
	agentrmm "github.com/10kk/agent/internal/rmm"
	"github.com/10kk/agent/internal/telemetry"
	"github.com/10kk/agent/internal/updater"
	agentvm "github.com/10kk/agent/internal/vm"
	agentwasm "github.com/10kk/agent/internal/wasm"
	"github.com/gorilla/websocket"
)

const (
	maxBackoff   = 60 * time.Second
	writeTimeout = 10 * time.Second
	pingInterval = 15 * time.Second

	// Maximum response body size for the reverse tunnel and file operations (10 MB).
	tunnelMaxBodyBytes = 10 * 1024 * 1024
)

// inboundMsg is the shape of commands received from the master.
type inboundMsg struct {
	Type        string            `json:"type"`
	Action      string            `json:"action"`
	ContainerID string            `json:"container_id,omitempty"`
	UpdateURL   string            `json:"url,omitempty"`
	Version     string            `json:"version,omitempty"`
	Command     string            `json:"command,omitempty"`
	SessionID   string            `json:"sessionId,omitempty"`
	// deploy fields
	Repo             string            `json:"repo,omitempty"`
	Branch           string            `json:"branch,omitempty"`
	ImageName        string            `json:"imageName,omitempty"`
	EnvVars          map[string]string `json:"envVars,omitempty"`
	ProxyHost        string            `json:"proxyHost,omitempty"`
	ProxyPort        int               `json:"proxyPort,omitempty"`
	HealthCheckURL   string            `json:"healthCheckUrl,omitempty"`
	HealthCheckDelay int               `json:"healthCheckDelay,omitempty"`
	// reverse-tunnel fields
	RequestID string            `json:"requestId,omitempty"`
	Method    string            `json:"method,omitempty"`
	Path      string            `json:"path,omitempty"`
	TargetURL string            `json:"targetUrl,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Body      string            `json:"body,omitempty"` // base64-encoded
	// port-scan fields
	StartPort int `json:"startPort,omitempty"`
	EndPort   int `json:"endPort,omitempty"`
	// file-manager fields
	FilePath    string `json:"filePath,omitempty"`
	DestPath    string `json:"destPath,omitempty"`
	FileContent string `json:"fileContent,omitempty"`
	Clean       bool   `json:"clean,omitempty"`
	// RequireGPU: when true the agent will add --gpus all to the docker run command
	RequireGPU  bool   `json:"requireGpu,omitempty"`
	// ── DePIN fields ──────────────────────────────────────────────────────────
	AppID     string            `json:"appId,omitempty"`
	AppSlug   string            `json:"appSlug,omitempty"`
	// WASM
	ModuleRef string            `json:"moduleRef,omitempty"` // path or base64 .wasm
	// MicroVM
	Image     string            `json:"image,omitempty"`
	Port      int               `json:"port,omitempty"`
	// Raft clustering
	RaftRole  string            `json:"raftRole,omitempty"`  // LEADER | FOLLOWER
	RaftPeers []string          `json:"raftPeers,omitempty"` // peer IP addresses
	// Policy hot-reload
	Policy *policy.NodePolicy `json:"policy,omitempty"`

	// ── Collective VM (Sprint 13) ─────────────────────────────────────────────
	IsCollectiveMember bool                  `json:"isCollectiveMember,omitempty"`
	CollectivePeers    []docker.CollectivePeer `json:"collectivePeers,omitempty"`
	CpuMillicores      int                   `json:"cpuMillicores,omitempty"` // 2000 = 2.0 vCPUs
	MemLimitMb         int                   `json:"memLimitMb,omitempty"`
	VramLimitMb        int                   `json:"vramLimitMb,omitempty"`
	MeshIP             string                `json:"meshIp,omitempty"`
	MasterMeshIP       string                `json:"masterMeshIp,omitempty"`
	Rank               int                   `json:"rank,omitempty"`
	WorldSize          int                   `json:"worldSize,omitempty"`
	AppType            string                `json:"appType,omitempty"` // "AI" | "WEB" | ""

	// ── Sprint 17.5 — Stress Test / Benchmark fields ──────────────────────────
	NtpEpochMs   int64 `json:"ntpEpochMs,omitempty"`  // UTC ms — coordinated start time
	DurationSecs int   `json:"durationSecs,omitempty"`
	JitterMaxMs  int   `json:"jitterMaxMs,omitempty"`

	// ── Sprint 18.1 — RMM/EDR ─────────────────────────────────────────────────
	PID int `json:"pid,omitempty"` // process ID for kill/inspect

	// ── Sprint 18.3 — Dual-Mesh ───────────────────────────────────────────────
	LANMeshIP  string `json:"lanMeshIp,omitempty"`  // 10.60.0.x
	WANMeshIP  string `json:"wanMeshIp,omitempty"`  // 10.70.0.x
	TenantMode string `json:"tenantMode,omitempty"` // "PUBLIC" | "PRIVATE"

	// ── Sprint 20.3 — CRIU Live Migration ─────────────────────────────────────
	DumpPath   string `json:"dumpPath,omitempty"`   // path to CRIU dump dir
	TargetAddr string `json:"targetAddr,omitempty"` // destination node mesh IP
}

// RunConnectionLoop dials the master and re-dials on any disconnect.
// It exits only when ctx is cancelled (agent shutdown).
func RunConnectionLoop(ctx context.Context, masterURL, token string, metricsCh <-chan metrics.HostMetrics) {
	attempt := 0
	for {
		select {
		case <-ctx.Done():
			docker.StopAllStreams()
			return
		default:
		}

		err := connect(ctx, masterURL, token, metricsCh)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			backoff := backoffDuration(attempt)
			log.Printf("[ws] disconnected (%v); reconnecting in %s", err, backoff)
			attempt++
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return
			}
		} else {
			attempt = 0
		}
	}
}

// connect establishes a single WebSocket session with the master.
func connect(ctx context.Context, masterURL, token string, metricsCh <-chan metrics.HostMetrics) error {
	tlsCfg, err := LoadTLSConfig()
	if err != nil {
		log.Printf("[ws] mTLS config error: %v — falling back to system TLS", err)
		tlsCfg = nil // the server may also accept non-mTLS connections
	}

	dialer := websocket.Dialer{
		TLSClientConfig:  tlsCfg,
		HandshakeTimeout: 10 * time.Second,
	}

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+token)
	headers.Set("X-Agent-OS", os.Getenv("GOOS"))
	headers.Set("X-Agent-Version", agentVersion())

	conn, _, err := dialer.DialContext(ctx, masterURL, headers)
	if err != nil {
		return err
	}
	defer conn.Close()

	log.Printf("[ws] connected to %s", masterURL)

	// Outbound channel — all goroutines write here; single writer sends to WS.
	outCh := make(chan []byte, 32)

	// --- Goroutine: relay metrics ---
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case m, ok := <-metricsCh:
				if !ok {
					return
				}
				// Sprint 12.2 — embed Sonar latency in every metrics heartbeat
			sonarMs := MeasureLatency()
			payload := map[string]any{"type": "metrics", "data": m}
			if sonarMs >= 0 {
				payload["sonarLatencyMs"] = sonarMs
			}
			b, err := json.Marshal(payload)
			if err == nil {
				outCh <- b
			}
			}
		}
	}()

	// --- Goroutine: periodic ping ---
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				b, _ := json.Marshal(map[string]string{"type": "ping"})
				outCh <- b
			}
		}
	}()

	// --- Goroutine: periodic telemetry ---
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				t, err := telemetry.Collect()
				if err == nil && t != nil {
					b, err := json.Marshal(map[string]any{"type": "telemetry", "payload": t})
					if err == nil {
						outCh <- b
					}
				}
			}
		}
	}()

	// --- Goroutine: read commands from master ---
	readErrCh := make(chan error, 1)
	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				readErrCh <- err
				return
			}
			var msg inboundMsg
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}
			handleCommand(ctx, msg, outCh)
		}
	}()

	// --- Main write loop ---
	for {
		select {
		case <-ctx.Done():
			conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "agent stopping"))
			return nil

		case b := <-outCh:
			conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
				return err
			}

		case err := <-readErrCh:
			return err
		}
	}
}

// handleCommand dispatches an inbound command from the master.
func handleCommand(ctx context.Context, msg inboundMsg, out chan<- []byte) {
	switch msg.Action {
	case "stream_logs":
		docker.StartStream(ctx, msg.ContainerID, out)

	case "stop_logs":
		docker.StopStream(msg.ContainerID)

	case "shell":
		go func() {
			send := func(v any) {
				b, err := json.Marshal(v)
				if err != nil {
					return
				}
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}

			// Use the OS-appropriate shell.
			var import_exec *exec.Cmd
			if runtime.GOOS == "windows" {
				if strings.TrimSpace(msg.Command) == "agent-uninstall-now" {
					send(map[string]any{"type": "shell_output", "sessionId": msg.SessionID, "message": "⚠️ Removendo Nexus Agent...\n"})
					exe, _ := os.Executable()
					exec.Command(exe, "-service", "stop").Run()
					exec.Command(exe, "-service", "uninstall").Run()
					os.Exit(0)
				}
				import_exec = exec.Command("cmd", "/C", msg.Command)
			} else {
				if strings.TrimSpace(msg.Command) == "agent-uninstall-now" {
					send(map[string]any{"type": "shell_output", "sessionId": msg.SessionID, "message": "⚠️ Removendo Nexus Agent...\n"})
					exe, _ := os.Executable()
					exec.Command("sudo", exe, "-service", "stop").Run()
					exec.Command("sudo", exe, "-service", "uninstall").Run()
					os.Exit(0)
				}
				import_exec = exec.Command("sh", "-c", msg.Command)
			}

			// We stream stdout/stderr live
			stdout, err := import_exec.StdoutPipe()
			if err != nil {
				send(map[string]any{"type": "shell_output", "sessionId": msg.SessionID, "message": "Exec error: " + err.Error() + "\n"})
				send(map[string]any{"type": "shell_exit", "sessionId": msg.SessionID, "code": -1})
				return
			}
			stderr, err := import_exec.StderrPipe()
			if err != nil {
				send(map[string]any{"type": "shell_output", "sessionId": msg.SessionID, "message": "Exec error: " + err.Error() + "\n"})
				send(map[string]any{"type": "shell_exit", "sessionId": msg.SessionID, "code": -1})
				return
			}

			if err := import_exec.Start(); err != nil {
				send(map[string]any{"type": "shell_output", "sessionId": msg.SessionID, "message": "Exec start error: " + err.Error() + "\n"})
				send(map[string]any{"type": "shell_exit", "sessionId": msg.SessionID, "code": -1})
				return
			}

			// Read loops
			go func() {
				buf := make([]byte, 1024)
				for {
					n, err := stdout.Read(buf)
					if n > 0 {
						send(map[string]any{"type": "shell_output", "sessionId": msg.SessionID, "message": string(buf[:n])})
					}
					if err != nil {
						break
					}
				}
			}()

			go func() {
				buf := make([]byte, 1024)
				for {
					n, err := stderr.Read(buf)
					if n > 0 {
						send(map[string]any{"type": "shell_output", "sessionId": msg.SessionID, "message": string(buf[:n])})
					}
					if err != nil {
						break
					}
				}
			}()

			err = import_exec.Wait()
			exitCode := 0
			if exitCodeErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitCodeErr.ExitCode()
			} else if err != nil {
				send(map[string]any{"type": "shell_output", "sessionId": msg.SessionID, "message": "\nCommand error: " + err.Error() + "\n"})
				exitCode = -1
			}

			send(map[string]any{"type": "shell_exit", "sessionId": msg.SessionID, "code": exitCode})
		}()

	case "remove":
		go func() {
			if msg.ImageName == "" {
				log.Printf("[remove] imageName is empty, skipping")
				return
			}
			log.Printf("[remove] stopping and removing container: %s", msg.ImageName)
			var stopCmd, rmCmd *exec.Cmd
			if runtime.GOOS == "windows" {
				stopCmd = exec.Command("docker", "stop", msg.ImageName)
				rmCmd   = exec.Command("docker", "rm", "-f", msg.ImageName)
			} else {
				stopCmd = exec.Command("docker", "stop", msg.ImageName)
				rmCmd   = exec.Command("docker", "rm", "-f", msg.ImageName)
			}
			if out, err := stopCmd.CombinedOutput(); err != nil {
				log.Printf("[remove] docker stop: %v — %s", err, string(out))
			}
			if out, err := rmCmd.CombinedOutput(); err != nil {
				log.Printf("[remove] docker rm: %v — %s", err, string(out))
			} else {
				log.Printf("[remove] container %s removed", msg.ImageName)
			}
		}()

	case "proxy_request":
		go handleProxyRequest(ctx, msg, out)

	case "scan_ports":
		go func() {
			start := msg.StartPort
			if start <= 0 {
				start = 1
			}
			end := msg.EndPort
			if end <= 0 || end > 65535 {
				end = 10000
			}
			log.Printf("[scan] starting port scan for %s (%d-%d)", msg.SessionID, start, end)
			ports := ScanActivePorts(ctx, start, end)
			resp := map[string]any{
				"type":      "scan_result",
				"requestId": msg.RequestID,
				"ports":     ports,
			}
			b, err := json.Marshal(resp)
			if err == nil {
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
		}()

	case "update":
		if msg.UpdateURL != "" && msg.Version != "" {
			go func() {
				if err := updater.DoUpdate(msg.UpdateURL, msg.Version); err != nil {
					log.Printf("[updater] failed: %v", err)
				}
			}()
		}

	case "deploy":
		go func() {
			send := func(v any) {
				b, err := json.Marshal(v)
				if err != nil {
					return
				}
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}

			logFn := func(line string) {
				send(map[string]string{"type": "log_line", "message": line})
			}

			req := docker.DeployRequest{
				Repo:             msg.Repo,
				Branch:           msg.Branch,
				ImageName:        msg.ImageName,
				EnvVars:          msg.EnvVars,
				ProxyHost:        msg.ProxyHost,
				ProxyPort:        msg.ProxyPort,
				HealthCheckURL:   msg.HealthCheckURL,
				HealthCheckDelay: msg.HealthCheckDelay,
				Clean:            msg.Clean,
				RequireGPU:       msg.RequireGPU,
			}

			result := docker.RunDeploy(ctx, req, logFn)

			if result.RolledBack {
				log.Printf("[deploy] rolled back: %v", result.Err)
				send(map[string]string{"type": "deploy_rolled_back", "message": result.Err.Error()})
				return
			}

			if result.Err != nil {
				log.Printf("[deploy] failed: %v", result.Err)
				send(map[string]string{"type": "deploy_failed", "message": result.Err.Error()})
				return
			}

			// If proxy labels were set, register the gateway route on the master
			if msg.ProxyHost != "" && msg.ProxyPort > 0 {
				send(map[string]any{
					"type":          "route_register",
					"host":          msg.ProxyHost,
					"port":          msg.ProxyPort,
					"containerName": msg.ImageName,
				})
			}

			send(map[string]string{"type": "deploy_done"})
		}()

	case "git_sync":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			logFn := func(line string) {
				send(map[string]string{"type": "log_line", "message": line})
			}
			err := docker.GitSync(ctx, msg.Repo, msg.Branch, msg.ImageName, logFn)
			if err != nil {
				send(map[string]any{"type": "git_sync_result", "requestId": msg.RequestID, "success": false, "error": err.Error()})
				return
			}
			send(map[string]any{"type": "git_sync_result", "requestId": msg.RequestID, "success": true})
		}()

	case "stop":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			if msg.ImageName == "" {
				send(map[string]any{"type": "container_action_result", "requestId": msg.RequestID, "success": false, "error": "imageName required"})
				return
			}
			if err := exec.CommandContext(ctx, docker.GetExecutable("docker"), "stop", msg.ImageName).Run(); err != nil {
				send(map[string]any{"type": "container_action_result", "requestId": msg.RequestID, "success": false, "error": err.Error()})
				return
			}
			send(map[string]any{"type": "container_action_result", "requestId": msg.RequestID, "success": true})
		}()

	case "restart":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			if msg.ImageName == "" {
				send(map[string]any{"type": "container_action_result", "requestId": msg.RequestID, "success": false, "error": "imageName required"})
				return
			}
			if err := exec.CommandContext(ctx, docker.GetExecutable("docker"), "restart", msg.ImageName).Run(); err != nil {
				send(map[string]any{"type": "container_action_result", "requestId": msg.RequestID, "success": false, "error": err.Error()})
				return
			}
			send(map[string]any{"type": "container_action_result", "requestId": msg.RequestID, "success": true})
		}()

	case "list_files":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			entries, err := agentfs.ListFiles(msg.ImageName, msg.FilePath)
			if err != nil {
				send(map[string]any{"type": "file_list", "requestId": msg.RequestID, "error": err.Error()})
				return
			}
			send(map[string]any{"type": "file_list", "requestId": msg.RequestID, "entries": entries})
		}()

	case "read_file":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			contentB64, err := agentfs.ReadFileB64(msg.ImageName, msg.FilePath)
			if err != nil {
				send(map[string]any{"type": "file_content", "requestId": msg.RequestID, "error": err.Error()})
				return
			}
			send(map[string]any{"type": "file_content", "requestId": msg.RequestID, "content": contentB64})
		}()

	case "write_file":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			if err := agentfs.WriteFileB64(msg.ImageName, msg.FilePath, msg.FileContent); err != nil {
				send(map[string]any{"type": "file_write_result", "requestId": msg.RequestID, "success": false, "error": err.Error()})
				return
			}
			send(map[string]any{"type": "file_write_result", "requestId": msg.RequestID, "success": true})
		}()

	case "delete_file":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			if err := agentfs.DeleteFile(msg.ImageName, msg.FilePath); err != nil {
				send(map[string]any{"type": "file_delete_result", "requestId": msg.RequestID, "success": false, "error": err.Error()})
				return
			}
			send(map[string]any{"type": "file_delete_result", "requestId": msg.RequestID, "success": true})
		}()

	case "copy_file":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			if msg.DestPath == "" {
				send(map[string]any{"type": "file_copy_result", "requestId": msg.RequestID, "success": false, "error": "destPath required"})
				return
			}
			if err := agentfs.CopyFile(msg.ImageName, msg.FilePath, msg.DestPath); err != nil {
				send(map[string]any{"type": "file_copy_result", "requestId": msg.RequestID, "success": false, "error": err.Error()})
				return
			}
			send(map[string]any{"type": "file_copy_result", "requestId": msg.RequestID, "success": true})
		}()

	case "move_file":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			if msg.DestPath == "" {
				send(map[string]any{"type": "file_move_result", "requestId": msg.RequestID, "success": false, "error": "destPath required"})
				return
			}
			if err := agentfs.MoveFile(msg.ImageName, msg.FilePath, msg.DestPath); err != nil {
				send(map[string]any{"type": "file_move_result", "requestId": msg.RequestID, "success": false, "error": err.Error()})
				return
			}
			send(map[string]any{"type": "file_move_result", "requestId": msg.RequestID, "success": true})
		}()

	// ── DePIN: WASM workload ──────────────────────────────────────────────────

	case "run_wasm":
		go func() {
			if msg.AppID == "" || msg.ModuleRef == "" {
				log.Printf("[wasm] run_wasm: missing appId or moduleRef")
				return
			}
			if err := agentwasm.Start(ctx, msg.AppID, msg.AppSlug, msg.ModuleRef, msg.EnvVars, out); err != nil {
				b, _ := json.Marshal(map[string]any{
					"type":    "log_line",
					"appId":   msg.AppID,
					"message": fmt.Sprintf("[wasm] start error: %v", err),
				})
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
		}()

	case "stop_wasm":
		go func() {
			if msg.AppID != "" {
				agentwasm.Stop(msg.AppID)
			}
		}()

	// ── DePIN: MicroVM workload ───────────────────────────────────────────────

	case "start_vm":
		go func() {
			if msg.AppID == "" {
				log.Printf("[vm] start_vm: missing appId")
				return
			}
			opts := agentvm.StartOptions{
				AppID:     msg.AppID,
				AppSlug:   msg.AppSlug,
				Image:     msg.Image,
				Port:      msg.Port,
				EnvVars:   msg.EnvVars,
				RaftRole:  msg.RaftRole,
				RaftPeers: msg.RaftPeers,
				OutCh:     out,
			}
			if err := agentvm.Start(ctx, opts); err != nil {
				b, _ := json.Marshal(map[string]any{
					"type":    "log_line",
					"appId":   msg.AppID,
					"message": fmt.Sprintf("[vm] start error: %v", err),
				})
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
		}()

	case "stop_vm":
		go func() {
			if msg.AppID != "" {
				if err := agentvm.Stop(msg.AppID); err != nil {
					log.Printf("[vm] stop error: %v", err)
				}
			}
		}()

	// ── Sprint 17.1: Hot-Resize — update cgroup v2 limits without restart ────────
	case "update_resources":
		go func() {
			if msg.AppSlug == "" {
				log.Printf("[resize] update_resources: missing appSlug")
				return
			}
			if err := HotResizeCgroup(msg.AppSlug, msg.CpuMillicores, msg.MemLimitMb); err != nil {
				log.Printf("[resize] cgroup update failed for %s: %v", msg.AppSlug, err)
			} else {
				log.Printf("[resize] %s → %dm CPU, %dMB RAM",
					msg.AppSlug, msg.CpuMillicores, msg.MemLimitMb)
			}
		}()

	// ── Policy hot-reload — reconfigure cgroups/Job Objects without restart ──────
	case "update_policy":
		if msg.Policy != nil {
			p := *msg.Policy
			policy.SetGlobal(p)
			log.Printf("[policy] hot-reload applied: CPU=%.0f%% RAM=%dMB bandwidth=%dMbps",
				p.MaxCPUPercent, p.MaxRAMMb, p.MaxBandwidthMbps)
		}

	// ── Network Transit: activate Nexus-Shield gateway VM (T10.2) ───────────────
	case "activate_transit":
		go func() {
			bwMbps := msg.Port // reuse Port field for bandwidth in Mbps (0 = unlimited)
			if bwMbps <= 0 {
				bwMbps = 100
			}
			upstream := msg.TargetURL
			if upstream == "" {
				upstream = "127.0.0.1:3000"
			}
			if err := agentvm.StartGatewayVM(agentvm.GatewayConfig{
				UpstreamAddr:  upstream,
				BandwidthMbps: bwMbps,
				ExternalPort:  8080,
			}); err != nil {
				log.Printf("[transit] StartGatewayVM error: %v", err)
			}
		}()

	// ── Network Transit: deactivate Nexus-Shield ──────────────────────────────
	case "deactivate_transit":
		go func() {
			agentvm.StopGatewayVM()
		}()

	// ── Sprint 18.3: Dual-Mesh (nexus-lan + nexus-wan) ──────────────────────────
	case "setup_dual_mesh":
		go func() {
			cfg := DualMeshConfig{
				LANMeshIP:  msg.LANMeshIP,
				WANMeshIP:  msg.WANMeshIP,
				TenantMode: msg.TenantMode,
			}
			if err := SetupDualMesh(cfg); err != nil {
				log.Printf("[dual_mesh] setup error: %v", err)
			}
		}()

	case "teardown_dual_mesh":
		go func() { TeardownDualMesh() }()

	// ── Sprint 20.3: CRIU Live Migration ─────────────────────────────────────────
	case "criu_checkpoint":
		go func() {
			if msg.AppSlug == "" || msg.DumpPath == "" {
				log.Printf("[criu] checkpoint: missing appSlug or dumpPath")
				return
			}
			if err := agentvm.CRIUCheckpoint(ctx, msg.AppSlug, msg.DumpPath); err != nil {
				log.Printf("[criu] checkpoint error: %v", err)
				b, _ := json.Marshal(map[string]any{
					"type":      "criu_checkpoint_result",
					"requestId": msg.RequestID,
					"success":   false,
					"error":     err.Error(),
				})
				select { case out <- b: case <-ctx.Done(): }
			} else {
				b, _ := json.Marshal(map[string]any{
					"type":      "criu_checkpoint_result",
					"requestId": msg.RequestID,
					"success":   true,
					"dumpPath":  msg.DumpPath,
				})
				select { case out <- b: case <-ctx.Done(): }
			}
		}()

	case "criu_restore":
		go func() {
			if msg.DumpPath == "" {
				log.Printf("[criu] restore: missing dumpPath")
				return
			}
			if err := agentvm.CRIURestore(ctx, msg.DumpPath); err != nil {
				log.Printf("[criu] restore error: %v", err)
				b, _ := json.Marshal(map[string]any{
					"type":      "criu_restore_result",
					"requestId": msg.RequestID,
					"success":   false,
					"error":     err.Error(),
				})
				select { case out <- b: case <-ctx.Done(): }
			} else {
				b, _ := json.Marshal(map[string]any{
					"type":      "criu_restore_result",
					"requestId": msg.RequestID,
					"success":   true,
				})
				select { case out <- b: case <-ctx.Done(): }
			}
		}()

	// ── Sprint 20.3: CRIU Dump Transfer ─────────────────────────────────────────
	case "criu_transfer":
		go func() {
			if msg.DumpPath == "" || msg.TargetAddr == "" {
				log.Printf("[criu] transfer: missing dumpPath or targetAddr")
				return
			}
			if err := agentvm.TransferDump(ctx, msg.DumpPath, msg.TargetAddr, "nexus"); err != nil {
				log.Printf("[criu] transfer error: %v", err)
				b, _ := json.Marshal(map[string]any{
					"type":      "criu_transfer_result",
					"requestId": msg.RequestID,
					"success":   false,
					"error":     err.Error(),
				})
				select { case out <- b: case <-ctx.Done(): }
			} else {
				b, _ := json.Marshal(map[string]any{
					"type":      "criu_transfer_result",
					"requestId": msg.RequestID,
					"success":   true,
					"dumpPath":  msg.DumpPath,
					"targetAddr": msg.TargetAddr,
				})
				select { case out <- b: case <-ctx.Done(): }
			}
		}()

	// ── WireGuard mesh setup (Sprint 12.1) ────────────────────────────────────
	case "setup_mesh":
		go func() {
			rawMsg, _ := json.Marshal(msg)
			HandleSetupMesh(rawMsg, out, ctx)
		}()

	// ── WireGuard mesh teardown ────────────────────────────────────────────────
	case "teardown_mesh":
		go func() {
			TeardownMesh()
			log.Println("[mesh] WireGuard overlay torn down")
		}()

	// ── M.A.D. Emergency Halt (Sprint 16.3) ──────────────────────────────────
	// Broadcast by Sentinel when a zero-day is detected.
	// Chain: kill workloads → tear down WireGuard → purge cgroups → os.Exit(0)
	case "emergency_halt":
		go func() {
			log.Println("[HALT] ⚠️  EMERGENCY HALT received — initiating shutdown sequence")

			// 1. Kill all Nexus Docker containers
			killOut, _ := exec.Command(
				docker.GetExecutable("docker"), "kill",
				"$("+docker.GetExecutable("docker")+" ps -q -f name=nexus)",
			).CombinedOutput()
			log.Printf("[HALT] docker kill: %s", strings.TrimSpace(string(killOut)))

			// Use a more portable shell pipe for Windows/Linux compatibility
			if runtime.GOOS == "windows" {
				_ = exec.Command("cmd", "/C",
					"FOR /f \"tokens=*\" %i IN ('docker ps -q -f name=nexus') DO docker kill %i",
				).Run()
			} else {
				_ = exec.Command("sh", "-c",
					"docker ps -q -f name=nexus | xargs -r docker kill",
				).Run()
			}

			// 2. Tear down WireGuard mesh overlay
			TeardownMesh()
			log.Println("[HALT] WireGuard mesh torn down")

			// 3. Remove cgroup v2 nexus slice (Linux only)
			if runtime.GOOS == "linux" {
				_ = exec.Command("cgdelete", "-r", "cpu,memory:nexus.slice").Run()
				log.Println("[HALT] cgroups purged")
			}

			// 4. Stop all active streams / log pipes
			docker.StopAllStreams()

			log.Println("[HALT] Shutdown complete — agent exiting now")
			os.Exit(0)
		}()

	// ── Collective VM workload (Sprint 13.1) ─────────────────────────────────
	case "start_collective_vm":
		go func() {
			send := func(v any) {
				b, err := json.Marshal(v)
				if err != nil {
					return
				}
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			logFn := func(line string) {
				send(map[string]any{"type": "log_line", "appId": msg.AppID, "message": line})
			}
			req := docker.CollectiveDeployRequest{
				AppID:         msg.AppID,
				AppSlug:       msg.AppSlug,
				Image:         msg.Image,
				Port:          msg.Port,
				CpuMillicores: msg.CpuMillicores,
				MemLimitMb:    msg.MemLimitMb,
				VramLimitMb:   msg.VramLimitMb,
				EnvVars:       msg.EnvVars,
				MeshIP:        msg.MeshIP,
				MasterMeshIP:  msg.MasterMeshIP,
				Rank:          msg.Rank,
				WorldSize:     msg.WorldSize,
				Peers:         msg.CollectivePeers,
				AppType:       msg.AppType,
			}
			if err := docker.RunCollectiveDeploy(ctx, req, logFn); err != nil {
				send(map[string]any{
					"type":    "log_line",
					"appId":   msg.AppID,
					"message": fmt.Sprintf("[collective] deploy error: %v", err),
				})
				return
			}
			send(map[string]any{
				"type":  "collective_vm_started",
				"appId": msg.AppID,
				"rank":  msg.Rank,
			})
		}()

	case "stop_collective_vm":
		go func() {
			if msg.AppSlug != "" {
				if err := docker.StopCollectiveDeploy(ctx, msg.AppSlug); err != nil {
					log.Printf("[collective] stop error: %v", err)
				}
			}
		}()

	// ── Sprint 18.1: RMM / EDR ───────────────────────────────────────────────────
	case "rmm_list_processes":
		agentrmm.HandleRMMListProcesses(msg.RequestID, out, ctx)

	case "rmm_kill_process":
		agentrmm.HandleRMMKillProcess(msg.RequestID, int32(msg.PID), out, ctx)

	case "rmm_scan_connections":
		agentrmm.HandleRMMScanConnections(msg.RequestID, out, ctx)

	// ── Sprint 21.1: Edge Training — federated gradient upload ───────────────────
	case "run_edge_training":
		go func() {
			agentml.RunEdgeTraining(ctx, out)
		}()

	// ── Sprint 17.4: Hybrid Benchmark Engine ─────────────────────────────────────
	case "run_benchmark":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			log.Println("[benchmark] 5-stage probe starting...")
			result := benchmark.RunBenchmark(ctx)
			send(map[string]any{
				"type":              "benchmark_result",
				"cpuGflops":         result.CPUGflops,
				"ramGbps":           result.RAMGbps,
				"storageIops":       result.StorageIOPS,
				"gpuTflops":         result.GPUTflops,
				"meshLatencyMs":     result.MeshLatencyMs,
				"meshBandwidthMbps": result.MeshBandwidthMbps,
				"peerLatencies":     result.PeerLatencies, // map[peerIP]avgRttMs
			})
			log.Printf("[benchmark] done: CPU=%.2fGF RAM=%.2fGB/s IOPS=%.0f GPU=%.2fTF mesh=%.1fms",
				result.CPUGflops, result.RAMGbps, result.StorageIOPS,
				result.GPUTflops, result.MeshLatencyMs)
		}()

	// ── Sprint 17.5: Global Swarm Stress Test ─────────────────────────────────────
	case "stress_test":
		go func() {
			send := func(v any) {
				b, _ := json.Marshal(v)
				select {
				case out <- b:
				case <-ctx.Done():
				}
			}
			// Wait until NTP epoch with random jitter so all agents don't hit master at once
			now := time.Now().UnixMilli()
			jitter := benchmark.RandomJitter(msg.JitterMaxMs)
			startAt := msg.NtpEpochMs + jitter
			if startAt > now {
				waitMs := startAt - now
				select {
				case <-time.After(time.Duration(waitMs) * time.Millisecond):
				case <-ctx.Done():
					return
				}
			}
			result := benchmark.RunStressTest(ctx, msg.DurationSecs)
			send(map[string]any{
				"type":         "stress_test_result",
				"cpuGflops":   result.CPUGflops,
				"ramGbps":     result.RAMGbps,
				"storageIops": result.StorageIOPS,
				"durationSecs": result.DurationSecs,
			})
		}()

	// ── NAT / public-IP discovery (T10.1) ─────────────────────────────────────
	case "discover_nat":
		go func() {
			ResetDiscovery()
			res := DiscoverPublicIP()
			payload, _ := json.Marshal(map[string]any{
				"type": "nat_discovery",
				"data": map[string]any{
					"publicIP":      res.PublicIP,
					"isPublic":      res.IsPublic,
					"upnpAvailable": res.UPnPAvailable,
				},
			})
			select {
			case out <- payload:
			case <-ctx.Done():
			}
		}()

	case "terminate":
		go func() {
			log.Println("[ws] terminate command received, uninstalling service...")
			exe, _ := os.Executable()
			if runtime.GOOS == "windows" {
				exec.Command(exe, "-service", "stop").Run()
				exec.Command(exe, "-service", "uninstall").Run()
			} else {
				exec.Command("sudo", exe, "-service", "stop").Run()
				exec.Command("sudo", exe, "-service", "uninstall").Run()
			}
			os.Exit(0)
		}()

	default:
		log.Printf("[ws] unknown action: %s", msg.Action)
	}
}

// handleProxyRequest performs a local HTTP request on behalf of the master
// and sends a proxy_response back through the WebSocket.
func handleProxyRequest(ctx context.Context, msg inboundMsg, out chan<- []byte) {
	sendResponse := func(statusCode int, headers map[string]string, bodyB64 string, errMsg string) {
		resp := map[string]any{
			"type":       "proxy_response",
			"requestId":  msg.RequestID,
			"statusCode": statusCode,
			"headers":    headers,
			"body":       bodyB64,
		}
		if errMsg != "" {
			resp["error"] = errMsg
		}
		b, err := json.Marshal(resp)
		if err != nil {
			return
		}
		select {
		case out <- b:
		case <-ctx.Done():
		}
	}

	if msg.RequestID == "" || msg.TargetURL == "" || msg.Method == "" {
		sendResponse(400, map[string]string{}, "", "missing requestId, targetUrl, or method")
		return
	}

	// Build the full target URL.
	targetURL := msg.TargetURL
	if len(msg.Path) > 0 && msg.Path != "/" {
		targetURL = fmt.Sprintf("%s%s", strings.TrimRight(msg.TargetURL, "/"), msg.Path)
	}

	// Decode the request body.
	var bodyReader io.Reader
	if msg.Body != "" {
		bodyBytes, err := base64.StdEncoding.DecodeString(msg.Body)
		if err != nil {
			sendResponse(400, map[string]string{}, "", "invalid base64 body: "+err.Error())
			return
		}
		bodyReader = bytes.NewReader(bodyBytes)
	}

	// Create the request with a 25s timeout (inside the master's 30s window).
	reqCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(reqCtx, msg.Method, targetURL, bodyReader)
	if err != nil {
		sendResponse(502, map[string]string{}, "", "failed to build request: "+err.Error())
		return
	}

	// Forward headers from the master.
	for k, v := range msg.Headers {
		httpReq.Header.Set(k, v)
	}

	client := &http.Client{
		// Don't follow redirects automatically — let the caller decide.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	httpResp, err := client.Do(httpReq)
	if err != nil {
		sendResponse(502, map[string]string{}, "", "request failed: "+err.Error())
		return
	}
	defer httpResp.Body.Close()

	// Read response body with a size cap.
	limited := io.LimitReader(httpResp.Body, tunnelMaxBodyBytes+1)
	respBytes, err := io.ReadAll(limited)
	if err != nil {
		sendResponse(502, map[string]string{}, "", "failed to read response body: "+err.Error())
		return
	}
	if int64(len(respBytes)) > tunnelMaxBodyBytes {
		sendResponse(502, map[string]string{}, "", fmt.Sprintf("response body exceeds %d bytes limit", tunnelMaxBodyBytes))
		return
	}

	// Collect response headers.
	respHeaders := make(map[string]string, len(httpResp.Header))
	for k, vals := range httpResp.Header {
		if len(vals) > 0 {
			respHeaders[k] = vals[0]
		}
	}

	sendResponse(httpResp.StatusCode, respHeaders, base64.StdEncoding.EncodeToString(respBytes), "")
}

// backoffDuration returns exponential backoff capped at maxBackoff.
func backoffDuration(attempt int) time.Duration {
	d := time.Duration(math.Pow(2, float64(attempt))) * time.Second
	if d > maxBackoff {
		return maxBackoff
	}
	return d
}

func agentVersion() string {
	if v := os.Getenv("AGENT_VERSION"); v != "" {
		return v
	}
	return "v1.0.0"
}
