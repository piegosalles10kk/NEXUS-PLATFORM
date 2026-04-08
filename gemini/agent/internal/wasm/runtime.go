// Package wasm executes WebAssembly modules via the wasmtime CLI.
// Each app gets an isolated goroutine; stdout/stderr are captured for logs.
// Usage reports are emitted periodically via the outCh channel.
package wasm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// Worker represents a running WASM workload.
type Worker struct {
	AppID   string
	AppSlug string
	cancel  context.CancelFunc
	cmd     *exec.Cmd
}

var (
	mu      sync.Mutex
	workers = map[string]*Worker{} // appID → worker
)

// Start launches a WASM module for the given app.
// moduleRef is either a file path or a base64-encoded .wasm binary.
// outCh receives log lines and usage reports destined for the Gateway.
func Start(
	parentCtx context.Context,
	appID, appSlug, moduleRef string,
	envVars map[string]string,
	outCh chan<- []byte,
) error {
	mu.Lock()
	defer mu.Unlock()

	if _, exists := workers[appID]; exists {
		return fmt.Errorf("wasm: worker for app %s already running", appID)
	}

	// Resolve or write the module to a temp file
	modulePath, cleanup, err := resolveModule(appID, moduleRef)
	if err != nil {
		return fmt.Errorf("wasm: resolve module: %w", err)
	}

	ctx, cancel := context.WithCancel(parentCtx)

	w := &Worker{
		AppID:   appID,
		AppSlug: appSlug,
		cancel:  cancel,
	}
	workers[appID] = w

	go func() {
		defer func() {
			cancel()
			if cleanup != nil {
				cleanup()
			}
			mu.Lock()
			delete(workers, appID)
			mu.Unlock()
			log.Printf("[wasm] worker stopped: app=%s", appSlug)
		}()

		send := func(v any) {
			b, err := json.Marshal(v)
			if err != nil {
				return
			}
			select {
			case outCh <- b:
			case <-ctx.Done():
			}
		}

		// Build wasmtime command
		args := []string{"run"}
		for k, v := range envVars {
			args = append(args, "--env", fmt.Sprintf("%s=%s", k, v))
		}
		args = append(args, modulePath)

		cmd := exec.CommandContext(ctx, "wasmtime", args...)
		w.cmd = cmd

		// Capture output
		cmd.Stdout = &logWriter{appSlug: appSlug, outCh: outCh, ctx: ctx}
		cmd.Stderr = &logWriter{appSlug: appSlug, outCh: outCh, ctx: ctx}

		startTime := time.Now()
		if err := cmd.Start(); err != nil {
			send(map[string]any{
				"type":    "log_line",
				"appId":   appID,
				"message": fmt.Sprintf("[wasm] failed to start: %v", err),
			})
			return
		}

		log.Printf("[wasm] started: app=%s pid=%d", appSlug, cmd.Process.Pid)

		// Emit usage reports every 30s
		go emitUsageReports(ctx, appID, startTime, outCh)

		if err := cmd.Wait(); err != nil && ctx.Err() == nil {
			send(map[string]any{
				"type":    "log_line",
				"appId":   appID,
				"message": fmt.Sprintf("[wasm] process exited: %v", err),
			})
		}
	}()

	return nil
}

// Stop cancels the WASM worker for the given appID.
func Stop(appID string) {
	mu.Lock()
	w, ok := workers[appID]
	mu.Unlock()

	if !ok {
		return
	}

	log.Printf("[wasm] stopping worker for app %s", appID)
	w.cancel()
}

// IsRunning reports whether a worker is active for appID.
func IsRunning(appID string) bool {
	mu.Lock()
	defer mu.Unlock()
	_, ok := workers[appID]
	return ok
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// resolveModule returns a filesystem path to the .wasm file.
// If moduleRef looks like a base64 payload, it writes it to a temp file.
func resolveModule(appID, moduleRef string) (path string, cleanup func(), err error) {
	// Check if it's a local path
	if _, statErr := os.Stat(moduleRef); statErr == nil {
		return moduleRef, nil, nil
	}

	// Try to decode as base64
	data, decErr := base64.StdEncoding.DecodeString(moduleRef)
	if decErr != nil {
		return "", nil, fmt.Errorf("moduleRef is not a valid path or base64: %w", decErr)
	}

	tmp, err := os.CreateTemp("", fmt.Sprintf("nexus-wasm-%s-*.wasm", appID))
	if err != nil {
		return "", nil, err
	}

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", nil, err
	}
	tmp.Close()

	tmpPath := filepath.Clean(tmp.Name())
	return tmpPath, func() { os.Remove(tmpPath) }, nil
}

// logWriter streams wasmtime output lines as log_line WS messages.
type logWriter struct {
	appSlug string
	outCh   chan<- []byte
	ctx     context.Context
}

func (lw *logWriter) Write(p []byte) (int, error) {
	msg := map[string]any{
		"type":    "log_line",
		"message": string(p),
	}
	b, _ := json.Marshal(msg)
	select {
	case lw.outCh <- b:
	case <-lw.ctx.Done():
	}
	return len(p), nil
}

// emitUsageReports sends approximate usage metrics every 30s.
// Real CPU/RAM tracking would require cgroup integration (see US-1.1).
func emitUsageReports(ctx context.Context, appID string, startTime time.Time, outCh chan<- []byte) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			windowEnd := time.Now()
			windowStart := windowEnd.Add(-30 * time.Second)
			elapsed := windowEnd.Sub(startTime).Seconds()
			// Approximate: 5% CPU of 1 core = 50ms per second
			approxCpuMs := int64(elapsed * 50)
			// Approximate: 64 MB constant RAM usage
			approxRamMbS := int64(elapsed * 64)

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
