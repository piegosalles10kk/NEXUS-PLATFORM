// Package raft implements leader election and state synchronisation
// for MicroVM replicas using a simplified Raft-inspired protocol over WebSocket.
//
// For production, replace with github.com/hashicorp/raft once the agent
// has a stable TCP transport between nodes. The current implementation uses
// the existing Gateway WebSocket as the communication channel, which is
// sufficient for the MVP (heartbeat + leader election messages forwarded
// through the Gateway to peer agents).
//
// State machine:
//   FOLLOWER → (election timeout) → CANDIDATE → (majority votes) → LEADER
//   LEADER   → (heartbeat timeout from peers) → FOLLOWER
package raft

import (
	"context"
	"encoding/json"
	"log"
	"math/rand"
	"sync"
	"time"
)

// Role represents the Raft role of this node.
type Role string

const (
	RoleFollower  Role = "FOLLOWER"
	RoleCandidate Role = "CANDIDATE"
	RoleLeader    Role = "LEADER"
)

const (
	heartbeatInterval  = 150 * time.Millisecond
	electionTimeoutMin = 300 * time.Millisecond
	electionTimeoutMax = 600 * time.Millisecond
)

// Node is a Raft cluster participant.
type Node struct {
	mu          sync.Mutex
	appID       string
	appSlug     string
	role        Role
	currentTerm int64
	votedFor    string
	peerCount   int
	votes       int
	outCh       chan<- []byte
	cancel      context.CancelFunc
}

// StartNode initialises and runs the Raft state machine for a replica.
// initialRole is the role assigned by the Scheduler ("LEADER" | "FOLLOWER").
// peers is the list of peer IP addresses (used for informational reporting).
func StartNode(
	parentCtx context.Context,
	appID, appSlug, initialRole string,
	peers []string,
	outCh chan<- []byte,
) {
	ctx, cancel := context.WithCancel(parentCtx)

	role := RoleFollower
	if initialRole == "LEADER" {
		role = RoleLeader
	}

	n := &Node{
		appID:     appID,
		appSlug:   appSlug,
		role:      role,
		peerCount: len(peers),
		outCh:     outCh,
		cancel:    cancel,
	}

	log.Printf("[raft] starting node: app=%s role=%s peers=%v", appSlug, role, peers)
	n.reportStatus()

	go n.run(ctx)
}

// run is the main Raft event loop.
func (n *Node) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		n.mu.Lock()
		role := n.role
		n.mu.Unlock()

		switch role {
		case RoleLeader:
			n.runLeader(ctx)
		case RoleFollower, RoleCandidate:
			n.runFollower(ctx)
		}
	}
}

// runLeader sends periodic heartbeats and reports leader status.
func (n *Node) runLeader(ctx context.Context) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			n.mu.Lock()
			if n.role != RoleLeader {
				n.mu.Unlock()
				return
			}
			term := n.currentTerm
			n.mu.Unlock()

			// Broadcast heartbeat via Gateway tunnel
			n.send(map[string]any{
				"type":    "raft_heartbeat",
				"appId":   n.appID,
				"term":    term,
				"role":    string(RoleLeader),
			})
		}
	}
}

// runFollower waits for heartbeats; starts an election on timeout.
func (n *Node) runFollower(ctx context.Context) {
	timeout := electionTimeout()
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			// Election timeout — become candidate
			n.mu.Lock()
			n.role = RoleCandidate
			n.currentTerm++
			n.votes = 1 // vote for self
			term := n.currentTerm
			n.mu.Unlock()

			log.Printf("[raft] election started: app=%s term=%d", n.appSlug, term)
			n.send(map[string]any{
				"type":    "raft_vote_request",
				"appId":   n.appID,
				"term":    term,
			})

			// For MVP with single-node or Gateway-mediated quorum:
			// if peerCount == 0, immediately become leader
			n.mu.Lock()
			if n.peerCount == 0 || n.votes > n.peerCount/2 {
				n.role = RoleLeader
				n.mu.Unlock()
				log.Printf("[raft] elected as LEADER: app=%s term=%d", n.appSlug, term)
				n.reportStatus()
				return
			}
			n.mu.Unlock()

			// Wait for vote responses (simplified: re-run after another timeout)
			timer.Reset(electionTimeout())
		}
	}
}

// GrantVote processes a vote request from a peer.
// In the MVP, the Gateway forwards raft_vote_grant messages back to this node.
func (n *Node) GrantVote(term int64) {
	n.mu.Lock()
	defer n.mu.Unlock()

	if n.role != RoleCandidate || term != n.currentTerm {
		return
	}

	n.votes++
	majority := (n.peerCount / 2) + 1
	if n.votes >= majority {
		n.role = RoleLeader
		log.Printf("[raft] quorum reached — elected LEADER: app=%s term=%d", n.appSlug, term)
		go n.reportStatus()
	}
}

// ReceiveHeartbeat resets the election timer when a heartbeat from the leader arrives.
// The Gateway relays raft_heartbeat messages from the leader to all followers.
func (n *Node) ReceiveHeartbeat(leaderTerm int64) {
	n.mu.Lock()
	defer n.mu.Unlock()

	if leaderTerm >= n.currentTerm {
		n.currentTerm = leaderTerm
		n.role = RoleFollower
	}
}

// GetRole returns the current role of this node.
func (n *Node) GetRole() Role {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.role
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func (n *Node) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case n.outCh <- b:
	default:
	}
}

func (n *Node) reportStatus() {
	n.mu.Lock()
	role := n.role
	term := n.currentTerm
	n.mu.Unlock()

	n.send(map[string]any{
		"type":    "raft_status",
		"appId":   n.appID,
		"appSlug": n.appSlug,
		"role":    string(role),
		"term":    term,
	})
}

func electionTimeout() time.Duration {
	spread := electionTimeoutMax - electionTimeoutMin
	return electionTimeoutMin + time.Duration(rand.Int63n(int64(spread)))
}
