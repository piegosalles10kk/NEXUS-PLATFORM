package docker

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// DeployRequest holds everything needed to perform a remote deploy.
type DeployRequest struct {
	Repo             string
	Branch           string
	ImageName        string
	EnvVars          map[string]string
	ProxyHost        string
	ProxyPort        int
	HealthCheckURL   string
	HealthCheckDelay int // seconds; 0 → default 15
	Clean            bool
}

// DeployResult reports the outcome of a RunDeploy call.
type DeployResult struct {
	// RolledBack is true when the new deploy failed but the previous image
	// was successfully restored. The caller should send deploy_rolled_back.
	RolledBack bool
	// Err is non-nil when the deploy (or rollback) failed.
	Err error
}

// projectsBaseDir is the persistent directory where repos are cloned.
const projectsBaseDir = "./projects"

// RunDeploy updates (or clones) the repo, builds a Docker image, and starts
// the container. Uses a persistent clone directory to avoid full re-clones on
// every deploy. If the new container fails and a previous rollback image exists,
// it is automatically restored and DeployResult.RolledBack is set to true.
// Progress lines are streamed via onLog.
func RunDeploy(ctx context.Context, req DeployRequest, onLog func(string)) DeployResult {
	if req.Repo == "" || req.ImageName == "" {
		return DeployResult{Err: fmt.Errorf("repo and imageName are required")}
	}

	branch := req.Branch
	if branch == "" {
		branch = "main"
	}

	// 1. Prepare persistent project directory (Clone or Sync)
	if err := GitSync(ctx, req.Repo, branch, req.ImageName, onLog); err != nil {
		return DeployResult{Err: err}
	}
	repoDir := filepath.Join(projectsBaseDir, req.ImageName)

	// 2. Generate .env file from provided environment variables (overwrites existing)
	if len(req.EnvVars) > 0 {
		var sb strings.Builder
		for k, v := range req.EnvVars {
			sb.WriteString(fmt.Sprintf("%s=%s\n", k, v))
		}
		envPath := filepath.Join(repoDir, ".env")
		onLog("▶ gerando arquivo .env")
		if err := os.WriteFile(envPath, []byte(sb.String()), 0600); err != nil {
			onLog("⚠️ Aviso: Falha ao gravar .env: " + err.Error())
		}
	}

	// 3. Rotate tags: current → previous (before overwriting the build)
	hasPrevious := false
	if err := runCmd(ctx, nil, "", GetExecutable("docker"), "inspect", "--type=image", req.ImageName+":current"); err == nil {
		if tagErr := runCmd(ctx, nil, "", GetExecutable("docker"), "tag", req.ImageName+":current", req.ImageName+":previous"); tagErr == nil {
			onLog("Snapshot de rollback: " + req.ImageName + ":previous ← current")
			hasPrevious = true
		}
	}

	// 4. Clean build cache if requested
	if req.Clean {
		onLog("▶ docker builder prune -f (clean deploy)")
		_ = runCmd(ctx, onLog, "", GetExecutable("docker"), "builder", "prune", "-f")
	}

	// 5. Docker build (conditionally use --no-cache)
	buildArgs := []string{"build"}
	if req.Clean {
		buildArgs = append(buildArgs, "--no-cache")
		onLog("▶ docker build --no-cache -t " + req.ImageName)
	} else {
		onLog("▶ docker build -t " + req.ImageName)
	}
	buildArgs = append(buildArgs, "-t", req.ImageName, ".")

	if err := runCmd(ctx, onLog, repoDir, GetExecutable("docker"), buildArgs...); err != nil {
		return DeployResult{Err: fmt.Errorf("docker build: %w", err)}
	}

	// 6. Stop and remove old container (best-effort)
	onLog("▶ replacing container " + req.ImageName)
	_ = runCmd(ctx, nil, "", GetExecutable("docker"), "stop", req.ImageName)
	_ = runCmd(ctx, nil, "", GetExecutable("docker"), "rm", req.ImageName)

	// 7. Build docker run args
	runArgs := buildRunArgs(req, req.ImageName)

	onLog("▶ docker run " + req.ImageName)
	if err := runCmd(ctx, onLog, "", GetExecutable("docker"), runArgs...); err != nil {
		onLog("Falha ao iniciar container: " + err.Error())

		// 8. Attempt rollback if a previous image snapshot exists
		if hasPrevious {
			onLog("▶ iniciando rollback para " + req.ImageName + ":previous…")
			_ = runCmd(ctx, nil, "", GetExecutable("docker"), "stop", req.ImageName)
			_ = runCmd(ctx, nil, "", GetExecutable("docker"), "rm", req.ImageName)

			rbArgs := buildRunArgs(req, req.ImageName+":previous")
			if rbErr := runCmd(ctx, onLog, "", GetExecutable("docker"), rbArgs...); rbErr == nil {
				onLog("✓ rollback concluído — versão anterior restaurada")
				return DeployResult{
					RolledBack: true,
					Err:        fmt.Errorf("deploy falhou (%v); versão anterior restaurada automaticamente", err),
				}
			} else {
				onLog("Rollback também falhou: " + rbErr.Error())
			}
		}

		return DeployResult{Err: fmt.Errorf("docker run: %w", err)}
	}

	// 9. Health check — grace period then verify
	delay := req.HealthCheckDelay
	if delay <= 0 {
		delay = 15
	}
	onLog(fmt.Sprintf("Aguardando inicialização (%ds)…", delay))
	select {
	case <-time.After(time.Duration(delay) * time.Second):
	case <-ctx.Done():
		return DeployResult{Err: ctx.Err()}
	}

	var healthErr error
	if req.HealthCheckURL != "" {
		healthErr = httpHealthCheck(ctx, req.HealthCheckURL, onLog)
	} else {
		healthErr = containerRunningCheck(ctx, req.ImageName)
	}

	if healthErr != nil {
		reason := "health check falhou: " + healthErr.Error()
		onLog(reason)
		if hasPrevious {
			onLog("▶ iniciando rollback para " + req.ImageName + ":previous…")
			_ = runCmd(ctx, nil, "", GetExecutable("docker"), "stop", req.ImageName)
			_ = runCmd(ctx, nil, "", GetExecutable("docker"), "rm", req.ImageName)
			rbArgs := buildRunArgs(req, req.ImageName+":previous")
			if rbErr := runCmd(ctx, onLog, "", GetExecutable("docker"), rbArgs...); rbErr == nil {
				onLog("✓ rollback concluído — versão anterior restaurada")
				return DeployResult{
					RolledBack: true,
					Err:        fmt.Errorf("%s; versão anterior restaurada automaticamente", healthErr),
				}
			}
		}
		return DeployResult{Err: fmt.Errorf("health check: %w", healthErr)}
	}
	onLog("✓ health check passou")

	// 10. Promote new build as the confirmed-healthy current snapshot
	_ = runCmd(ctx, nil, "", GetExecutable("docker"), "tag", req.ImageName, req.ImageName+":current")

	onLog("✓ container " + req.ImageName + " started")
	return DeployResult{}
}

