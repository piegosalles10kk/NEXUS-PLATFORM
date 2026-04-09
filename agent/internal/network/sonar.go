// Package network – Sonar Pulse latency probe (Sprint 12.2 + 14.1)
//
// The Sonar Pulse measures the round-trip time (ms) from this agent to the
// ingress gateway (master's WS endpoint) and embeds it in every heartbeat.
//
// Algorithm:
//   1. Extract the hostname from AGENT_MASTER_URL
//   2. Open a TCP connection to the gateway host:port
//   3. Measure the connect time (half-RTT proxy)
//   4. Cache the result for 10 s so the heartbeat loop stays lightweight
//
// The master writes sonarLatencyMs on the Node record every time a heartbeat
// arrives, enabling the CollectiveScheduler to use it as a tie-breaker.
package network

import (
	"context"
	"log"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const sonarCacheTTL = 10 * time.Second

var (
	sonarMu        sync.Mutex
	sonarCachedMs  float64
	sonarCachedAt  time.Time
)

// MeasureLatency returns the TCP connect latency (ms) to the master endpoint.
// Results are cached for 10 s to avoid flooding the network.
func MeasureLatency() float64 {
	sonarMu.Lock()
	defer sonarMu.Unlock()

	if time.Since(sonarCachedAt) < sonarCacheTTL {
		return sonarCachedMs
	}

	ms := probeTCP(masterHost())
	sonarCachedMs = ms
	sonarCachedAt = time.Now()
	return ms
}

// masterHost extracts "host:port" from AGENT_MASTER_URL.
// Falls back to an empty string (probe is skipped).
func masterHost() string {
	raw := os.Getenv("AGENT_MASTER_URL")
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		switch strings.ToLower(u.Scheme) {
		case "wss", "https":
			port = "443"
		default:
			port = "80"
		}
	}
	return net.JoinHostPort(host, port)
}

// probeTCP opens a TCP connection and returns the connect time in ms.
// Returns -1 on failure (treated as unknown latency by the scheduler).
func probeTCP(addr string) float64 {
	if addr == "" {
		return -1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	start := time.Now()
	d := net.Dialer{}
	conn, err := d.DialContext(ctx, "tcp", addr)
	elapsed := time.Since(start)

	if err != nil {
		log.Printf("[sonar] probe failed addr=%s: %v", addr, err)
		return -1
	}
	conn.Close()

	ms := float64(elapsed.Microseconds()) / 1000.0
	return ms
}
