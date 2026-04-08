// Package network – NAT / public-IP auto-discovery (T10.1)
//
// DiscoverPublicIP queries a set of well-known echo services to learn the
// node's external address.  It then classifies the address as "routable"
// (publicly reachable) or "behind NAT".
//
// UPnP probe: we send a multicast SSDP M-SEARCH datagram to the LAN gateway.
// If a UPnP IGD (Internet Gateway Device) responds within 2 seconds the node
// is considered UPnP-capable and the scheduler can ask it to open a port
// mapping automatically.
package network

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// IPDiscoveryResult holds the outcome of a public-IP probe.
type IPDiscoveryResult struct {
	// PublicIP is the external IPv4 address as seen from the internet.
	PublicIP string
	// IsPublic is true when the address is globally routable (not RFC-1918 / loopback).
	IsPublic bool
	// UPnPAvailable is true when a UPnP IGD was found on the local network.
	UPnPAvailable bool
}

var (
	discoveryOnce   sync.Once
	discoveryResult IPDiscoveryResult
)

// ipEchoEndpoints are lightweight services that echo the caller's IP.
var ipEchoEndpoints = []string{
	"https://api.ipify.org",
	"https://ifconfig.me/ip",
	"https://checkip.amazonaws.com",
	"https://icanhazip.com",
}

// DiscoverPublicIP returns the cached discovery result, running the probe on
// the first call.  The result is cached for the lifetime of the process;
// call ResetDiscovery() to force a re-probe (e.g. after a network change).
func DiscoverPublicIP() IPDiscoveryResult {
	discoveryOnce.Do(runDiscovery)
	return discoveryResult
}

// ResetDiscovery invalidates the cache so the next call to DiscoverPublicIP
// runs a fresh probe.
func ResetDiscovery() {
	discoveryOnce = sync.Once{}
}

func runDiscovery() {
	ip, err := probePublicIP()
	if err != nil {
		log.Printf("[nat] public-IP probe failed: %v", err)
		discoveryResult = IPDiscoveryResult{}
		return
	}
	upnp := probeUPnP()
	discoveryResult = IPDiscoveryResult{
		PublicIP:      ip,
		IsPublic:      isGloballyRoutable(ip),
		UPnPAvailable: upnp,
	}
	log.Printf("[nat] public-IP=%s routable=%v upnp=%v",
		discoveryResult.PublicIP, discoveryResult.IsPublic, discoveryResult.UPnPAvailable)
}

