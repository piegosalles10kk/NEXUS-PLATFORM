package app

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/10kk/agent/internal/metrics"
	"github.com/10kk/agent/internal/network"
	"github.com/kardianos/service"
)

// Program implements service.Interface from kardianos/service.
type Program struct {
	cancel context.CancelFunc
	logger service.Logger
}

func NewProgram() *Program {
	return &Program{}
}

func (p *Program) SetLogger(l service.Logger) {
	p.logger = l
}

// Start is called by the service manager — must NOT block.
func (p *Program) Start(s service.Service) error {
	masterURL := os.Getenv("AGENT_MASTER_URL")
	token := os.Getenv("AGENT_TOKEN")

	if masterURL == "" {
		return fmt.Errorf("AGENT_MASTER_URL is not set; re-install with -master flag")
	}

	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel

	go p.run(ctx, masterURL, token)
	return nil
}

// Stop is called by the service manager — must NOT block for too long.
func (p *Program) Stop(_ service.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	return nil
}

// run is the main goroutine — starts metrics broadcaster and the WS connection loop.
func (p *Program) run(ctx context.Context, masterURL, token string) {
	log.Printf("🚀 10KK Agent starting | master=%s", masterURL)

	// Metrics broadcaster: collects host stats and feeds them into a channel
	metricsCh := make(chan metrics.HostMetrics, 4)
	go metrics.StartBroadcaster(ctx, metricsCh)

	// WebSocket connection loop (handles reconnects with exponential backoff)
	network.RunConnectionLoop(ctx, masterURL, token, metricsCh)

	log.Println("10KK Agent stopped.")
}
