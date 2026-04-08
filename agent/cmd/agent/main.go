package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/10kk/agent/internal/app"
	"github.com/kardianos/service"
)

var logger service.Logger

func main() {
	// --- CLI flags ---
	svcFlag := flag.String("service", "", "Control the system service (install, uninstall, start, stop, restart)")
	masterURL := flag.String("master", "", "Master WebSocket URL (wss://your-backend/ws/agent)")
	token := flag.String("token", "", "Provisioning token issued by the platform")
	flag.Parse()

	// Collect arguments to persist when installing the service
	var args []string
	if *masterURL != "" {
		args = append(args, "-master", *masterURL)
	}
	if *token != "" {
		args = append(args, "-token", *token)
	}

	// Service configuration for kardianos/service
	svcConfig := &service.Config{
		Name:        "nexus-agent",
		DisplayName: "Nexus Platform Agent",
		Description: "Connects this host to the Nexus Platform for CI/CD orchestration and monitoring.",
		Arguments:   args,
	}

	// Pass master URL and token into the app via env (persisted by -install)
	if *masterURL != "" {
		os.Setenv("AGENT_MASTER_URL", *masterURL)
	}
	if *token != "" {
		os.Setenv("AGENT_TOKEN", *token)
	}

	prg := app.NewProgram()
	s, err := service.New(prg, svcConfig)
	if err != nil {
		log.Fatalf("Failed to create service: %v", err)
	}

	// Wire up logger
	logger, err = s.Logger(nil)
	if err != nil {
		log.Fatalf("Failed to create logger: %v", err)
	}
	prg.SetLogger(logger)

	// Handle service control flags
	if *svcFlag != "" {
		if err := service.Control(s, *svcFlag); err != nil {
			fmt.Fprintf(os.Stderr, "service control error (%s): %v\n", *svcFlag, err)
			os.Exit(1)
		}
		fmt.Printf("Service action '%s' completed successfully.\n", *svcFlag)
		return
	}

	// Run (either as a service or interactively)
	if err := s.Run(); err != nil {
		logger.Error(err)
	}
}
