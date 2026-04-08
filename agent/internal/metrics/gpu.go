package metrics

import (
	"bytes"
	"encoding/csv"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

// HasNvidiaToolkit returns true if the nvidia-container-toolkit runtime is
// available on this host. It checks for nvidia-container-cli (the component
// that hooks into Docker's --gpus flag). Returns false gracefully when the
// toolkit is absent, allowing CPU-only hosts to function normally.
func HasNvidiaToolkit() bool {
	// The toolkit is Linux-only; on other platforms always report absent.
	if runtime.GOOS != "linux" {
		return false
	}
	// Primary indicator: nvidia-container-cli is the binary provided by
	// nvidia-container-toolkit that bridges Docker and the NVIDIA driver.
	if _, err := exec.LookPath("nvidia-container-cli"); err == nil {
		return true
	}
	// Secondary indicator: older installations provide nvidia-container-runtime.
	if _, err := exec.LookPath("nvidia-container-runtime"); err == nil {
		return true
	}
	return false
}

// GPUInfo holds information about a single GPU detected on the host.
type GPUInfo struct {
	Index        int    `json:"index"`
	Name         string `json:"name"`
	MemoryTotalMb int64  `json:"memory_total_mb"`
	MemoryUsedMb  int64  `json:"memory_used_mb"`
	Utilization  int    `json:"utilization_percent"`
	DriverVersion string `json:"driver_version,omitempty"`
}

// CollectGPUs is the exported version of collectGPUs for use by other packages.
func CollectGPUs() []GPUInfo { return collectGPUs() }

// collectGPUs runs nvidia-smi to enumerate available NVIDIA GPUs.
// Returns an empty slice (not an error) if nvidia-smi is not installed or
// no GPUs are found — enabling graceful degradation on CPU-only hosts.
func collectGPUs() []GPUInfo {
	// nvidia-smi is only meaningful on Linux and Windows
	if runtime.GOOS == "darwin" {
		return nil
	}

	// Query all relevant fields in a machine-readable CSV format.
	// Fields: index, name, memory.total [MiB], memory.used [MiB], utilization.gpu [%], driver_model.current
	out, err := runNvidiaSmi(
		"--query-gpu=index,name,memory.total,memory.used,utilization.gpu,driver_version",
		"--format=csv,noheader,nounits",
	)
	if err != nil {
		// nvidia-smi not found or returned non-zero — no GPU available.
		return nil
	}

	return parseNvidiaSmiCSV(out)
}

// runNvidiaSmi executes nvidia-smi with the given arguments and returns stdout.
func runNvidiaSmi(args ...string) (string, error) {
	cmd := exec.Command("nvidia-smi", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", err
	}
	return stdout.String(), nil
}

// parseNvidiaSmiCSV converts the CSV output from nvidia-smi into a slice of GPUInfo.
func parseNvidiaSmiCSV(raw string) []GPUInfo {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}

	r := csv.NewReader(strings.NewReader(raw))
	r.TrimLeadingSpace = true

	records, err := r.ReadAll()
	if err != nil {
		return nil
	}

	gpus := make([]GPUInfo, 0, len(records))
	for _, rec := range records {
		if len(rec) < 6 {
			continue
		}

		index, _ := strconv.Atoi(strings.TrimSpace(rec[0]))
		name := strings.TrimSpace(rec[1])

		memTotal, _ := strconv.ParseInt(strings.TrimSpace(rec[2]), 10, 64)
		memUsed, _ := strconv.ParseInt(strings.TrimSpace(rec[3]), 10, 64)

		// Utilization field may be "N/A" on some drivers (e.g. MIG mode)
		utilRaw := strings.TrimSpace(rec[4])
		util, _ := strconv.Atoi(utilRaw)

		driverVersion := strings.TrimSpace(rec[5])

		gpus = append(gpus, GPUInfo{
			Index:         index,
			Name:          name,
			MemoryTotalMb: memTotal,
			MemoryUsedMb:  memUsed,
			Utilization:  util,
			DriverVersion: driverVersion,
		})
	}
	return gpus
}
