package network

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"
)

/**
 * ScanActivePorts performs a fast concurrent TCP scan of localhost ports.
 * Returns a list of ports that responded with a successful connection.
 */
func ScanActivePorts(ctx context.Context, start, end int) []int {
	var openPorts []int
	var mu sync.Mutex
	var wg sync.WaitGroup

	// Use a worker pool to avoid OS resource exhaustion
	const numWorkers = 256
	ports := make(chan int, numWorkers)

	// Worker function
	worker := func() {
		defer wg.Done()
		for port := range ports {
			select {
			case <-ctx.Done():
				return
			default:
				address := fmt.Sprintf("127.0.0.1:%d", port)
				// Small timeout for local scan
				conn, err := net.DialTimeout("tcp", address, 200*time.Millisecond)
				if err == nil {
					conn.Close()
					mu.Lock()
					openPorts = append(openPorts, port)
					mu.Unlock()
				}
			}
		}
	}

	// Start workers
	wg.Add(numWorkers)
	for i := 0; i < numWorkers; i++ {
		go worker()
	}

	// Feed ports to workers
	go func() {
		for p := start; p <= end; p++ {
			ports <- p
		}
		close(ports)
	}()

	// Wait for completion or timeout
	wg.Wait()
	return openPorts
}
