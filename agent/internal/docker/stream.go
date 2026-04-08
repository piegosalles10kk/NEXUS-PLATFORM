package docker

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"sync"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/pkg/stdcopy"
)

// LogLine is a single log entry sent to the master over WebSocket.
type LogLine struct {
	Type        string `json:"type"`         // always "log_line"
	ContainerID string `json:"container_id"`
	Data        string `json:"data"`
}

// activeStreams tracks running log-stream goroutines so we can cancel them.
var (
	streamsMu sync.Mutex
	streams   = map[string]context.CancelFunc{}
)

// StartStream begins tailing logs for containerID and writes serialised
// LogLine JSON to the out channel. Calling StopStream cancels it.
func StartStream(ctx context.Context, containerID string, out chan<- []byte) {
	streamsMu.Lock()
	if cancel, exists := streams[containerID]; exists {
		cancel() // stop any prior stream for this container
	}
	streamCtx, cancel := context.WithCancel(ctx)
	streams[containerID] = cancel
	streamsMu.Unlock()

	go func() {
		defer func() {
			streamsMu.Lock()
			delete(streams, containerID)
			streamsMu.Unlock()
		}()

		rc, err := Client().ContainerLogs(streamCtx, containerID, types.ContainerLogsOptions{
			ShowStdout: true,
			ShowStderr: true,
			Follow:     true,
			Tail:       "50", // send the last 50 lines on connect
		})
		if err != nil {
			log.Printf("[stream] ContainerLogs error for %s: %v", containerID, err)
			return
		}
		defer rc.Close()

		// Docker multiplexes stdout/stderr into a stream with 8-byte headers.
		// We use stdcopy to demultiplex into two plain readers, then merge them.
		pr, pw := io.Pipe()
		go func() {
			defer pw.Close()
			if _, err := stdcopy.StdCopy(pw, pw, rc); err != nil && err != io.EOF {
				log.Printf("[stream] stdcopy error for %s: %v", containerID, err)
			}
		}()

		scanner := bufio.NewScanner(pr)
		for scanner.Scan() {
			line := scanner.Text()
			msg := LogLine{Type: "log_line", ContainerID: containerID, Data: line}
			b, err := json.Marshal(msg)
			if err != nil {
				continue
			}
			select {
			case out <- b:
			case <-streamCtx.Done():
				return
			}
		}
	}()
}

// StopStream cancels an active log stream for containerID.
func StopStream(containerID string) {
	streamsMu.Lock()
	defer streamsMu.Unlock()
	if cancel, exists := streams[containerID]; exists {
		cancel()
		delete(streams, containerID)
	}
}

// StopAllStreams cancels all active log streams (called on agent shutdown).
func StopAllStreams() {
	streamsMu.Lock()
	defer streamsMu.Unlock()
	for id, cancel := range streams {
		cancel()
		delete(streams, id)
	}
}
