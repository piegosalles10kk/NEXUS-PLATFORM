// Package policy fetches the NodePolicy from the backend and exposes
// the current resource limits to workload runtimes (WASM, VM).
package policy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// ── Workload registry ──────────────────────────────────────────────────────────
// Maps running workload name → PID so that policy updates can be applied live.

var (
	workloadsMu sync.RWMutex
	workloads   = map[string]int{} // name → OS PID
)

// RegisterWorkload records the PID of a running workload so that future
// policy updates will be applied to it immediately.
func RegisterWorkload(name string, pid int) {
	workloadsMu.Lock()
	workloads[name] = pid
	workloadsMu.Unlock()
}

// UnregisterWorkload removes the workload from the live-enforcement registry.
// Should be called when a workload exits.
func UnregisterWorkload(name string) {
	workloadsMu.Lock()
	delete(workloads, name)
	workloadsMu.Unlock()
}

// ── Global fallback policy ─────────────────────────────────────────────────────
// Used by the WebSocket handler when no Manager instance is in scope.

var (
	globalMu     sync.RWMutex
	globalPolicy = defaultPolicy
)

// SetGlobal updates the in-memory policy immediately and re-enforces all
// registered workloads. Safe to call from any goroutine.
func SetGlobal(p NodePolicy) {
	globalMu.Lock()
	globalPolicy = p
	globalMu.Unlock()
	EnforceAll(p)
}

// GetGlobal returns the current global policy.
func GetGlobal() NodePolicy {
	globalMu.RLock()
	defer globalMu.RUnlock()
	return globalPolicy
}

// NodePolicy mirrors the backend NodePolicy Prisma model.
type NodePolicy struct {
	MaxCPUPercent    float64 `json:"maxCpuPercent"`
	MaxRAMMb         int     `json:"maxRamMb"`
	MaxDiskGb        int     `json:"maxDiskGb"`
	MaxBandwidthMbps int     `json:"maxBandwidthMbps"`
	ScheduleStart    string  `json:"scheduleStart"` // "HH:MM" UTC
	ScheduleEnd      string  `json:"scheduleEnd"`   // "HH:MM" UTC
}

// Defaults used when no policy is fetched yet.
var defaultPolicy = NodePolicy{
	MaxCPUPercent:    80,
	MaxRAMMb:         2048,
	MaxDiskGb:        20,
	MaxBandwidthMbps: 100,
	ScheduleStart:    "00:00",
	ScheduleEnd:      "23:59",
}

// Manager fetches and caches the policy for this node.
type Manager struct {
	mu       sync.RWMutex
	current  NodePolicy
	nodeID   string
	masterURL string
	token    string
	client   *http.Client
}

func NewManager(nodeID, masterURL, token string, tlsClient *http.Client) *Manager {
	m := &Manager{
		current:  defaultPolicy,
		nodeID:   nodeID,
		masterURL: masterURL,
		token:    token,
		client:   tlsClient,
	}
	go m.refreshLoop()
	return m
}

func (m *Manager) Get() NodePolicy {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.current
}

// IsScheduleAllowed returns true if the current UTC time falls within the
// configured schedule window.
func (m *Manager) IsScheduleAllowed() bool {
	p := m.Get()
	now := time.Now().UTC()
	nowMin := now.Hour()*60 + now.Minute()
	startMin := parseHHMM(p.ScheduleStart)
	endMin := parseHHMM(p.ScheduleEnd)
	if startMin > endMin { // overnight window: e.g. 22:00 – 06:00
		return nowMin >= startMin || nowMin <= endMin
	}
	return nowMin >= startMin && nowMin <= endMin
}

func parseHHMM(t string) int {
	var h, m int
	fmt.Sscanf(t, "%d:%d", &h, &m)
	return h*60 + m
}

func (m *Manager) refreshLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	m.fetch() // immediate first fetch
	for range ticker.C {
		m.fetch()
	}
}

func (m *Manager) fetch() {
	// Convert WSS URL to HTTPS
	apiBase := wsToHTTPS(m.masterURL)
	url := fmt.Sprintf("%s/api/v1/agent/nodes/%s/policy", apiBase, m.nodeID)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+m.token)

	resp, err := m.client.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return
	}

	var envelope struct {
		Data *NodePolicy `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Data == nil {
		return
	}

	m.mu.Lock()
	m.current = *envelope.Data
	m.mu.Unlock()
}

func wsToHTTPS(u string) string {
	if len(u) > 6 && u[:6] == "wss://" {
		return "https://" + u[6:]
	}
	if len(u) > 5 && u[:5] == "ws://" {
		return "http://" + u[5:]
	}
	return u
}
