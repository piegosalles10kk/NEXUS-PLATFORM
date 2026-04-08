//go:build !linux && !windows

// enforce_other.go is a no-op fallback for macOS and other platforms.
// Resource enforcement is only implemented for Linux (cgroups v2) and
// Windows (Job Objects). On other platforms, workloads run without limits.

package policy

import "fmt"

func EnforceForPID(pid int, name string, p NodePolicy) error {
	fmt.Printf("[policy] Resource enforcement not supported on this platform (pid=%d, workload=%s)\n", pid, name)
	return nil
}

// EnforceAll is a no-op on unsupported platforms.
func EnforceAll(_ NodePolicy) {}

func ReleaseCgroup(_ string) {}
