package docker

import (
	"context"
	"fmt"
	"log"
	"math"
	"os/exec"
	"strings"

	"github.com/10kk/agent/internal/metrics"
)

// CollectivePeer represents another member of the WireGuard mesh cluster.
type CollectivePeer struct {
	MeshIP string `json:"meshIp"`
	Rank   int    `json:"rank"`
}

// CollectiveDeployRequest holds all parameters for launching a container
// that participates in a ResourceCluster (distributed / collective workload).
type CollectiveDeployRequest struct {
	AppID   string
	AppSlug string
	Image   string
	Port    int

	// Resource limits — enforced via Docker cgroup flags
	CpuMillicores int // 2000 = 2.0 vCPUs
	MemLimitMb    int // megabytes; 0 = unlimited
	VramLimitMb   int // > 0 → GPU passthrough required

	// Base env vars from the app definition
	EnvVars map[string]string

	// Collective mesh topology
	MeshIP       string           // this node's 10.50.0.x address
	MasterMeshIP string           // rank-0 node address (MASTER_ADDR)
	Rank         int              // index in the collective (0 = leader)
	WorldSize    int              // total member count
	Peers        []CollectivePeer // all other members

	// "AI" → inject NCCL/Ray/DeepSpeed vars; "" | "WEB" → skip
	AppType string
}

// RunCollectiveDeploy starts a Docker container with cgroup limits and
// collective-aware environment variables for distributed workloads.
func RunCollectiveDeploy(ctx context.Context, req CollectiveDeployRequest, onLog func(string)) error {
	if req.AppID == "" || req.Image == "" {
		return fmt.Errorf("appId and image are required")
	}

	containerName := "nexus-collective-" + req.AppSlug

	// 1. Stop / remove any existing container with the same name
	_ = exec.CommandContext(ctx, GetExecutable("docker"), "stop", containerName).Run()
	_ = exec.CommandContext(ctx, GetExecutable("docker"), "rm", containerName).Run()

	// 2. Base docker run args
	args := []string{"run", "-d", "--name", containerName, "--restart", "unless-stopped"}

	// 2a. CPU limit (min 0.10 cores)
	if req.CpuMillicores > 0 {
		cpus := math.Max(0.10, float64(req.CpuMillicores)/1000.0)
		args = append(args, "--cpus", fmt.Sprintf("%.2f", cpus))
	}

	// 2b. Memory limit — also cap swap to the same value to avoid OOM thrashing
	if req.MemLimitMb > 0 {
		args = append(args, "--memory", fmt.Sprintf("%dm", req.MemLimitMb))
		args = append(args, "--memory-swap", fmt.Sprintf("%dm", req.MemLimitMb))
	}

	// 2c. GPU passthrough (requires nvidia-container-toolkit)
	requireGPU := req.VramLimitMb > 0
	if requireGPU {
		if !metrics.HasNvidiaToolkit() {
			onLog("⚠️  GPU requested but nvidia-container-toolkit not found — running without GPU")
		} else {
			args = append(args, "--gpus", "all")
		}
	}

	// 2d. Host networking so the container can reach 10.50.0.x peers via nexus0
	args = append(args, "--network", "host")

	// 3. Build collective environment variables
	envVars := make(map[string]string, len(req.EnvVars)+20)
	for k, v := range req.EnvVars {
		envVars[k] = v
	}

	// Core collective vars — always injected
	envVars["NEXUS_COLLECTIVE"]  = "true"
	envVars["NEXUS_RANK"]        = fmt.Sprintf("%d", req.Rank)
	envVars["NEXUS_WORLD_SIZE"]  = fmt.Sprintf("%d", req.WorldSize)
	envVars["NEXUS_MASTER_IP"]   = req.MasterMeshIP
	envVars["NEXUS_MESH_IP"]     = req.MeshIP

	peerIPs := make([]string, 0, len(req.Peers))
	for _, p := range req.Peers {
		peerIPs = append(peerIPs, p.MeshIP)
	}
	envVars["NEXUS_PEER_IPS"] = strings.Join(peerIPs, ",")

	// AI framework injection (NCCL + PyTorch Distributed + Ray.io + DeepSpeed)
	if strings.EqualFold(req.AppType, "AI") {
		// PyTorch Distributed / NCCL
		envVars["MASTER_ADDR"]          = req.MasterMeshIP
		envVars["MASTER_PORT"]          = "29500"
		envVars["RANK"]                 = fmt.Sprintf("%d", req.Rank)
		envVars["WORLD_SIZE"]           = fmt.Sprintf("%d", req.WorldSize)
		envVars["LOCAL_RANK"]           = "0"

		// Force NCCL to use the WireGuard mesh interface; disable InfiniBand
		envVars["NCCL_SOCKET_IFNAME"]   = "nexus0"
		envVars["NCCL_IB_DISABLE"]      = "1"
		envVars["NCCL_DEBUG"]           = "WARN"

		// Ray.io cluster bootstrap
		envVars["RAY_HEAD_NODE_HOST"]   = req.MasterMeshIP
		if req.Rank == 0 {
			envVars["RAY_NODE_TYPE"]    = "head"
		} else {
			envVars["RAY_NODE_TYPE"]    = "worker"
		}

		// DeepSpeed / OpenMPI world info
		envVars["OMPI_COMM_WORLD_SIZE"] = fmt.Sprintf("%d", req.WorldSize)
		envVars["OMPI_COMM_WORLD_RANK"] = fmt.Sprintf("%d", req.Rank)
	}

	for k, v := range envVars {
		args = append(args, "-e", k+"="+v)
	}

	// 4. Port binding — only expose on the leader (rank 0) to avoid conflicts
	if req.Rank == 0 && req.Port > 0 {
		args = append(args, "-p", fmt.Sprintf("%d:%d", req.Port, req.Port))
	}

	args = append(args, req.Image)

	onLog(fmt.Sprintf("▶ docker run (collective rank=%d/%d, cpu=%.2fvCPU, mem=%dMB) %s",
		req.Rank, req.WorldSize-1, float64(req.CpuMillicores)/1000.0, req.MemLimitMb, req.Image))

	cmd := exec.CommandContext(ctx, GetExecutable("docker"), args...)
	w := &lineWriter{fn: onLog}
	cmd.Stdout = w
	cmd.Stderr = w

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker run (collective rank=%d): %w", req.Rank, err)
	}

	log.Printf("[collective] container %s started (rank=%d, cpu=%dm, mem=%dMB, vram=%dMB)",
		containerName, req.Rank, req.CpuMillicores, req.MemLimitMb, req.VramLimitMb)
	return nil
}

// StopCollectiveDeploy stops and removes a collective workload container.
func StopCollectiveDeploy(ctx context.Context, appSlug string) error {
	containerName := "nexus-collective-" + appSlug
	_ = exec.CommandContext(ctx, GetExecutable("docker"), "stop", containerName).Run()
	return exec.CommandContext(ctx, GetExecutable("docker"), "rm", containerName).Run()
}
