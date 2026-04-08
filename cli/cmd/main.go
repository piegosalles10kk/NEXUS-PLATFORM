// nexus — Nexus DePIN Cloud CLI
//
// Usage:
//   nexus deploy [flags]
//   nexus apps
//   nexus logs <app-slug>
//   nexus remove <app-slug>
//
// Configuration (env vars or ~/.nexus/config):
//   NEXUS_URL    — Gateway base URL (e.g. https://gateway.nexus.io)
//   NEXUS_TOKEN  — API JWT token
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		printHelp()
		os.Exit(0)
	}

	switch os.Args[1] {
	case "deploy":
		cmdDeploy(os.Args[2:])
	case "apps":
		cmdApps()
	case "remove":
		if len(os.Args) < 3 {
			fatal("usage: nexus remove <app-slug>")
		}
		cmdRemove(os.Args[2])
	case "version", "--version", "-v":
		fmt.Printf("nexus CLI v%s\n", version)
	case "help", "--help", "-h":
		printHelp()
	default:
		fatalf("unknown command: %s\nRun 'nexus help' for usage.", os.Args[1])
	}
}

// ── nexus deploy ──────────────────────────────────────────────────────────────

func cmdDeploy(args []string) {
	// Simple flag parsing
	var (
		name     string
		slug     string
		mode     = "auto"   // auto | wasm | microvm
		image    string
		port     = 8080
		region   string
		replicas = 3
		codeHint string
	)

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--name":
			name = nextArg(args, &i, "--name")
		case "--slug":
			slug = nextArg(args, &i, "--slug")
		case "--mode":
			mode = nextArg(args, &i, "--mode")
		case "--image":
			image = nextArg(args, &i, "--image")
		case "--port":
			fmt.Sscanf(nextArg(args, &i, "--port"), "%d", &port)
		case "--region":
			region = nextArg(args, &i, "--region")
		case "--replicas":
			fmt.Sscanf(nextArg(args, &i, "--replicas"), "%d", &replicas)
		case "--hint":
			codeHint = nextArg(args, &i, "--hint")
		}
	}

	// Derive slug from current directory if not provided
	if slug == "" {
		cwd, _ := os.Getwd()
		slug = strings.ToLower(filepath.Base(cwd))
	}
	if name == "" {
		name = slug
	}

	// Auto-detect Dockerfile if no image specified
	if image == "" {
		if _, err := os.Stat("Dockerfile"); err == nil {
			image = slug + ":latest"
			fmt.Printf("📦 Detected Dockerfile — image: %s\n", image)
		}
	}

	// Auto-detect code hint from package.json / go.mod / requirements.txt
	if codeHint == "" {
		codeHint = autoDetectHint()
	}

	fmt.Printf("🚀 Deploying \033[1m%s\033[0m (mode=%s, replicas=%d)\n", name, mode, replicas)

	payload := map[string]any{
		"name":         name,
		"slug":         slug,
		"executionMode": strings.ToUpper(mode),
		"imageRef":     image,
		"port":         port,
		"replicaCount": replicas,
		"codeHint":     codeHint,
	}
	if region != "" {
		payload["region"] = region
	}

	resp := apiPost("/api/v1/scheduler/deploy", payload)
	printJSON(resp)
}

// ── nexus apps ────────────────────────────────────────────────────────────────

func cmdApps() {
	fmt.Println("📋 Active DePIN apps:")
	data := apiGet("/api/v1/scheduler/apps")

	apps, _ := data["apps"].([]any)
	if len(apps) == 0 {
		fmt.Println("  (no apps deployed)")
		return
	}

	for _, a := range apps {
		app, _ := a.(map[string]any)
		slug    := getString(app, "slug")
		status  := getString(app, "status")
		mode    := getString(app, "executionMode")
		assigns, _ := app["assignments"].([]any)

		statusIcon := "🟢"
		if status == "DEGRADED" {
			statusIcon = "🟡"
		} else if status == "OFFLINE" {
			statusIcon = "🔴"
		}

		fmt.Printf("  %s \033[1m%s\033[0m  [%s]  nodes:%d\n",
			statusIcon, slug, mode, len(assigns))
	}
}

// ── nexus remove ─────────────────────────────────────────────────────────────

