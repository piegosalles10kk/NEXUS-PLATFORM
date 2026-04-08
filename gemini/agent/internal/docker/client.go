package docker

import (
	"sync"

	"github.com/docker/docker/client"
)

var (
	once      sync.Once
	dockerCli *client.Client
)

// Client returns the shared Docker daemon client.
// Uses client.FromEnv so it works on Linux (socket), macOS (socket / colima),
// and Windows (named pipe) without any custom configuration.
func Client() *client.Client {
	once.Do(func() {
		cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
		if err != nil {
			panic("failed to create Docker client: " + err.Error())
		}
		dockerCli = cli
	})
	return dockerCli
}
