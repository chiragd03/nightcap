package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func TestRemoveElsewhere(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nightcap-cabin")
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(filepath.Join(dir, "nightcap.env"), []byte("OWNER_KEY=x\n"), 0o600)
	keep := savedServer{Name: "Home", Slug: "home", Where: "files", Dir: filepath.Join(t.TempDir(), "home"), Created: time.Now().Add(-time.Hour)}
	s := savedServer{Name: "Cabin", Slug: "cabin", Where: "files", Mode: "cloud", Dir: dir, Address: "https://tv.example.com", Created: time.Now()}
	m := serverModel(t, s)
	_ = saveServer(keep)
	// (The list now has Cabin and Home; the screen is Cabin's.)
	m, _ = m.Update(statusMsg{dir: s.Dir, st: serverStatus{answerErr: "nothing answered"}})
	m = press(m, "down", "enter") // Remove
	if m.(app).screen != removeScreenID {
		t.Fatal("Remove didn't open")
	}
	v := snap(t, m, "remove")
	for _, want := range []string{"Remove Cabin?", "Its files and keys", "keeps running", "Type its name"} {
		if !strings.Contains(v, want) {
			t.Errorf("Remove doesn't say %q", want)
		}
	}
	// A wrong name does nothing.
	m = press(m, "Cabn", "enter")
	if m.(app).remove.working {
		t.Fatal("a wrong name started removing")
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	m = press(m, "bin")
	snap(t, m, "remove-typed")
	a := m.(app)
	cmd := a.remove.start()
	if cmd == nil || !a.remove.working {
		t.Fatal("the right name didn't start removing")
	}
	// Run it as Bubble Tea would: the batch's messages, back in.
	var m2 tea.Model = a
	for _, msg := range runBatch(cmd) {
		if r, ok := msg.(removed); ok {
			m2, _ = m2.Update(r)
		}
	}
	got := m2.(app)
	if got.screen != manageScreenID || !strings.Contains(snap(t, m2, "removed"), "Cabin was removed.") {
		t.Fatalf("after removing: screen %d, note %q", got.screen, got.manageNote)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("its folder is still there")
	}
	list, _ := loadServers()
	if len(list) != 1 || list[0].Name != "Home" {
		t.Errorf("the list: %+v", list)
	}
}

// runBatch runs a command and the commands in a batch, for their messages (not ticks: they wait).
func runBatch(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	msg := cmd()
	if b, ok := msg.(tea.BatchMsg); ok {
		var out []tea.Msg
		for _, c := range b {
			if c == nil {
				continue
			}
			done := make(chan tea.Msg, 1)
			go func(c tea.Cmd) { done <- c() }(c)
			select {
			case m := <-done:
				out = append(out, m)
			case <-time.After(2 * time.Second):
			}
		}
		return out
	}
	return []tea.Msg{msg}
}

func TestRemoveDockerSaysTheDataGoes(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("services:\n  db:\n    image: postgres\n"), 0o644)
	r := newRemoveScreen(savedServer{Name: "Home", Where: "docker", Dir: dir})
	if v := r.View(80); !strings.Contains(v, "watch history") {
		t.Error("doesn't say the database goes")
	}
	_ = os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("services:\n  server:\n    image: x\n"), 0o644)
	r = newRemoveScreen(savedServer{Name: "Home", Where: "docker", Dir: dir})
	if v := r.View(80); !strings.Contains(v, "so it stays") {
		t.Error("doesn't say a database of its own stays")
	}
}
