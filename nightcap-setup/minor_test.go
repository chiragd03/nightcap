package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMinorHardening(t *testing.T) {
	if got := plainText("ok\x1b]52;c;aGk=\x07 line\u009b2J\tend\n"); strings.ContainsAny(got, "\x1b\x07\u009b") || !strings.Contains(got, "\tend\n") {
		t.Errorf("control codes kept: %q", got)
	}
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "secret.yaml"), []byte("stringData:\n  OWNER_KEY: \"AB12-CD34\"\n  TMDB_API_KEY: \"tmdbkey123\"\n  MODE: \"home\"\n"), 0o600)
	got := strings.Join(serverSecrets(dir), " ")
	if !strings.Contains(got, "tmdbkey123") || !strings.Contains(got, "AB12-CD34") || strings.Contains(got, "home") {
		t.Errorf("Kubernetes secrets: %q", got)
	}
	if u := withTLS("postgresql://u:p@db.example.com:5432/n"); !strings.Contains(u, "sslmode=require") {
		t.Errorf("no sslmode: %s", u)
	}
	if u := withTLS("postgresql://u:p@h/n?sslmode=verify-full"); !strings.Contains(u, "verify-full") || strings.Contains(u, "require") {
		t.Errorf("sslmode changed: %s", u)
	}
	if reachableFromGoogle("100.101.102.103") {
		t.Error("a Tailscale address taken as reachable from Google")
	}
}

// On Google Cloud a quiet look doesn't ask the server (it would wake it): what it last said stands.
func TestQuietCloudLookKeepsAnswer(t *testing.T) {
	s := savedServer{Name: "Cloud", Slug: "cloud", Where: "cloudrun", Mode: "cloud", Dir: t.TempDir(), Address: "https://x.run.app", Project: "p", Region: "r", Created: time.Now()}
	m := serverModel(t, s)
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"server", "running", "healthy", 0}}, answers: true, name: "Cloud", mode: "cloud", households: -1}})
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"server", "running", "healthy", 0}}, notAsked: true, households: -1}, quiet: true})
	if a := m.(app); !a.server.st.answers || a.server.st.name != "Cloud" {
		t.Error("a quiet look on Google Cloud dropped whether it answers")
	}
}
