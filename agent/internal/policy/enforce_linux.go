//go:build linux

// enforce_linux.go applies resource limits using cgroups v2 on Linux.
// It writes to the unified cgroup hierarchy at /sys/fs/cgroup/nexus/.

package policy

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

const cgroupRoot = "/sys/fs/cgroup/nexus"

// EnforceForPID applies the NodePolicy limits to the given PID using cgroups v2.
// It creates a cgroup at /sys/fs/cgroup/nexus/<name>/ and moves the PID into it.
func EnforceForPID(pid int, name string, p NodePolicy) error {
	cgPath := filepath.Join(cgroupRoot, sanitize(name))

	// Create cgroup directory
	if err := os.MkdirAll(cgPath, 0755); err != nil {
		return fmt.Errorf("cgroup mkdir: %w", err)
	}

	// CPU quota: max_cpu_percent % of one core per period (100ms).
	// cpu.max format: "quota period" in microseconds.
	period := 100_000 // 100ms
	quota := int(p.MaxCPUPercent / 100.0 * float64(period))
	if quota < 1000 {
		quota = 1000
	}
	cpuMax := fmt.Sprintf("%d %d", quota, period)
	if err := writeFile(cgPath, "cpu.max", cpuMax); err != nil {
		return err
	}

	// Memory limit in bytes.
	memBytes := int64(p.MaxRAMMb) * 1024 * 1024
	if err := writeFile(cgPath, "memory.max", strconv.FormatInt(memBytes, 10)); err != nil {
		return err
	}

	// Move PID into the cgroup.
	if err := writeFile(cgPath, "cgroup.procs", strconv.Itoa(pid)); err != nil {
		return fmt.Errorf("cgroup move pid: %w", err)
	}

	return nil
}

// EnforceAll re-applies p to every currently registered workload PID (Linux).
func EnforceAll(p NodePolicy) {
	workloadsMu.RLock()
	defer workloadsMu.RUnlock()
	for name, pid := range workloads {
		if err := EnforceForPID(pid, name, p); err != nil {
			fmt.Printf("[policy] re-enforce %s (pid=%d): %v\n", name, pid, err)
		}
	}
}

// ReleaseCgroup removes the cgroup directory for the given workload name.
// Should be called when the workload exits.
func ReleaseCgroup(name string) {
	cgPath := filepath.Join(cgroupRoot, sanitize(name))
	_ = os.Remove(cgPath) // only works when cgroup is empty (no PIDs)
}

func writeFile(dir, file, content string) error {
	path := filepath.Join(dir, file)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return fmt.Errorf("cgroup write %s: %w", file, err)
	}
	return nil
}

func sanitize(s string) string {
	out := make([]byte, len(s))
	for i := range s {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
			out[i] = c
		} else {
			out[i] = '_'
		}
	}
	return string(out)
}
