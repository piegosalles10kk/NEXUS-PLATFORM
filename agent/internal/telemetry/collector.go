package telemetry

import (
	"runtime"
	"sort"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// TelemetryPayload defines the data sent to the backend
type TelemetryPayload struct {
	Timestamp int64         `json:"timestamp"`
	CPUUsage  float64       `json:"cpuUsage"` // Percentage
	RAMUsage  float64       `json:"ramUsage"` // Percentage
	RAMTotal  uint64        `json:"ramTotal"`
	RAMUsed   uint64        `json:"ramUsed"`
	DiskUsage float64       `json:"diskUsage"` // Percentage of primary partition
	DiskTotal uint64        `json:"diskTotal"`
	DiskUsed  uint64        `json:"diskUsed"`
	NetTxSec  uint64        `json:"netTxSec"` // Bytes sent per second
	NetRxSec  uint64        `json:"netRxSec"` // Bytes received per second
	TopProcs  []ProcessInfo `json:"topProcs"`
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

	// RAM
	v, err := mem.VirtualMemory()
	if err == nil {
		payload.RAMUsage = v.UsedPercent
		payload.RAMTotal = v.Total
		payload.RAMUsed = v.Used
	}

	// Disk
	diskPath := "/"
	if runtime.GOOS == "windows" {
		diskPath = "C:\\"
	}
	d, err := disk.Usage(diskPath)
	if err == nil {
		payload.DiskUsage = d.UsedPercent
		payload.DiskTotal = d.Total
		payload.DiskUsed = d.Used
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

	return payload, nil
}