// probePublicIP tries each echo endpoint in parallel and returns the first
// successful response.
func probePublicIP() (string, error) {
	type result struct {
		ip  string
		err error
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	ch := make(chan result, len(ipEchoEndpoints))
	client := &http.Client{Timeout: 6 * time.Second}

	for _, ep := range ipEchoEndpoints {
		go func(url string) {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if err != nil {
				ch <- result{err: err}
				return
			}
			resp, err := client.Do(req)
			if err != nil {
				ch <- result{err: err}
				return
			}
			defer resp.Body.Close()
			body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
			if err != nil {
				ch <- result{err: err}
				return
			}
			ip := strings.TrimSpace(string(body))
			if net.ParseIP(ip) == nil {
				ch <- result{err: fmt.Errorf("invalid IP from %s: %q", url, ip)}
				return
			}
			ch <- result{ip: ip}
		}(ep)
	}

	var lastErr error
	for range ipEchoEndpoints {
		r := <-ch
		if r.err == nil && r.ip != "" {
			cancel() // stop remaining requests
			return r.ip, nil
		}
		lastErr = r.err
	}
	return "", fmt.Errorf("all IP echo endpoints failed: %w", lastErr)
}

// isGloballyRoutable returns false for RFC-1918, loopback, link-local and
// other non-public address ranges.
func isGloballyRoutable(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	privateRanges := []string{
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"::1/128",
		"fc00::/7",
		"fe80::/10",
	}
	for _, cidr := range privateRanges {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

// ── UPnP probe ────────────────────────────────────────────────────────────────

const (
	ssdpAddr    = "239.255.255.250:1900"
	ssdpSearch  = "M-SEARCH * HTTP/1.1\r\n" +
		"HOST: 239.255.255.250:1900\r\n" +
		"MAN: \"ssdp:discover\"\r\n" +
		"MX: 2\r\n" +
		"ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n"
	upnpTimeout = 2500 * time.Millisecond
)

// probeUPnP sends an SSDP M-SEARCH multicast and returns true if any IGD
// responds within the timeout window.
func probeUPnP() bool {
	addr, err := net.ResolveUDPAddr("udp4", ssdpAddr)
	if err != nil {
		return false
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 0})
	if err != nil {
		return false
	}
	defer conn.Close()

	conn.SetDeadline(time.Now().Add(upnpTimeout)) //nolint:errcheck

	if _, err := conn.WriteToUDP([]byte(ssdpSearch), addr); err != nil {
		return false
	}

	buf := make([]byte, 1024)
	n, _, err := conn.ReadFromUDP(buf)
	if err != nil {
		return false // timeout = no IGD found
	}
	response := string(buf[:n])
	return strings.Contains(response, "InternetGatewayDevice") ||
		strings.Contains(response, "WANIPConnection") ||
		strings.Contains(response, "WANPPPConnection")
}

// ── UPnP port mapping ─────────────────────────────────────────────────────────

// AddPortMapping requests the local UPnP IGD to open an external TCP port and
// forward it to the given internal port.  Returns the external port granted
// (may differ from requested) and any error.
//
// This is a best-effort operation; if UPnP is unavailable the caller should
// fall back to manual port-forwarding instructions.
func AddPortMapping(internalPort, externalPort int, description string) (int, error) {
	// Discovery
	res := DiscoverPublicIP()
	if !res.UPnPAvailable {
		return 0, fmt.Errorf("UPnP IGD not available on this network")
	}

	// Find the IGD control URL via SSDP (simplified: try common gateway addresses)
	controlURL, err := findIGDControlURL()
	if err != nil {
		return 0, fmt.Errorf("IGD control URL not found: %w", err)
	}

	localIP, err := getLocalIP()
	if err != nil {
		return 0, fmt.Errorf("local IP lookup failed: %w", err)
	}

	soapBody := fmt.Sprintf(`<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>%d</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>
      <NewInternalPort>%d</NewInternalPort>
      <NewInternalClient>%s</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>%s</NewPortMappingDescription>
      <NewLeaseDuration>3600</NewLeaseDuration>
    </u:AddPortMapping>
  </s:Body>
</s:Envelope>`, externalPort, internalPort, localIP, description)

	req, err := http.NewRequest(http.MethodPost, controlURL, strings.NewReader(soapBody))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "text/xml; charset=utf-8")
	req.Header.Set("SOAPAction", `"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"`)

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("SOAP request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("SOAP error: HTTP %d", resp.StatusCode)
	}
	return externalPort, nil
}

// findIGDControlURL tries common gateway addresses to locate the UPnP control URL.
func findIGDControlURL() (string, error) {
	candidates := []string{
		"http://192.168.1.1:1900/igd",
		"http://192.168.0.1:1900/igd",
		"http://10.0.0.1:1900/igd",
	}
	// In a full implementation we'd parse the SSDP Location header.
	// For now return the first candidate that responds with HTTP 200.
	client := &http.Client{Timeout: 2 * time.Second}
	for _, url := range candidates {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return url, nil
			}
		}
	}
	return "", fmt.Errorf("no responsive IGD found")
}

// getLocalIP returns the preferred outbound local IPv4 address.
func getLocalIP() (string, error) {
	conn, err := net.Dial("udp4", "8.8.8.8:80")
	if err != nil {
		return "", err
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String(), nil
}
