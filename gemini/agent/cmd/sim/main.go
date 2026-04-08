// cmd/sim/main.go — Nexus DePIN Agent Simulator
//
// Lightweight stand-in for the production agent used during local Chaos
// Engineering tests. It connects to the backend WebSocket server, sends
// periodic heartbeat + telemetry, and handles DePIN workload commands.
//
// NEW: Each WASM workload now spins up a real HTTP echo server on a random
// port so that the backend DePIN Ingress can tunnel real HTTP requests
// through the WS and get responses back (proxy_request / proxy_response).
//
// Usage:
//
//	NEXUS_SKIP_TLS=1 go run cmd/sim/main.go \
//	  -master wss://localhost:8443 \
//	  -token  <agentJWT> \
//	  -name   node-1
package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// ── Config ───────────────────────────────────────────────────────────────────

var (
	masterURL = flag.String("master", envOr("AGENT_MASTER_URL", "wss://localhost:8443"), "Backend WSS URL")
	token     = flag.String("token", envOr("AGENT_TOKEN", ""), "Agent JWT token")
	nodeName  = flag.String("name", "sim-node", "Display name for this simulated node")
	skipTLS   = flag.Bool("skip-tls", envOr("NEXUS_SKIP_TLS", "") == "1", "Skip TLS verification (dev only)")
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ── WASM workload registry ────────────────────────────────────────────────────

type wasmJob struct {
	cancel   context.CancelFunc
	port     int
	appID    string
	appSlug  string
	mu       sync.Mutex
	reqCount int
}

var (
	wasmMu   sync.Mutex
	wasmJobs = map[string]*wasmJob{}
)

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	flag.Parse()

	if *token == "" {
		log.Fatal("[sim] -token is required. Use scripts/provision-nodes.sh to get one.")
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	log.Printf("[sim] ▶ starting as %q  →  %s", *nodeName, *masterURL)
	runLoop(ctx)
	log.Printf("[sim] ■ %q shut down cleanly", *nodeName)
}

// runLoop reconnects with exponential backoff on disconnect.
func runLoop(ctx context.Context) {
	backoff := time.Second
	for {
		if err := connect(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("[sim] disconnected (%v) — retry in %s", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
		} else {
			backoff = time.Second
		}
	}
}

func connect(ctx context.Context) error {
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if *skipTLS {
		tlsCfg.InsecureSkipVerify = true //nolint:gosec // dev only
	}

	dialer := websocket.Dialer{
		TLSClientConfig:  tlsCfg,
		HandshakeTimeout: 10 * time.Second,
	}

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+*token)
	headers.Set("X-Agent-OS", "sim/windows")
	headers.Set("X-Agent-Version", "sim-0.1.0")

	conn, _, err := dialer.DialContext(ctx, *masterURL, headers)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	log.Printf("[sim] ✅ %q connected to %s", *nodeName, *masterURL)

	outCh := make(chan []byte, 64)

	go sendTelemetry(ctx, outCh)
	go sendPings(ctx, outCh)

	// Writer goroutine
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-outCh:
				if !ok {
					return
				}
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					log.Printf("[sim] write error: %v", err)
					return
				}
			}
		}
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		handleMessage(ctx, raw, outCh)
	}
}

// ── Heartbeat / telemetry ─────────────────────────────────────────────────────

func sendPings(ctx context.Context, outCh chan<- []byte) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	pingMsg, _ := json.Marshal(map[string]any{"type": "ping"})
	select {
	case outCh <- pingMsg:
	default:
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			b, _ := json.Marshal(map[string]any{"type": "ping"})
			select {
			case outCh <- b:
			default:
			}
		}
	}
}

func sendTelemetry(ctx context.Context, outCh chan<- []byte) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()

	cpuBase := 20.0 + rand.Float64()*40
	memBase := 30.0 + rand.Float64()*30

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			cpu := clamp(cpuBase+(rand.Float64()*10-5), 0, 100)
			mem := clamp(memBase+(rand.Float64()*8-4), 0, 100)

			b, _ := json.Marshal(map[string]any{
				"type": "telemetry",
				"payload": map[string]any{
					"cpuPercent": cpu,
					"memPercent": mem,
					"timestamp":  time.Now().UnixMilli(),
				},
			})
			select {
			case outCh <- b:
			default:
			}
			log.Printf("[sim] %q  cpu=%.1f%%  mem=%.1f%%", *nodeName, cpu, mem)
		}
	}
}

// ── Command dispatch ─────────────────────────────────────────────────────────

