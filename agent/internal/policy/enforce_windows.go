//go:build windows

// enforce_windows.go applies resource limits using Windows Job Objects.
// A Job Object is created per workload and the process is assigned to it,
// which enforces CPU rate and memory commit limits at the kernel level.

package policy

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// JobHandle wraps a Windows Job Object handle so it can be closed on cleanup.
type JobHandle struct {
	handle windows.Handle
}

// EnforceForPID applies NodePolicy limits to the given PID via a Job Object.
// Returns a *JobHandle that must be closed when the workload exits.
func EnforceForPID(pid int, name string, p NodePolicy) (*JobHandle, error) {
	namePtrs, err := windows.UTF16PtrFromString("Nexus_" + sanitize(name))
	if err != nil {
		return nil, err
	}

	job, err := windows.CreateJobObject(nil, namePtrs)
	if err != nil {
		return nil, fmt.Errorf("CreateJobObject: %w", err)
	}

	// ── CPU rate limit ────────────────────────────────────────────────────────
	// JOBOBJECT_CPU_RATE_CONTROL_INFORMATION.CpuRate is in units of 1/100 percent,
	// so 80% = 8000, 100% = 10000.
	type cpuRateInfo struct {
		ControlFlags uint32
		CpuRate      uint32
	}
	cpuRate := uint32(p.MaxCPUPercent * 100) // e.g. 80% → 8000
	if cpuRate < 100 {
		cpuRate = 100
	}
	if cpuRate > 10000 {
		cpuRate = 10000
	}
	rateInfo := cpuRateInfo{
		ControlFlags: 0x1, // JOB_OBJECT_CPU_RATE_CONTROL_ENABLE
		CpuRate:      cpuRate,
	}
	const JobObjectCpuRateControlInformation = 15
	_, cpuSetErr := windows.SetInformationJobObject(
		job,
		JobObjectCpuRateControlInformation,
		uintptr(unsafe.Pointer(&rateInfo)),
		uint32(unsafe.Sizeof(rateInfo)),
	)
	if cpuSetErr != nil {
		// Non-fatal on older Windows versions
		_ = cpuSetErr
	}

	// ── Memory limit ──────────────────────────────────────────────────────────
	type extLimitInfo struct {
		BasicLimitInformation struct {
			PerProcessUserTimeLimit int64
			PerJobUserTimeLimit     int64
			LimitFlags              uint32
			MinimumWorkingSetSize   uintptr
			MaximumWorkingSetSize   uintptr
			ActiveProcessLimit      uint32
			Affinity                uintptr
			PriorityClass           uint32
			SchedulingClass         uint32
		}
		IoInfo  [2]int64
		ProcessMemoryLimit    uintptr
		JobMemoryLimit        uintptr
		PeakProcessMemoryUsed uintptr
		PeakJobMemoryUsed     uintptr
	}
	const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
	var extInfo extLimitInfo
	extInfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY
	extInfo.ProcessMemoryLimit = uintptr(int64(p.MaxRAMMb) * 1024 * 1024)

	const JobObjectExtendedLimitInformation = 9
	_, _ = windows.SetInformationJobObject(
		job,
		JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&extInfo)),
		uint32(unsafe.Sizeof(extInfo)),
	)

	// ── Assign process ────────────────────────────────────────────────────────
	proc, err := windows.OpenProcess(windows.PROCESS_ALL_ACCESS, false, uint32(pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("OpenProcess: %w", err)
	}
	defer windows.CloseHandle(proc)

	if err := windows.AssignProcessToJobObject(job, proc); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("AssignProcessToJobObject: %w", err)
	}

	return &JobHandle{handle: job}, nil
}

func (j *JobHandle) Close() {
	if j != nil && j.handle != 0 {
		_ = windows.CloseHandle(j.handle)
	}
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

// EnforceAll re-applies p to every currently registered workload PID (Windows).
func EnforceAll(p NodePolicy) {
	workloadsMu.RLock()
	defer workloadsMu.RUnlock()
	for name, pid := range workloads {
		if _, err := EnforceForPID(pid, name, p); err != nil {
			fmt.Printf("[policy] re-enforce %s (pid=%d): %v\n", name, pid, err)
		}
	}
}

// ReleaseCgroup is a no-op on Windows (cleanup is via JobHandle.Close()).
func ReleaseCgroup(_ string) {}
