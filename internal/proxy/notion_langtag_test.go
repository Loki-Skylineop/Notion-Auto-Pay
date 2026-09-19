package proxy

import "testing"

// Notion prefixes every answer with a <lang .../> tag and the stream splits it
// across deltas. cleanAllLangTags only recognises the full "<lang" literal, so
// a shorter prefix ("<", "<l", "<la", "<lan") used to be emitted as ordinary
// text and stayed glued to the front of the reply. Markdown renderers such as
// AIRI's read the stray "<l" as an unclosed HTML tag and hid the whole bubble.
func TestEmitDeltaCleanupHidesPartialLangTag(t *testing.T) {
	clean := func(text string) string {
		return trimTrailingPartialLangTag(cleanAllLangTags(trimTrailingIncompleteCitation(text)))
	}

	cases := []struct{ name, in, want string }{
		{"one char", "<", ""},
		{"two chars", "<l", ""},
		{"three chars", "<la", ""},
		{"four chars", "<lan", ""},
		{"full marker, tag not closed", "<lang", ""},
		{"attributes, tag not closed", "<lang primary=\"ru\"", ""},
		{"complete tag is stripped", "<lang primary=\"ru\"/>Запущена", "Запущена"},
		{"plain text untouched", "Запущена, хозяин", "Запущена, хозяин"},
		{"inline less-than kept", "a < b и c", "a < b и c"},
	}
	for _, tc := range cases {
		if got := clean(tc.in); got != tc.want {
			t.Errorf("%s: clean(%q) = %q, want %q", tc.name, tc.in, got, tc.want)
		}
	}
}

// The stream arrives chunk by chunk and every delta re-cleans the whole
// accumulated text, so the held-back prefix must come back later: each cleaned
// value has to stay an extension of what was already sent, otherwise emitDelta
// either duplicates text or leaks the partial tag.
func TestPartialLangTagIsRecoveredAcrossChunks(t *testing.T) {
	accumulated := []string{
		"<",
		"<l",
		"<la",
		"<lan",
		"<lang",
		"<lang primary=\"ru\"",
		"<lang primary=\"ru\"/>",
		"<lang primary=\"ru\"/>Запущена",
		"<lang primary=\"ru\"/>Запущена, хозяин",
	}
	sent := ""
	for _, acc := range accumulated {
		cleaned := trimTrailingPartialLangTag(cleanAllLangTags(trimTrailingIncompleteCitation(acc)))
		if len(cleaned) < len(sent) || cleaned[:len(sent)] != sent {
			t.Fatalf("cleaned %q is not an extension of already sent %q", cleaned, sent)
		}
		sent = cleaned
	}
	if sent != "Запущена, хозяин" {
		t.Fatalf("final streamed text = %q", sent)
	}
}