// buildRunArgs assembles the `docker run` argument list for the given image.
func buildRunArgs(req DeployRequest, image string) []string {
	args := []string{"run", "-d", "--name", req.ImageName, "--restart", "unless-stopped"}

	for k, v := range req.EnvVars {
		args = append(args, "-e", k+"="+v)
	}

	if req.ProxyHost != "" && req.ProxyPort > 0 {
		args = append(args,
			"--label", "10kk.proxy.host="+req.ProxyHost,
			"--label", fmt.Sprintf("10kk.proxy.port=%d", req.ProxyPort),
		)
	}

	return append(args, image)
}

// runCmd runs an OS command, streaming each output line to onLog (if non-nil).
func runCmd(ctx context.Context, onLog func(string), dir string, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if onLog != nil {
		w := &lineWriter{fn: onLog}
		cmd.Stdout = w
		cmd.Stderr = w
	}
	err := cmd.Run()
	if err != nil {
		log.Printf("[docker] runCmd(%s) failed: %v", name, err)
		log.Printf("[docker] PATH=%s", os.Getenv("PATH"))
		if onLog != nil {
			onLog(fmt.Sprintf("❌ Error: %v", err))
		}
	}
	return err
}

// GetExecutable returns the command to run, allowing environment overrides.
func GetExecutable(name string) string {
	switch name {
	case "git":
		if p := os.Getenv("GIT_PATH"); p != "" {
			return p
		}
	case "docker":
		if p := os.Getenv("DOCKER_PATH"); p != "" {
			return p
		}
	}
	return name
}

// lineWriter splits writes into individual lines and forwards each to fn.
type lineWriter struct {
	fn  func(string)
	buf strings.Builder
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.buf.Write(p)
	for {
		s := w.buf.String()
		idx := strings.IndexByte(s, '\n')
		if idx < 0 {
			break
		}
		line := strings.TrimRight(s[:idx], "\r")
		if line != "" {
			w.fn(line)
		}
		w.buf.Reset()
		w.buf.WriteString(s[idx+1:])
	}
	return len(p), nil
}

// httpHealthCheck GETs url up to 3 times (5s between retries, 10s per request).
// Returns nil on the first 2xx response.
func httpHealthCheck(ctx context.Context, url string, onLog func(string)) error {
	const maxAttempts = 3
	const retryDelay = 5 * time.Second

	client := &http.Client{Timeout: 10 * time.Second}

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		onLog(fmt.Sprintf("GET %s (tentativa %d/%d)…", url, attempt, maxAttempts))

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return fmt.Errorf("request inválida: %w", err)
		}

		resp, err := client.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				onLog(fmt.Sprintf("✓ %s respondeu %d", url, resp.StatusCode))
				return nil
			}
			onLog(fmt.Sprintf("%s respondeu %d", url, resp.StatusCode))
		} else {
			onLog(fmt.Sprintf("%s inacessível: %v", url, err))
		}

		if attempt < maxAttempts {
			select {
			case <-time.After(retryDelay):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}

	return fmt.Errorf("%s não respondeu 2xx após %d tentativas", url, maxAttempts)
}

// containerRunningCheck inspects the container and returns an error if it is not running.
func containerRunningCheck(ctx context.Context, name string) error {
	out, err := exec.CommandContext(ctx,
		GetExecutable("docker"), "inspect", "--format", "{{.State.Running}}", name).Output()
	if err != nil {
		return fmt.Errorf("docker inspect: %w", err)
	}
	if strings.TrimSpace(string(out)) != "true" {
		return fmt.Errorf("container '%s' não está running", name)
	}
	return nil
}
