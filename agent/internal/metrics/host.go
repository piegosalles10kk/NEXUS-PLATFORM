package metrics

import (
	"context"
	"log"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

const collectInterval = 10 * time.Second

// HostMetrics is the payload sent to the master at each collection tick.
type HostMetrics struct {
	CPUPercent  float64 `json:"cpu_percent"`
	MemTotal    uint64  `json:"mem_total"`
	MemUsed     uint64  `json:"mem_used"`
	MemPercent  float64 `json:"mem_percent"`
	DiskTotal   uint64  `json:"disk_total"`
	DiskUsed    uint64  `json:"disk_used"`
	DiskPercent float64 `json:"disk_percent"`
	// GPU information (empty slice on CPU-only hosts)
	GPUs        []GPUInfo `json:"gpus"`
}

// StartBroadcaster collects host metrics every 10 s and sends them to ch.
// Exits when ctx is cancelled.
func StartBroadcaster(ctx context.Context, ch chan<- HostMetrics) {
	ticker := time.NewTicker(collectInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m, err := collect()
			if err != nil {
				log.Printf("[metrics] collection error: %v", err)
				continue
			}
			select {
			case ch <- m:
			case <-ctx.Done():
				return
			}
		}
	}
}

func collect() (HostMetrics, error) {
	// CPU — average across all cores over a 200 ms window
	cpuPcts, err := cpu.Percent(200*time.Millisecond, false)
	if err != nil {
		return HostMetrics{}, err
	}
	cpuPct := 0.0
	if len(cpuPcts) > 0 {
		cpuPct = cpuPcts[0]
	}

	// Memory
	vmStat, err := mem.VirtualMemory()
	if err != nil {
		return HostMetrics{}, err
	}

	// Disk — root filesystem
	diskStat, err := disk.Usage("/")
	if err != nil {
		// On Windows the root is usually a drive letter; try C:
		diskStat, err = disk.Usage("C:")
		if err != nil {
			diskStat = &disk.UsageStat{} // non-fatal
		}
	}

	// GPU — non-fatal; returns empty slice on CPU-only hosts
	gpus := collectGPUs()

	return HostMetrics{
		CPUPercent:  cpuPct,
		MemTotal:    vmStat.Total,
		MemUsed:     vmStat.Used,
		MemPercent:  vmStat.UsedPercent,
		DiskTotal:   diskStat.Total,
		DiskUsed:    diskStat.Used,
		DiskPercent: diskStat.UsedPercent,
		GPUs:        gpus,
	}, nil
}
