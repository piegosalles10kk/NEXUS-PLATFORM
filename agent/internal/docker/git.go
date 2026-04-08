package docker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// GitSync ensures the project directory exists and contains the latest code from the specified repo/branch.
// It uses a persistent projectsBaseDir to avoid full clones when possible.
func GitSync(ctx context.Context, repo, branch, imageName string, onLog func(string)) error {
	if repo == "" || imageName == "" {
		return fmt.Errorf("repo and imageName are required")
	}

	if branch == "" {
		branch = "main"
	}

	// 1. Prepare persistent project directory
	if err := os.MkdirAll(projectsBaseDir, 0755); err != nil {
		return fmt.Errorf("mkdir projects: %w", err)
	}
	repoDir := filepath.Join(projectsBaseDir, imageName)

	gitDir := filepath.Join(repoDir, ".git")
	if _, err := os.Stat(gitDir); err == nil {
		// Already cloned — fetch latest commits
		onLog("▶ git fetch origin " + branch)
		if fetchErr := runCmd(ctx, onLog, repoDir,
			GetExecutable("git"), "fetch", "--depth", "1", "origin", branch); fetchErr != nil {
			// Fetch failed — wipe and re-clone
			onLog("git fetch falhou, re-clonando: " + fetchErr.Error())
			_ = os.RemoveAll(repoDir)
		} else {
			onLog("▶ git reset --hard FETCH_HEAD")
			if err := runCmd(ctx, onLog, repoDir,
				GetExecutable("git"), "reset", "--hard", "FETCH_HEAD"); err != nil {
				return fmt.Errorf("git reset: %w", err)
			}
			onLog("✓ repositório atualizado")
			return nil
		}
	}

	// Re-check: if directory doesn't exist (first time or wiped above), clone
	if _, err := os.Stat(gitDir); err != nil {
		if mkErr := os.MkdirAll(repoDir, 0755); mkErr != nil {
			return fmt.Errorf("mkdir repoDir: %w", mkErr)
		}
		onLog("▶ git clone " + repo + " (branch: " + branch + ")")
		if err := runCmd(ctx, onLog, repoDir,
			GetExecutable("git"), "clone", "--depth", "1", "--branch", branch, repo, "."); err != nil {
			return fmt.Errorf("git clone: %w", err)
		}
	}

	onLog("✓ repositório clonado com sucesso")
	return nil
}