func handleMessage(ctx context.Context, raw []byte, outCh chan<- []byte) {
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}

	action, _ := msg["action"].(string)
	if action == "" {
		action, _ = msg["type"].(string)
	}

	switch action {
	case "ping":
		reply(outCh, map[string]any{"type": "pong"})

	case "run_wasm":
		appID, _ := msg["appId"].(string)
		appSlug, _ := msg["appSlug"].(string)
		moduleRef, _ := msg["moduleRef"].(string)
		envVarsRaw, _ := msg["envVars"].(map[string]any)

		envVars := map[string]string{}
		for k, v := range envVarsRaw {
			if s, ok := v.(string); ok {
				envVars[k] = s
			}
		}
		go runWasm(ctx, appID, appSlug, moduleRef, envVars, outCh)

	case "stop_wasm":
		appID, _ := msg["appId"].(string)
		stopWasm(appID)

	// ── Ingress: tunnel HTTP requests through WS ──────────────────────────────
	case "proxy_request":
		requestID, _ := msg["requestId"].(string)
		method, _    := msg["method"].(string)
		path, _      := msg["path"].(string)
		targetURL, _ := msg["targetUrl"].(string)
		bodyB64, _   := msg["body"].(string)
		headersRaw, _ := msg["headers"].(map[string]any)

		if requestID == "" {
			log.Printf("[sim] proxy_request missing requestId — ignoring")
			return
		}

		headers := map[string]string{}
		for k, v := range headersRaw {
			if s, ok := v.(string); ok {
				headers[k] = s
			}
		}

		go handleProxyRequest(ctx, requestID, method, path, targetURL, bodyB64, headers, outCh)

	case "start_vm":
		appID, _ := msg["appId"].(string)
		log.Printf("[sim] start_vm for %s — Firecracker not supported in sim (Windows dev)", appID)
		reply(outCh, map[string]any{
			"type":    "vm_status",
			"appId":   appID,
			"status":  "skipped",
			"message": "Firecracker not available in simulator (Windows dev mode)",
		})

	case "stop_vm":
		appID, _ := msg["appId"].(string)
		log.Printf("[sim] stop_vm for %s (no-op in sim)", appID)

	default:
		if action != "" {
			log.Printf("[sim] unhandled action: %s", action)
		}
	}
}

// ── HTTP Proxy tunnel ─────────────────────────────────────────────────────────

// handleProxyRequest responds to ingress HTTP requests inline (no loopback TCP).
// The simulator generates a realistic JSON response directly, avoiding Windows
// loopback TCP restrictions in go-run subprocess environments.
func handleProxyRequest(
	_ context.Context,
	requestID, method, path, _ /* targetURL */, bodyB64 string,
	headers map[string]string,
	outCh chan<- []byte,
) {
	sendResp := func(statusCode int, respHeaders map[string]string, respBodyB64, errMsg string) {
		b, _ := json.Marshal(map[string]any{
			"type":       "proxy_response",
			"requestId":  requestID,
			"statusCode": statusCode,
			"headers":    respHeaders,
			"body":       respBodyB64,
			"error":      errMsg,
		})
		select {
		case outCh <- b:
		default:
		}
	}

	// Find a running WASM job for this node
	wasmMu.Lock()
	var job *wasmJob
	for _, j := range wasmJobs {
		job = j
		break
	}
	wasmMu.Unlock()

	if job == nil {
		sendResp(503, map[string]string{"content-type": "application/json"}, "", "no running WASM worker on this node")
		return
	}

	job.mu.Lock()
	job.reqCount++
	reqNo := job.reqCount
	job.mu.Unlock()

	// Decode incoming body if present
	bodyStr := ""
	if bodyB64 != "" {
		if bodyBytes, err := base64.StdEncoding.DecodeString(bodyB64); err == nil {
			bodyStr = string(bodyBytes)
		}
	}

	// Build simulated response — mirrors what a real WASM HTTP worker would return
	payload, _ := json.Marshal(map[string]any{
		"ok":        true,
		"node":      *nodeName,
		"appSlug":   job.appSlug,
		"method":    method,
		"path":      path,
		"body":      bodyStr,
		"requestNo": reqNo,
		"ts":        time.Now().UTC().Format(time.RFC3339Nano),
		"message":   fmt.Sprintf("🟢 DePIN response from %q — request #%d", *nodeName, reqNo),
		"headers":   headers,
	})

	respHeaders := map[string]string{
		"content-type": "application/json",
		"x-served-by":  *nodeName,
	}

	log.Printf("[sim] 🌐 proxy %s %s → 200 req#%d (%s)", method, path, reqNo, *nodeName)
	sendResp(200, respHeaders, base64.StdEncoding.EncodeToString(payload), "")
}

