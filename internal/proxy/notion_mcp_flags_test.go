package proxy

import "testing"

// The API path used to hide connected MCP servers whenever
// disable_notion_prompt was set - which is exactly how the gateway is
// configured in production. The desktop tools must stay available: they are
// the operator's own connections, not Notion's built-in agent behaviour.
func TestMcpFlagsSurviveDisabledNotionPrompt(t *testing.T) {
	prev := AppConfig
	defer func() { AppConfig = prev }()

	AppConfig = DefaultConfig()
	AppConfig.Proxy.DisableNotionPrompt = true

	want := []string{
		"enableScriptAgentMcpServers",
		"enableComputer",
		"enableScriptAgent",
		"enableAgentIntegrations",
	}

	for _, subsequentTurn := range []bool{false, true} {
		cfg := buildConfigValue("opus-5", true, true, nil, false, false, subsequentTurn)
		for _, key := range want {
			v, ok := cfg[key].(bool)
			if !ok || !v {
				t.Fatalf("subsequentTurn=%v: %s = %#v, want true", subsequentTurn, key, cfg[key])
			}
		}
	}
}

// Turning the MCP surface off must still be possible for operators who do not
// want the model reaching their machine.
func TestMcpFlagsCanBeDisabledExplicitly(t *testing.T) {
	prev := AppConfig
	defer func() { AppConfig = prev }()

	AppConfig = DefaultConfig()
	off := false
	AppConfig.Proxy.EnableMcpTools = &off

	cfg := buildConfigValue("opus-5", true, true, nil, false, false, false)
	for _, key := range []string{"enableScriptAgentMcpServers", "enableComputer"} {
		if v, ok := cfg[key].(bool); !ok || v {
			t.Fatalf("%s = %#v, want false", key, cfg[key])
		}
	}
}
