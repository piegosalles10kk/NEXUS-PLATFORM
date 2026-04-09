package network

// HotResizeCgroup updates cgroup v2 resource limits for a running app workload
// without restarting the container. On Linux it writes directly to:
//
//	/sys/fs/cgroup/nexus-<appSlug>/cpu.max
//	/sys/fs/cgroup/nexus-<appSlug>/memory.high
//
// On Windows/macOS the function is a no-op (Docker Desktop manages resources).
//
// cpuMillicores: 1000 = 1 full vCPU. 0 = remove limit (max).
// memLimitMb:    0 = remove limit (max).

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const nexusCgroupRoot = "/sys/fs/cgroup"

// HotResizeCgroup applies new CPU/RAM limits to a running nexus workload cgroup.
func HotResizeCgroup(appSlug string, cpuMillicores int, memLimitMb int) error {
	if runtime.GOOS != "linux" {
		log.Printf("[resize] HotResizeCgroup is a no-op on %s", runtime.GOOS)
		return nil
	}

	cgName := "nexus-" + sanitizeName(appSlug)
	cgPath := filepath.Join(nexusCgroupRoot, cgName)

	if _, err := os.Stat(cgPath); os.IsNotExist(err) {
		// Cgroup doesn't exist — this node may not be running this app
		return fmt.Errorf("cgroup %s not found", cgPath)
	}

	// CPU: cpu.max = "quota period" in microseconds
	// 0 or negative → unlimited ("max 100000")
	if cpuMillicores > 0 {
		period := 100_000 // 100 ms
		quota := cpuMillicores * 100 // millicores → microseconds per 100ms period
		cpuMax := fmt.Sprintf("%d %d", quota, period)
		if err := writeCgroupFile(cgPath, "cpu.max", cpuMax); err != nil {
			return fmt.Errorf("cpu.max: %w", err)
		}
	} else {
		if err := writeCgroupFile(cgPath, "cpu.max", "max 100000"); err != nil {
			return fmt.Errorf("cpu.max unlimited: %w", err)
		}
	}

	// Memory: memory.high is the "soft" limit — kernel starts reclaiming above this.
	// Using memory.high (not memory.max) avoids OOM kills on transient spikes.
	if memLimitMb > 0 {
		memBytes := int64(memLimitMb) * 1024 * 1024
		if err := writeCgroupFile(cgPath, "memory.high", fmt.Sprintf("%d", memBytes)); err != nil {
			return fmt.Errorf("memory.high: %w", err)
		}
	} else {
		if err := writeCgroupFile(cgPath, "memory.high", "max"); err != nil {
			return fmt.Errorf("memory.high unlimited: %w", err)
		}
	}

	return nil
}

func writeCgroupFile(dir, file, content string) error {
	path := filepath.Join(dir, file)
	return os.WriteFile(path, []byte(content), 0644)
}

func sanitizeName(s string) string {
	out := make([]byte, len(s))
	for i := range s {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_' {
			out[i] = c
		} else {
			out[i] = '_'
		}
	}
	return strings.TrimRight(string(out), "_")
}
