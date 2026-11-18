package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

func TestParseComposePS(t *testing.T) {
	lines := `{"Service":"db","State":"running","Health":"healthy","ExitCode":0}
{"Service":"schema","State":"exited","Health":"","ExitCode":0}
{"Service":"server","State":"running","Health":"","ExitCode":0}`
	list := `[{"Service":"server","State":"exited","Health":"","ExitCode":137}]`
	if p := parseComposePS(lines); len(p) != 3 || p[0].health != "healthy" || p[1].state != "exited" {
		t.Errorf("one a line: %+v", p)
	}
	if p := parseComposePS(list); len(p) != 1 || p[0].exitCode != 137 {
		t.Errorf("a list: %+v", p)
	}
}

func TestServerSecretsAndScrub(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "nightcap.env"), []byte("MODE=home\nOWNER_KEY=AAAA-BBBB\nDATABASE_URL=postgresql://nightcap:dbpw1234@db:5432/nightcap\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("DB_PASSWORD=dbpw1234\nAIOSTREAMS_SECRET_KEY='abcdef'\n"), 0o600)
	got := serverSecrets(dir)
	for _, want := range []string{"AAAA-BBBB", "dbpw1234", "abcdef"} {
		found := false
		for _, g := range got {
			found = found || g == want
		}
		if !found {
			t.Errorf("%q isn't among the secrets: %v", want, got)
		}
	}
	for _, g := range got {
		if g == "home" {
			t.Error("MODE counted as a secret")
		}
	}
	if s := scrub2("connecting to postgresql://u:hunter2@h:5432/db"); strings.Contains(s, "hunter2") {
		t.Errorf("scrub2 left the password: %q", s)
	}
}

func serverModel(t *testing.T, s savedServer) tea.Model {
	t.Helper()
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	if err := saveServer(s); err != nil {
		t.Fatal(err)
	}
	var m tea.Model = newApp()
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	m = press(m, "down", "enter", "enter") // Manage, the first server
	if m.(app).screen != serverScreenID {
		t.Fatal("not on the server's screen")
	}
	return m
}

func TestServerScreenRunning(t *testing.T) {
	s := savedServer{Name: "Home", Slug: "home", Where: "docker", Mode: "home", Dir: "/x/home", Address: "http://localhost:7171", Image: "img", Created: time.Now()}
	m := serverModel(t, s)
	snap(t, m, "server-looking")
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"db", "running", "healthy", 0}, {"schema", "exited", "", 0}, {"aiostreams", "running", "starting", 0}, {"server", "running", "", 0}},
		answers: true, name: "Home", mode: "home", households: 2, newer: "yes"}})
	v := snap(t, m, "server")
	for _, want := range []string{"Database", "OK", "starting…", "2 households", "a newer one is out", "● running", "Logs", "Update", "Stop"} {
		if !strings.Contains(v, want) {
			t.Errorf("the server's screen doesn't show %q", want)
		}
	}
	// The logs, and Esc closes them (not the screen).
	m, _ = m.Update(logsMsg{text: "INFO started\nINFO Play tt1: 3 verified\n"})
	if v := snap(t, m, "server-logs"); !strings.Contains(v, "Play tt1") {
		t.Error("the logs aren't shown")
	}
	m = press(m, "esc")
	if a := m.(app); a.screen != serverScreenID || a.server.logs {
		t.Error("Esc didn't just close the logs")
	}
	// Stopped: Start is offered, and a failed action says why.
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"server", "exited", "", 0}}, answerErr: "nothing answered at http://127.0.0.1:7171"}})
	if v := snap(t, m, "server-stopped"); !strings.Contains(v, "Start") || strings.Contains(v, "Stop ") {
		t.Error("a stopped server isn't offered Start")
	}
	m, _ = m.Update(actionDone{"start", errors.New("docker compose up didn't work: port is in use")})
	if v := snap(t, m, "server-failed"); !strings.Contains(v, "port is") {
		t.Error("a failed start doesn't say why")
	}
}

func TestServerScreenElsewhere(t *testing.T) {
	s := savedServer{Name: "Cabin", Slug: "cabin", Where: "files", Mode: "cloud", Dir: "/x/nightcap-cabin", Address: "https://tv.example.com", Created: time.Now()}
	m := serverModel(t, s)
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{answers: true, name: "Cabin", mode: "cloud", households: -1}})
	v := snap(t, m, "server-elsewhere")
	for _, want := range []string{"On another machine", "● running", "logs -f server", "Check again"} {
		if !strings.Contains(v, want) {
			t.Errorf("doesn't show %q", want)
		}
	}
	if strings.Contains(v, "Update") {
		t.Error("offers Update for a server it doesn't run")
	}
}
