package updater

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// DoUpdate downloads the binary at url, replaces the running executable,
// and restarts the agent service.
//
// Linux / macOS:
//
//	Download → tmp file → chmod +x → os.Rename (atomic on same fs)
//
// Windows (FILE-LOCK workaround):
//
//	Rename current .exe → .old.exe  (frees the name)
//	Download new binary → original .exe name
//	sc stop + sc start  (Windows Service Control Manager)
func DoUpdate(url, version string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not determine executable path: %w", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return fmt.Errorf("eval symlinks: %w", err)
	}

	log.Printf("[updater] downloading version %s from %s", version, url)

	resp, err := http.Get(url) //nolint:gosec // URL comes from authenticated master message
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}

	if runtime.GOOS == "windows" {
		return updateWindows(exePath, resp.Body)
	}
	return updateUnix(exePath, resp.Body)
}

// updateUnix writes to a temp file beside the binary then atomically renames it.
func updateUnix(exePath string, body io.Reader) error {
	dir := filepath.Dir(exePath)
	tmp, err := os.CreateTemp(dir, "10kk-agent-update-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()

	if _, err := io.Copy(tmp, body); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("write temp file: %w", err)
	}
	tmp.Close()

	if err := os.Chmod(tmpName, 0755); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("chmod: %w", err)
	}

	if err := os.Rename(tmpName, exePath); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("rename: %w", err)
	}

	log.Println("[updater] binary replaced; restarting service via systemctl / launchctl")
	// Let kardianos/service handle the actual restart via the OS service manager.
	// We exec the new binary with the "restart" service flag.
	cmd := exec.Command(exePath, "-service", "restart")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// updateWindows handles the file-lock constraint on Windows .exe files.
func updateWindows(exePath string, body io.Reader) error {
	oldPath := exePath + ".old"

	// Step 1: rename the running binary (Windows allows this even while running)
	if err := os.Rename(exePath, oldPath); err != nil {
		return fmt.Errorf("rename current exe: %w", err)
	}

	// Step 2: write the new binary to the original name
	f, err := os.OpenFile(exePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		// Rollback
		os.Rename(oldPath, exePath)
		return fmt.Errorf("create new exe: %w", err)
	}
	if _, err := io.Copy(f, body); err != nil {
		f.Close()
		os.Rename(oldPath, exePath) // rollback
		return fmt.Errorf("write new exe: %w", err)
	}
	f.Close()

	log.Println("[updater] binary replaced; restarting Windows service")

	// Step 3: restart the Windows service via sc.exe
	if err := exec.Command("sc", "stop", "nexus-agent").Run(); err != nil {
		log.Printf("[updater] sc stop warning: %v", err)
	}
	if err := exec.Command("sc", "start", "nexus-agent").Run(); err != nil {
		return fmt.Errorf("sc start failed: %w", err)
	}

	// Clean up the old binary (best-effort; it will be held open until service stops)
	os.Remove(oldPath)

	return nil
}
