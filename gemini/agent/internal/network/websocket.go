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

	"github.com/10kk/agent/internal/docker"
	agentfs "github.com/10kk/agent/internal/fs"
	"github.com/10kk/agent/internal/metrics"
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
				b, err := json.Marshal(map[string]any{"type": "metrics", "data": m})
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
