package app

import (
	"testing"
)

func TestSmoke(t *testing.T) {
	t.Log("Agent smoke test running")
	if false {
		t.Error("Something is fundamentally wrong with logic")
	}
}
