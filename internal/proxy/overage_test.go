package proxy

import (
	"testing"
	"time"
)

// resetOverageState wipes the per-workspace bookkeeping so the tests below do
// not leak state into each other.
func resetOverageState() {
	overageMu.Lock()
	defer overageMu.Unlock()
	overageArmed = map[string]*overageArm{}
}

// Parallel turns in one workspace must not close the switch under each other:
// only the last turn to finish is allowed to disable it.
func TestOverageHoldsAcrossParallelTurns(t *testing.T) {
	resetOverageState()
	defer resetOverageState()

	if !overageAcquire("tok", "user", "space") {
		t.Fatal("the first turn has to be told to flip the switch on")
	}
	if overageAcquire("tok", "user", "space") {
		t.Fatal("a second turn must reuse the switch the first one opened")
	}
	if left := overageRelease("space"); left != 1 {
		t.Fatalf("one turn should still be running, got %d", left)
	}
	if overageIdle("space") {
		t.Fatal("the workspace must not look idle while a turn is running")
	}
	if left := overageRelease("space"); left != 0 {
		t.Fatalf("no turn should be left, got %d", left)
	}
	if !overageIdle("space") {
		t.Fatal("the workspace must look idle once every turn released it")
	}
	overageForget("space")
	overageMu.Lock()
	_, still := overageArmed["space"]
	overageMu.Unlock()
	if still {
		t.Fatal("a confirmed-closed workspace must be forgotten")
	}
}

// A release for a workspace this process never armed still has to close the
// switch rather than silently skip it.
func TestOverageReleaseWithoutArm(t *testing.T) {
	resetOverageState()
	defer resetOverageState()

	if left := overageRelease("unknown"); left != 0 {
		t.Fatalf("an unknown workspace must report zero holders, got %d", left)
	}
	if !overageIdle("unknown") {
		t.Fatal("an unknown workspace must look idle")
	}
}

// While a fresh turn holds the switch open the retry loop has to yield to it
// immediately, without touching the network or sleeping through its tries.
func TestOverageInsistYieldsToNewTurn(t *testing.T) {
	resetOverageState()
	defer resetOverageState()

	overageAcquire("tok", "user", "space")
	done := make(chan bool, 1)
	go func() {
		done <- disableOverageInsist("tok", "user", "space", 5, time.Millisecond)
	}()
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("handing the switch to the running turn counts as success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the retry loop must not block while another turn holds the switch")
	}
}
