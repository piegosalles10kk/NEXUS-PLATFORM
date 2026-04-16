// Package rmm implements the Remote Monitoring & Management / Endpoint Detection
// and Response (EDR) subsystem for the Nexus Agent (Sprint 18.1).
//
// Capabilities:
//   - ListProcesses  — enumerate all running PIDs with name, CPU%, MEM%, cmdline
//   - KillProcess    — send SIGKILL to a specified PID
//   - ScanConnections — list active TCP/UDP connections with remote endpoints
//
// On non-Linux systems, cross-platform fallback uses gopsutil.
package rmm

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// ProcessInfo describes a single running process.
type ProcessInfo struct {
	PID      int32   `json:"pid"`
	Name     string  `json:"name"`
	Cmdline  string  `json:"cmdline"`
	CPUPct   float64 `json:"cpuPct"`
	MemMb    float32 `json:"memMb"`
	Status   string  `json:"status"`
	Username string  `json:"username"`
}

// Connection describes an active network connection.
type Connection struct {
	PID        int32  `json:"pid"`
	ProcessName string `json:"processName"`
	LocalAddr  string `json:"localAddr"`
	RemoteAddr string `json:"remoteAddr"`
	Status     string `json:"status"`
	Family     string `json:"family"`
}

// ── Process Listing ───────────────────────────────────────────────────────────

// ListProcesses returns a snapshot of all running processes.
// Uses gopsutil for cross-platform support; falls back to /proc on pure Linux.
func ListProcesses(ctx context.Context) ([]ProcessInfo, error) {
	procs, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("rmm: list processes: %w", err)
	}

	results := make([]ProcessInfo, 0, len(procs))
	for _, p := range procs {
		info := ProcessInfo{PID: p.Pid}

		if name, err := p.NameWithContext(ctx); err == nil {
			info.Name = name
		}
		if cmd, err := p.CmdlineWithContext(ctx); err == nil {
			if len(cmd) > 200 {
				cmd = cmd[:200] + "…"
			}
			info.Cmdline = cmd
		}
		if cpu, err := p.CPUPercentWithContext(ctx); err == nil {
			info.CPUPct = cpu
		}
		if mem, err := p.MemoryInfoWithContext(ctx); err == nil && mem != nil {
			info.MemMb = float32(mem.RSS) / (1024 * 1024)
		}
		if status, err := p.StatusWithContext(ctx); err == nil && len(status) > 0 {
			info.Status = status[0]
		}
		if user, err := p.UsernameWithContext(ctx); err == nil {
			info.Username = user
		}

		results = append(results, info)
	}
	return results, nil
}

// KillProcess sends SIGKILL to the given PID.
// Returns an error if the process does not exist or cannot be killed.
func KillProcess(pid int32) error {
	p, err := process.NewProcess(pid)
	if err != nil {
		return fmt.Errorf("rmm: find process %d: %w", pid, err)
	}
	if err := p.Kill(); err != nil {
		return fmt.Errorf("rmm: kill %d: %w", pid, err)
	}
	log.Printf("[rmm] killed PID %d", pid)
	return nil
}

// ── Network Connection Scanner ────────────────────────────────────────────────

// ScanConnections returns all active TCP/UDP connections on this host.
func ScanConnections(ctx context.Context) ([]Connection, error) {
	conns, err := net.ConnectionsWithContext(ctx, "all")
	if err != nil {
		return nil, fmt.Errorf("rmm: connections: %w", err)
	}

	// Build PID → name map for enrichment
	pidNames := buildPIDNameMap(ctx)

	results := make([]Connection, 0, len(conns))
	for _, c := range conns {
		conn := Connection{
			PID:        c.Pid,
			Status:     c.Status,
			LocalAddr:  fmt.Sprintf("%s:%d", c.Laddr.IP, c.Laddr.Port),
			RemoteAddr: fmt.Sprintf("%s:%d", c.Raddr.IP, c.Raddr.Port),
		}
		if c.Family == 2 {
			conn.Family = "IPv4"
		} else {
			conn.Family = "IPv6"
		}
		if name, ok := pidNames[c.Pid]; ok {
			conn.ProcessName = name
		}
		results = append(results, conn)
	}
	return results, nil
}

func buildPIDNameMap(ctx context.Context) map[int32]string {
	m := make(map[int32]string)
	if runtime.GOOS == "linux" {
		// Fast path: read /proc directly
		entries, err := filepath.Glob("/proc/[0-9]*/comm")
		if err != nil {
			return m
		}
		for _, e := range entries {
			parts := strings.Split(e, "/")
			if len(parts) < 3 {
				continue
			}
			pid64, err := strconv.ParseInt(parts[2], 10, 32)
			if err != nil {
				continue
			}
			data, err := os.ReadFile(e)
			if err == nil {
				m[int32(pid64)] = strings.TrimSpace(string(data))
			}
		}
		return m
	}
	// Cross-platform fallback
	procs, _ := process.ProcessesWithContext(ctx)
	for _, p := range procs {
		if name, err := p.NameWithContext(ctx); err == nil {
			m[p.Pid] = name
		}
	}
	return m
}

// ── Suspicious Process Detector ───────────────────────────────────────────────

// SuspiciousProcess flags a process as potentially malicious.
type SuspiciousProcess struct {
	ProcessInfo
	Reason string `json:"reason"`
}

