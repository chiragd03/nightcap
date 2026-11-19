package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func pluginsModel(t *testing.T) tea.Model {
	t.Helper()
	s := savedServer{Name: "Home", Slug: "home", Where: "docker", Mode: "home", Dir: t.TempDir(), Created: time.Now()}
	m := serverModel(t, s) // (sets NIGHTCAP_SETUP_HOME)
	_ = os.MkdirAll(pluginsDir(), 0o700)
	_ = os.WriteFile(filepath.Join(pluginsDir(), "sample.yaml"), []byte(samplePluginFile), 0o600)
	m, _ = m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{parts: []part{{"server", "running", "healthy", 0}}, answers: true, households: -1}})
	a := m.(app)
	i := slices.IndexFunc(a.server.actions.opts, func(o option) bool { return o.value == "plugins" })
	if i < 0 {
		t.Fatalf("no Plugins line: %+v", a.server.actions.opts)
	}
	a.server.actions.cursor = i
	m = press(a, "enter")
	if m.(app).screen != pluginsScreenID {
		t.Fatal("not on the Plugins screen")
	}
	return m
}

func viewOf(m tea.Model) string { return ansi.ReplaceAllString(m.(app).View(), "") }

func TestPluginsAdd(t *testing.T) {
	m := pluginsModel(t)
	if v := viewOf(m); !strings.Contains(v, "Plugins on Home") || !strings.Contains(v, "Add a plugin") {
		t.Fatalf("list:\n%s", v)
	}
	m = press(m, "enter") // Add a plugin
	if v := viewOf(m); !strings.Contains(v, "Which plugin?") || !strings.Contains(v, "Sample") {
		t.Fatalf("pick:\n%s", v)
	}
	m = press(m, "enter") // Sample: its first question (the token is made, not asked)
	if v := viewOf(m); !strings.Contains(v, "Your service-a key") || !strings.Contains(v, "1 of 2") {
		t.Fatalf("first question:\n%s", v)
	}
	m = press(m, "enter")
	if v := viewOf(m); !strings.Contains(v, "It's needed.") {
		t.Error("an empty required setting was taken")
	}
	for _, r := range "key-123" {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	if v := viewOf(m); strings.Contains(v, "key-123") {
		t.Error("a secret setting is shown as typed")
	}
	m = press(m, "enter")
	if v := viewOf(m); !strings.Contains(v, "Model (optional)") || !strings.Contains(v, "Leave it empty to skip") {
		t.Fatalf("second question:\n%s", v)
	}
	// (Its steps aren't run here: the screen is told they went well.)
	a := m.(app)
	a.plugins.out = make(chan pluginMsg, 1)
	op := &pluginOp{what: "add", s: a.plugins.s, f: a.plugins.file, values: a.plugins.values}
	op.p = savedPlugin{ID: "sample", Name: "Sample", Service: "plugin-sample", Port: 8080, Address: "http://plugin-sample:8080/{PLUGIN_TOKEN}/manifest.json"}
	_ = writePluginEnv(op.s.Dir, "sample", op.f, map[string]string{"PLUGIN_TOKEN": "tok12345", "SERVICE_KEY": "key-123"})
	op.s.Plugins = []savedPlugin{op.p}
	a.plugins.op, a.plugins.stage, a.plugins.ended = op, plRun, false
	a.plugins.steps = []deployStep{{title: "Getting the image"}}
	var mm tea.Model = a
	mm, _ = mm.Update(pluginMsg{s: op.s, step: 0, state: done})
	mm, _ = mm.Update(pluginMsg{s: op.s, step: -1, end: true, p: op.p})
	v := viewOf(mm)
	for _, want := range []string{"Sample is running", "Settings, Extra add-ons", "http://plugin-sample:8080/tok12345/manifest.json", "Show address"} {
		if !strings.Contains(v, want) {
			t.Errorf("Done hasn't %q:\n%s", want, v)
		}
	}
	// Back to the list: the plugin, then its own actions; Show address shows it.
	mm = press(mm, "enter")
	if v := viewOf(mm); !strings.Contains(v, "Sample") || strings.Contains(v, "tok12345") {
		t.Errorf("list after adding:\n%s", v)
	}
	mm = press(mm, "enter") // the plugin
	mm = press(mm, "enter") // Show address
	if v := viewOf(mm); !strings.Contains(v, "tok12345/manifest.json") {
		t.Errorf("Show address:\n%s", v)
	}
	// Remove asks first.
	mm = press(mm, "down", "down", "enter")
	if v := viewOf(mm); !strings.Contains(v, "Remove Sample?") || !strings.Contains(v, "Keep it") {
		t.Errorf("remove confirm:\n%s", v)
	}
	// Esc goes back, then back to the server's screen.
	mm = press(mm, "esc", "esc", "esc")
	if mm.(app).screen != serverScreenID {
		t.Errorf("Esc didn't go back to the server: screen %d", mm.(app).screen)
	}
}

func TestPluginsStoppedServer(t *testing.T) {
	m := pluginsModel(t)
	a := m.(app)
	a.plugins.running = false
	a.plugins.toList("")
	i := slices.IndexFunc(a.plugins.list.opts, func(o option) bool { return o.value == "add" })
	if a.plugins.list.opts[i].why != "Start the server first." {
		t.Error("Add offered while the server is stopped")
	}
}

func TestNoPluginFilesNoLine(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	if title, _ := pluginsLine(savedServer{Where: "docker"}, nil); title != "" {
		t.Error("a Plugins line with no plugin files and no plugins")
	}
	if title, _ := pluginsLine(savedServer{Where: "files", Plugins: []savedPlugin{{Name: "X"}}}, nil); title != "" {
		t.Error("a Plugins line for another machine")
	}
}

func TestPluginPartsSplit(t *testing.T) {
	parts, plugins := splitPlugins([]part{{"server", "running", "healthy", 0}, {"db", "running", "healthy", 0},
		{"plugin-my-addon", "running", "", 0}, {"plugin-other-addon", "exited", "", 1}})
	if len(parts) != 2 || plugins["my-addon"] != "running" || plugins["other-addon"] != "stopped" {
		t.Errorf("parts %v plugins %v", parts, plugins)
	}
	s := savedServer{Where: "docker", Plugins: []savedPlugin{{ID: "my-addon", Name: "My add-on"}, {ID: "other-addon", Name: "Other add-on"}, {ID: "x", Name: "X", Status: settingUp}}}
	if _, d := pluginsLine(s, plugins); d != "My add-on running · Other add-on stopped · X adding didn't finish" {
		t.Errorf("line: %s", d)
	}
}
