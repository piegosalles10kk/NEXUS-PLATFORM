// Package vm — CRIU Live Migration (Sprint 20.3)
//
// Checkpoint/Restore In Userspace (CRIU) allows freezing a running container's
// memory state and restoring it on a different node — zero downtime migration.
//
// How it works:
//  1. Master detects a high ChurnRiskScore from the ML service for a node.
//  2. Master sends "criu_checkpoint" to source node — CRIU dumps the container
//     memory to a directory (default: /var/nexus/criu/<appSlug>).
//  3. Master reads the dump via the agent file manager and transfers it to the
//     target node via the WireGuard mesh (10.50.0.0/24).
//  4. Master sends "criu_restore" to target node — CRIU restores the process.
//
// Prerequisites on the Linux host:
//
//	apt-get install -y criu docker.io
//	sysctl -w kernel.unprivileged_userns_clone=1   (if needed)
//
// On non-Linux systems this is a no-op (logged warning).
package vm

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const criuDumpBaseDir = "/var/nexus/criu"

// CRIUCheckpoint freezes a running container and dumps its state to disk.
//
// Parameters:
//   - containerName: the Docker container name (e.g., "nexus-myapp")
//   - dumpDir:       directory to write the CRIU dump files
//
// This calls `docker checkpoint create` which internally uses CRIU.
// The container is NOT stopped — it can continue running while the dump
// is being taken (copy-on-write semantics via CRIU's pre-copy mode).
func CRIUCheckpoint(ctx context.Context, containerName, dumpDir string) error {
	if runtime.GOOS != "linux" {
		log.Printf("[criu] CRIU is Linux-only; skipping checkpoint on %s", runtime.GOOS)
		return nil
	}

	if containerName == "" {
		return fmt.Errorf("criu: containerName is required")
	}

	// Ensure dump directory exists
	fullDumpDir := filepath.Join(criuDumpBaseDir, filepath.Clean(dumpDir))
	if err := os.MkdirAll(fullDumpDir, 0700); err != nil {
		return fmt.Errorf("criu: mkdir %s: %w", fullDumpDir, err)
	}

	log.Printf("[criu] checkpointing container=%s → %s", containerName, fullDumpDir)

	// Use docker checkpoint (requires experimental + CRIU installed)
	// docker checkpoint create --checkpoint-dir <dir> <container> <checkpoint-name>
	checkpointName := "nexus-cp-" + fmt.Sprintf("%d", time.Now().Unix())
	tCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(tCtx, "docker", "checkpoint", "create",
		"--checkpoint-dir", fullDumpDir,
		"--leave-running",
		containerName,
		checkpointName,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Fallback: try raw CRIU dump if docker checkpoint not available
		log.Printf("[criu] docker checkpoint failed (%v), trying raw CRIU: %s", err, strings.TrimSpace(string(out)))
		return criuRawDump(tCtx, containerName, fullDumpDir)
	}

	log.Printf("[criu] checkpoint created: %s in %s", checkpointName, fullDumpDir)
	return nil
}

// CRIURestore brings back a frozen process from a CRIU dump directory.
//
// The target node must have the dump files transferred (e.g., via rsync over
// the WireGuard mesh). This calls `docker start --checkpoint`.
func CRIURestore(ctx context.Context, dumpDir string) error {
	if runtime.GOOS != "linux" {
		log.Printf("[criu] CRIU is Linux-only; skipping restore on %s", runtime.GOOS)
		return nil
	}

	fullDumpDir := filepath.Join(criuDumpBaseDir, filepath.Clean(dumpDir))
	if _, err := os.Stat(fullDumpDir); os.IsNotExist(err) {
		return fmt.Errorf("criu: dump directory not found: %s", fullDumpDir)
	}

	// Find checkpoint directories
	entries, err := os.ReadDir(fullDumpDir)
	if err != nil {
		return fmt.Errorf("criu: read dump dir: %w", err)
	}

	var checkpointName, containerName string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "nexus-cp-") {
			checkpointName = e.Name()
		}
		// The parent dir name is typically the container name
		containerName = filepath.Base(dumpDir)
	}

	if checkpointName == "" {
		// Fallback: raw CRIU restore
		return criuRawRestore(ctx, fullDumpDir)
	}

	log.Printf("[criu] restoring container=%s checkpoint=%s", containerName, checkpointName)

	tCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(tCtx, "docker", "start",
		"--checkpoint", checkpointName,
		"--checkpoint-dir", fullDumpDir,
		containerName,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("criu: docker start --checkpoint: %w — %s", err, strings.TrimSpace(string(out)))
	}

	log.Printf("[criu] restore successful: container=%s", containerName)
	return nil
}

// criuRawDump uses CRIU directly (without Docker layer) for containers that
// do not support the Docker checkpoint API.
func criuRawDump(ctx context.Context, containerName, dumpDir string) error {
	// Get the PID of the main container process
	pidOut, err := exec.CommandContext(ctx, "docker", "inspect",
		"--format", "{{.State.Pid}}", containerName,
	).Output()
	if err != nil {
		return fmt.Errorf("criu: get container pid: %w", err)
	}
	pid := strings.TrimSpace(string(pidOut))
	if pid == "" || pid == "0" {
		return fmt.Errorf("criu: container is not running (pid=0)")
	}

	cmd := exec.CommandContext(ctx, "criu", "dump",
		"-t", pid,
		"-D", dumpDir,
		"--shell-job",
		"--leave-running",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("criu dump: %w — %s", err, strings.TrimSpace(string(out)))
	}
	log.Printf("[criu] raw dump complete: pid=%s dir=%s", pid, dumpDir)
	return nil
}

// criuRawRestore restores a process directly via CRIU CLI.
func criuRawRestore(ctx context.Context, dumpDir string) error {
	cmd := exec.CommandContext(ctx, "criu", "restore",
		"-D", dumpDir,
		"--shell-job",
		"-d", // daemonize
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("criu restore: %w — %s", err, strings.TrimSpace(string(out)))
	}
	log.Printf("[criu] raw restore complete from %s", dumpDir)
	return nil
}

// TransferDump copies a CRIU dump directory to a remote node via rsync over
// the WireGuard mesh. The remote node must have SSH or rsync daemon available.
//
// This is called by the master after CRIUCheckpoint to move the dump to the
// target node before calling CRIURestore there.
func TransferDump(ctx context.Context, dumpDir, targetMeshIP, targetUser string) error {
	if runtime.GOOS != "linux" {
		return nil
	}

	fullDumpDir := filepath.Join(criuDumpBaseDir, filepath.Clean(dumpDir))
	remote := fmt.Sprintf("%s@%s:%s/", targetUser, targetMeshIP, criuDumpBaseDir)

	log.Printf("[criu] transferring dump %s → %s", fullDumpDir, remote)

	tCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(tCtx, "rsync", "-avz", "--progress",
		"-e", "ssh -o StrictHostKeyChecking=no",
		fullDumpDir+"/",
		remote,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("criu transfer: %w — %s", err, strings.TrimSpace(string(out)))
	}
	log.Printf("[criu] transfer complete to %s", targetMeshIP)
	return nil
}

// CleanupDump removes a CRIU dump directory after successful migration.
func CleanupDump(dumpDir string) error {
	fullDumpDir := filepath.Join(criuDumpBaseDir, filepath.Clean(dumpDir))
	if err := os.RemoveAll(fullDumpDir); err != nil {
		return fmt.Errorf("criu cleanup: %w", err)
	}
	log.Printf("[criu] cleaned up dump: %s", fullDumpDir)
	return nil
}
