package proxy

import "testing"

// Notion exposes a different reasoning-effort ladder per model, so "always
// maximum" has to resolve against the model's own supported list.
func TestMaxReasoningEffortForUsesStrongestSupported(t *testing.T) {
	RegisterModelEfforts([]ModelEntry{
		{ID: "test-ladder-full", Name: "Full", Efforts: []string{"low", "medium", "high", "max"}, DefaultEffort: "medium"},
		{ID: "test-ladder-high", Name: "High only", Efforts: []string{"high"}},
		{ID: "test-ladder-default", Name: "Default only", DefaultEffort: "xhigh"},
		{ID: "test-ladder-unsorted", Name: "Unsorted", Efforts: []string{"xhigh", "none", "medium"}},
	})

	cases := map[string]string{
		"test-ladder-full":     "max",
		"test-ladder-high":     "high",
		"test-ladder-default":  "xhigh",
		"test-ladder-unsorted": "xhigh",
		"test-ladder-unknown":  "",
		"":                     "",
	}
	for model, want := range cases {
		if got := MaxReasoningEffortFor(model); got != want {
			t.Fatalf("MaxReasoningEffortFor(%q) = %q, want %q", model, got, want)
		}
	}
}

func TestBuildConfigValueSendsMaxReasoningEffort(t *testing.T) {
	prev := AppConfig
	AppConfig = DefaultConfig()
	defer func() { AppConfig = prev }()

	RegisterModelEfforts([]ModelEntry{
		{ID: "test-cfg-model", Name: "Cfg", Efforts: []string{"low", "high", "max"}},
	})

	cfg := buildConfigValue("test-cfg-model", false, true, nil, false, false, false)
	if got := cfg["reasoningEffort"]; got != "max" {
		t.Fatalf("reasoningEffort = %#v, want \"max\"", got)
	}

	// Subsequent turns must keep the same effort as the first one.
	next := buildConfigValue("test-cfg-model", false, true, nil, false, false, true)
	if got := next["reasoningEffort"]; got != "max" {
		t.Fatalf("subsequent turn reasoningEffort = %#v, want \"max\"", got)
	}

	// An unknown model keeps Notion's own default instead of risking a value
	// the model does not support.
	unknown := buildConfigValue("test-cfg-unknown", false, true, nil, false, false, false)
	if got, ok := unknown["reasoningEffort"]; ok {
		t.Fatalf("unknown model should not carry reasoningEffort, got %#v", got)
	}
}

func TestBuildChatConfigFallsBackToMaxEffort(t *testing.T) {
	RegisterModelEfforts([]ModelEntry{
		{ID: "test-chat-model", Name: "Chat", Efforts: []string{"low", "medium", "high"}},
	})

	auto := buildChatConfig(false, "", "test-chat-model", "")
	if got := auto["reasoningEffort"]; got != "high" {
		t.Fatalf("reasoningEffort = %#v, want \"high\"", got)
	}

	explicit := buildChatConfig(false, "", "test-chat-model", "low")
	if got := explicit["reasoningEffort"]; got != "low" {
		t.Fatalf("explicit effort should win, got %#v", got)
	}

	// Custom agents carry their own model and effort.
	custom := buildChatConfig(true, "workflow-1", "test-chat-model", "")
	if got, ok := custom["reasoningEffort"]; ok {
		t.Fatalf("custom agent should not carry reasoningEffort, got %#v", got)
	}
}