func cmdRemove(slug string) {
	// Find app ID by slug
	data := apiGet("/api/v1/scheduler/apps")
	apps, _ := data["apps"].([]any)

	var appID string
	for _, a := range apps {
		app, _ := a.(map[string]any)
		if getString(app, "slug") == slug {
			appID = getString(app, "id")
			break
		}
	}

	if appID == "" {
		fatalf("app not found: %s", slug)
	}

	apiDelete(fmt.Sprintf("/api/v1/scheduler/apps/%s", appID))
	fmt.Printf("✅ App \033[1m%s\033[0m removed.\n", slug)
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

func getBaseURL() string {
	if u := os.Getenv("NEXUS_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	return "http://localhost:4500"
}

func getToken() string {
	return os.Getenv("NEXUS_TOKEN")
}

func newClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}

func apiGet(path string) map[string]any {
	req, _ := http.NewRequest(http.MethodGet, getBaseURL()+path, nil)
	req.Header.Set("Authorization", "Bearer "+getToken())
	resp, err := newClient().Do(req)
	if err != nil {
		fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	return parseResponse(resp)
}

func apiPost(path string, body any) map[string]any {
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, getBaseURL()+path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+getToken())
	resp, err := newClient().Do(req)
	if err != nil {
		fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	return parseResponse(resp)
}

func apiDelete(path string) {
	req, _ := http.NewRequest(http.MethodDelete, getBaseURL()+path, nil)
	req.Header.Set("Authorization", "Bearer "+getToken())
	resp, err := newClient().Do(req)
	if err != nil {
		fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	io.ReadAll(resp.Body)
}

func parseResponse(resp *http.Response) map[string]any {
	b, _ := io.ReadAll(resp.Body)
	var wrapper map[string]any
	if err := json.Unmarshal(b, &wrapper); err != nil {
		fatalf("invalid JSON response: %s", string(b))
	}
	if resp.StatusCode >= 400 {
		msg, _ := wrapper["message"].(string)
		fatalf("API error %d: %s", resp.StatusCode, msg)
	}
	data, _ := wrapper["data"].(map[string]any)
	return data
}

// ── Auto-detect code hint ─────────────────────────────────────────────────────

func autoDetectHint() string {
	files := []struct {
		path string
		hint string
	}{
		{"package.json", "Node.js application"},
		{"go.mod", "Go application"},
		{"requirements.txt", "Python application"},
		{"Cargo.toml", "Rust application"},
		{"pom.xml", "Java Maven application"},
		{"build.gradle", "Java Gradle application"},
	}
	for _, f := range files {
		if _, err := os.Stat(f.path); err == nil {
			// Read first 500 bytes for extra context
			b, _ := os.ReadFile(f.path)
			if len(b) > 500 {
				b = b[:500]
			}
			return fmt.Sprintf("%s\n---\n%s", f.hint, string(b))
		}
	}
	return ""
}

// ── Output helpers ────────────────────────────────────────────────────────────

func printJSON(data any) {
	b, _ := json.MarshalIndent(data, "", "  ")
	fmt.Println(string(b))
}

func printHelp() {
	fmt.Printf(`nexus CLI v%s — Nexus DePIN Cloud

Usage:
  nexus deploy [flags]     Deploy an application to the DePIN network
  nexus apps               List deployed applications
  nexus remove <slug>      Remove a deployed application
  nexus version            Show CLI version

Deploy flags:
  --name      <string>   App display name (default: current directory name)
  --slug      <string>   Unique app identifier (default: current directory name)
  --mode      <string>   Execution mode: auto | wasm | microvm (default: auto)
  --image     <string>   Docker image or WASM module reference
  --port      <int>      Port the app listens on (default: 8080)
  --region    <string>   Preferred region (ISO-3166-1 alpha-2, e.g. BR)
  --replicas  <int>      Number of replicas (default: 3)
  --hint      <string>   Code description hint for AI classification

Environment:
  NEXUS_URL    Gateway base URL (default: http://localhost:4500)
  NEXUS_TOKEN  API authentication token
`, version)
}

func nextArg(args []string, i *int, flag string) string {
	*i++
	if *i >= len(args) {
		fatalf("flag %s requires a value", flag)
	}
	return args[*i]
}

func getString(m map[string]any, k string) string {
	v, _ := m[k].(string)
	return v
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, "❌ "+msg)
	os.Exit(1)
}

func fatalf(format string, args ...any) {
	fatal(fmt.Sprintf(format, args...))
}
