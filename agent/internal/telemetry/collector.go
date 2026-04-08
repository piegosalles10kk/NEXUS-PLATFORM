package telemetry

import (
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/10kk/agent/internal/metrics"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// DiskInfo represents a single disk/partition.
type DiskInfo struct {
	Device     string  `json:"device"`
	Mountpoint string  `json:"mountpoint"`
	Fstype     string  `json:"fstype"`
	Total      uint64  `json:"total"`        // bytes
	Used       uint64  `json:"used"`         // bytes
	Free       uint64  `json:"free"`         // bytes
	UsedPct    float64 `json:"used_percent"` // 0-100
}

// TelemetryPayload defines the data sent to the backend
type TelemetryPayload struct {
	Timestamp int64             `json:"timestamp"`
	CPUUsage  float64           `json:"cpuUsage"`  // Percentage
	CPUCores  int               `json:"cpuCores"`  // logical core count
	RAMUsage  float64           `json:"ramUsage"`  // Percentage
	RAMTotal  uint64            `json:"ramTotal"`
	RAMUsed   uint64            `json:"ramUsed"`
	// Primary disk (kept for backwards compat)
	DiskUsage float64           `json:"diskUsage"`
	DiskTotal uint64            `json:"diskTotal"`
	DiskUsed  uint64            `json:"diskUsed"`
	// All disks
	Disks     []DiskInfo        `json:"disks"`
	NetTxSec  uint64            `json:"netTxSec"` // Bytes sent per second
	NetRxSec  uint64            `json:"netRxSec"` // Bytes received per second
	TopProcs  []ProcessInfo     `json:"topProcs"`
	GPUs      []metrics.GPUInfo `json:"gpus"` // empty slice on CPU-only hosts
}

type ProcessInfo struct {
	PID     int32   `json:"pid"`
	Name    string  `json:"name"`
	CPU     float64 `json:"cpu"`
	RAM     float32 `json:"ram"`     // Memory percentage
	RAMHeap uint64  `json:"ramHeap"` // Memory RSS
}

var (
	lastNetTx uint64
	lastNetRx uint64
	lastTime  time.Time
)

// collectAllDisks enumerates physical partitions (non-virtual, non-pseudo fs).
// Returns an empty slice on error — never fails the whole Collect().
func collectAllDisks() []DiskInfo {
	partitions, err := disk.Partitions(false) // false = physical devices only
	if err != nil {
		return nil
	}

	seen := make(map[string]bool)
	var result []DiskInfo

	for _, p := range partitions {
		// Skip pseudo/virtual file systems
		switch strings.ToLower(p.Fstype) {
		case "tmpfs", "devtmpfs", "devfs", "overlay", "squashfs",
			"sysfs", "proc", "cgroup", "cgroup2", "pstore",
			"efivarfs", "bpf", "tracefs", "debugfs", "hugetlbfs",
			"mqueue", "securityfs", "fusectl", "configfs", "autofs":
			continue
		}

		// Deduplicate by device (e.g., bind mounts of the same disk)
		key := p.Device
		if key == "" {
			key = p.Mountpoint
		}
		if seen[key] {
			continue
		}
		seen[key] = true

		u, err := disk.Usage(p.Mountpoint)
		if err != nil || u.Total == 0 {
			continue
		}

		result = append(result, DiskInfo{
			Device:     p.Device,
			Mountpoint: p.Mountpoint,
			Fstype:     p.Fstype,
			Total:      u.Total,
			Used:       u.Used,
			Free:       u.Free,
			UsedPct:    u.UsedPercent,
		})
	}

	return result
}

// Collect gathers all metrics
func Collect() (*TelemetryPayload, error) {
	payload := &TelemetryPayload{
		Timestamp: time.Now().UnixMilli(),
	}

	// CPU
	cpuPercents, err := cpu.Percent(0, false)
	if err == nil && len(cpuPercents) > 0 {
		payload.CPUUsage = cpuPercents[0]
	}
	if cores, err := cpu.Counts(true); err == nil {
		payload.CPUCores = cores
	}

	// RAM
	v, err := mem.VirtualMemory()
	if err == nil {
		payload.RAMUsage = v.UsedPercent
		payload.RAMTotal = v.Total
		payload.RAMUsed = v.Used
	}

	// All disks
	payload.Disks = collectAllDisks()

	// Backwards-compat: fill single-disk fields from primary partition
	if len(payload.Disks) > 0 {
		// Pick the root (or C:\) partition as primary for old clients
		primary := payload.Disks[0]
		for _, d := range payload.Disks {
			if d.Mountpoint == "/" || d.Mountpoint == "C:\\" || d.Mountpoint == "C:" {
				primary = d
				break
			}
		}
		payload.DiskUsage = primary.UsedPct
		payload.DiskTotal = primary.Total
		payload.DiskUsed  = primary.Used
	} else {
		// Fallback: try root directly (old behaviour)
		diskPath := "/"
		if runtime.GOOS == "windows" {
			diskPath = "C:\\"
		}
		if d, err := disk.Usage(diskPath); err == nil {
			payload.DiskUsage = d.UsedPercent
			payload.DiskTotal = d.Total
			payload.DiskUsed = d.Used
		}
	}

	// Network
	nv, err := net.IOCounters(false)
	if err == nil && len(nv) > 0 {
		currTx := nv[0].BytesSent
		currRx := nv[0].BytesRecv
		now := time.Now()

		if !lastTime.IsZero() {
			dt := now.Sub(lastTime).Seconds()
			if dt > 0 {
				payload.NetTxSec = uint64(float64(currTx-lastNetTx) / dt)
				payload.NetRxSec = uint64(float64(currRx-lastNetRx) / dt)
			}
		}

		lastNetTx = currTx
		lastNetRx = currRx
		lastTime = now
	}

	// Top Processes
	procs, err := process.Processes()
	if err == nil {
		var procInfos []ProcessInfo
		for _, p := range procs {
			name, _ := p.Name()
			cpuP, _ := p.CPUPercent()
			memP, _ := p.MemoryPercent()
			memInf, _ := p.MemoryInfo()

			rss := uint64(0)
			if memInf != nil {
				rss = memInf.RSS
			}

			procInfos = append(procInfos, ProcessInfo{
				PID:     p.Pid,
				Name:    name,
				CPU:     cpuP,
				RAM:     memP,
				RAMHeap: rss,
			})
		}

		// Sort by CPU usage desc
		sort.Slice(procInfos, func(i, j int) bool {
			return procInfos[i].CPU > procInfos[j].CPU
		})

		// Keep top 10
		limit := 10
		if len(procInfos) < limit {
			limit = len(procInfos)
		}
		payload.TopProcs = procInfos[:limit]
	}

	// GPU — non-fatal; returns empty slice on CPU-only hosts
	payload.GPUs = metrics.CollectGPUs()

	return payload, nil
}