// DetectSuspicious scans for processes matching known-bad patterns.
// Returns a list of suspicious processes with a human-readable reason.
func DetectSuspicious(ctx context.Context) ([]SuspiciousProcess, error) {
	procs, err := ListProcesses(ctx)
	if err != nil {
		return nil, err
	}

	// Known suspicious binary patterns (case-insensitive)
	badPatterns := []string{
		"cryptominer", "xmrig", "minerd", "cpuminer",   // crypto miners
		"metasploit", "msfconsole", "msfvenom",          // pentesting (when unexpected)
		"ncat", "socat",                                 // reverse shells
		"masscan", "zmap",                               // scanners
	}

	var suspects []SuspiciousProcess
	for _, p := range procs {
		lname := strings.ToLower(p.Name)
		lcmd := strings.ToLower(p.Cmdline)
		for _, pat := range badPatterns {
			if strings.Contains(lname, pat) || strings.Contains(lcmd, pat) {
				suspects = append(suspects, SuspiciousProcess{
					ProcessInfo: p,
					Reason:      fmt.Sprintf("matches pattern '%s'", pat),
				})
				break
			}
		}
		// High CPU + anonymous cmdline = possible miner
		if p.CPUPct > 85 && p.Cmdline == "" {
			suspects = append(suspects, SuspiciousProcess{
				ProcessInfo: p,
				Reason:      "high CPU with empty cmdline (possible miner)",
			})
		}
	}
	return suspects, nil
}

// ── Linux /proc syscall reader ────────────────────────────────────────────────

// SyscallStat holds minimal syscall usage for a given PID (Linux only).
type SyscallStat struct {
	PID        int32  `json:"pid"`
	ProcessName string `json:"processName"`
	ReadSyscalls  int64  `json:"readSyscalls"`
	WriteSyscalls int64  `json:"writeSyscalls"`
}

// ReadSyscallStats reads /proc/<pid>/schedstat for basic I/O context (Linux only).
// Returns empty slice on non-Linux systems.
func ReadSyscallStats(ctx context.Context) ([]SyscallStat, error) {
	if runtime.GOOS != "linux" {
		return nil, nil
	}

	entries, err := filepath.Glob("/proc/[0-9]*/io")
	if err != nil {
		return nil, err
	}

	results := make([]SyscallStat, 0, len(entries))
	for _, ioPath := range entries {
		parts := strings.Split(ioPath, "/")
		if len(parts) < 3 {
			continue
		}
		pid64, err := strconv.ParseInt(parts[2], 10, 32)
		if err != nil {
			continue
		}
		pid := int32(pid64)

		f, err := os.Open(ioPath)
		if err != nil {
			continue // process may have exited
		}

		stat := SyscallStat{PID: pid}
		// Read comm for process name
		if comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid)); err == nil {
			stat.ProcessName = strings.TrimSpace(string(comm))
		}

		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "syscr:") {
				fmt.Sscanf(strings.TrimPrefix(line, "syscr:"), "%d", &stat.ReadSyscalls)
			} else if strings.HasPrefix(line, "syscw:") {
				fmt.Sscanf(strings.TrimPrefix(line, "syscw:"), "%d", &stat.WriteSyscalls)
			}
		}
		f.Close()
		results = append(results, stat)
	}
	return results, nil
}

// ── WebSocket command handlers ────────────────────────────────────────────────

// HandleRMMListProcesses handles the "rmm_list_processes" WS command.
func HandleRMMListProcesses(requestID string, out chan<- []byte, ctx context.Context) {
	go func() {
		tCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()

		procs, err := ListProcesses(tCtx)
		var resp map[string]any
		if err != nil {
			resp = map[string]any{
				"type":      "rmm_processes",
				"requestId": requestID,
				"error":     err.Error(),
			}
		} else {
			suspects, _ := DetectSuspicious(tCtx)
			resp = map[string]any{
				"type":       "rmm_processes",
				"requestId":  requestID,
				"processes":  procs,
				"suspects":   suspects,
				"count":      len(procs),
				"suspectCount": len(suspects),
				"timestamp":  time.Now().UTC().Format(time.RFC3339),
			}
		}
		b, _ := json.Marshal(resp)
		select {
		case out <- b:
		case <-ctx.Done():
		}
	}()
}

// HandleRMMKillProcess handles the "rmm_kill_process" WS command.
func HandleRMMKillProcess(requestID string, pid int32, out chan<- []byte, ctx context.Context) {
	go func() {
		err := KillProcess(pid)
		var resp map[string]any
		if err != nil {
			resp = map[string]any{
				"type":      "rmm_kill_result",
				"requestId": requestID,
				"pid":       pid,
				"success":   false,
				"error":     err.Error(),
			}
		} else {
			resp = map[string]any{
				"type":      "rmm_kill_result",
				"requestId": requestID,
				"pid":       pid,
				"success":   true,
			}
		}
		b, _ := json.Marshal(resp)
		select {
		case out <- b:
		case <-ctx.Done():
		}
	}()
}

// HandleRMMScanConnections handles the "rmm_scan_connections" WS command.
func HandleRMMScanConnections(requestID string, out chan<- []byte, ctx context.Context) {
	go func() {
		tCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()

		conns, err := ScanConnections(tCtx)
		var resp map[string]any
		if err != nil {
			resp = map[string]any{
				"type":      "rmm_connections",
				"requestId": requestID,
				"error":     err.Error(),
			}
		} else {
			resp = map[string]any{
				"type":        "rmm_connections",
				"requestId":   requestID,
				"connections": conns,
				"count":       len(conns),
				"timestamp":   time.Now().UTC().Format(time.RFC3339),
			}
		}
		b, _ := json.Marshal(resp)
		select {
		case out <- b:
		case <-ctx.Done():
		}
	}()
}
