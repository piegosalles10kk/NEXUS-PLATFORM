package network

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// certDir returns the OS-specific directory where the agent expects certificates.
//
//   - Linux / macOS : /etc/10kk/certs
//   - Windows       : C:\Program Files\10KK-Agent\certs
func certDir() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("ProgramFiles"), "10KK-Agent", "certs")
	}
	return "/etc/10kk/certs"
}

// LoadTLSConfig builds a *tls.Config suitable for an mTLS WebSocket client.
// It loads:
//   - ca.crt    — the platform CA used to verify the server certificate
//   - client.crt / client.key — the agent's client certificate pair
//
// If NEXUS_SKIP_TLS=1 is set (dev/test only), returns an InsecureSkipVerify
// config so agents can connect to a self-signed backend without installing certs.
func LoadTLSConfig() (*tls.Config, error) {
	if os.Getenv("NEXUS_SKIP_TLS") == "1" {
		return &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}, nil //nolint:gosec // dev only
	}

	dir := certDir()

	caCertPEM, err := os.ReadFile(filepath.Join(dir, "ca.crt"))
	if err != nil {
		return nil, fmt.Errorf("read ca.crt: %w", err)
	}

	clientCert, err := tls.LoadX509KeyPair(
		filepath.Join(dir, "client.crt"),
		filepath.Join(dir, "client.key"),
	)
	if err != nil {
		return nil, fmt.Errorf("load client cert pair: %w", err)
	}

	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caCertPEM) {
		return nil, fmt.Errorf("failed to parse CA certificate")
	}

	return &tls.Config{
		Certificates: []tls.Certificate{clientCert},
		RootCAs:      caPool,
		MinVersion:   tls.VersionTLS12,
	}, nil
}