// ── WASM workload with embedded HTTP echo server ───────────────────────────────

func runWasm(ctx context.Context, appID, appSlug, moduleRef string, envVars map[string]string, outCh chan<- []byte) {
	jobCtx, cancel := context.WithCancel(ctx)

	// Pick a random free port for the local HTTP server
	port, err := freePort()
	if err != nil {
		log.Printf("[sim] runWasm: cannot find free port: %v", err)
		cancel()
		return
	}

	job := &wasmJob{cancel: cancel, port: port, appID: appID, appSlug: appSlug}

	wasmMu.Lock()
	if old, exists := wasmJobs[appID]; exists {
		old.cancel()
	}
	wasmJobs[appID] = job
	wasmMu.Unlock()

	defer func() {
		wasmMu.Lock()
		if wasmJobs[appID] == job {
			delete(wasmJobs, appID)
		}
		wasmMu.Unlock()
		cancel()
	}()

	log.Printf("[sim] 🚀 run_wasm  app=%s  slug=%s  port=%d", appID, appSlug, port)

	// Start the local HTTP echo server for this workload
	srv := startEchoServer(jobCtx, port, appID, appSlug)
	defer srv.Shutdown(context.Background())

	// Run the simulated batch processing loop
	simulateWasmOutput(jobCtx, appID, appSlug, outCh)
}

// startEchoServer launches a tiny HTTP server that returns JSON responses.
// This is what the ingress gateway will actually reach via the WS tunnel.
func startEchoServer(ctx context.Context, port int, appID, appSlug string) *http.Server {
	mux := http.NewServeMux()

	counter := 0
	var mu sync.Mutex

	// Catch-all handler — responds to any path
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		counter++
		c := counter
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Served-By", *nodeName)
		w.Header().Set("X-App-ID", appID)
		w.WriteHeader(200)

		bodyBytes, _ := io.ReadAll(io.LimitReader(r.Body, 1024*64))
		json.NewEncoder(w).Encode(map[string]any{
			"ok":        true,
			"node":      *nodeName,
			"appSlug":   appSlug,
			"method":    r.Method,
			"path":      r.URL.Path,
			"query":     r.URL.RawQuery,
			"body":      string(bodyBytes),
			"requestNo": c,
			"ts":        time.Now().UTC().Format(time.RFC3339Nano),
			"message":   fmt.Sprintf("🟢 Response from DePIN node %q — request #%d", *nodeName, c),
		})
	})

	srv := &http.Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", port),
		Handler: mux,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[sim] echo server error (port %d): %v", port, err)
		}
	}()

	go func() {
		<-ctx.Done()
		srv.Shutdown(context.Background())
	}()

	log.Printf("[sim] 🌐 echo server listening on 127.0.0.1:%d  (app=%s)", port, appSlug)
	return srv
}

// simulateWasmOutput mimics a running WASM batch workload.
func simulateWasmOutput(ctx context.Context, appID, appSlug string, outCh chan<- []byte) {
	tick  := time.NewTicker(5 * time.Second)
	usage := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	defer usage.Stop()

	counter := 0
	start   := time.Now()

	for {
		select {
		case <-ctx.Done():
			log.Printf("[sim] 🛑 wasm worker stopped  app=%s", appID)
			return

		case <-tick.C:
			counter++
			log.Printf("[sim] 🔵 [%s] Worker lote #%d em %q", appSlug, counter, *nodeName)

		case t := <-usage.C:
			windowStart := t.Add(-30 * time.Second)
			b, _ := json.Marshal(map[string]any{
				"type":        "usage_report",
				"appId":       appID,
				"cpuMs":       50 * 30,
				"ramMbS":      64 * 30,
				"netRxBytes":  1024 * 10,
				"netTxBytes":  1024 * 5,
				"windowStart": windowStart.UTC().Format(time.RFC3339),
				"windowEnd":   t.UTC().Format(time.RFC3339),
				"uptimeSec":   int(time.Since(start).Seconds()),
			})
			select {
			case outCh <- b:
			default:
			}
		}
	}
}

func stopWasm(appID string) {
	wasmMu.Lock()
	defer wasmMu.Unlock()
	if job, ok := wasmJobs[appID]; ok {
		job.cancel()
		delete(wasmJobs, appID)
		log.Printf("[sim] stopped wasm app %s", appID)
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func reply(outCh chan<- []byte, payload map[string]any) {
	b, _ := json.Marshal(payload)
	select {
	case outCh <- b:
	default:
	}
}

func clamp(v, min, max float64) float64 {
	if v < min { return min }
	if v > max { return max }
	return v
}

func freePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}
