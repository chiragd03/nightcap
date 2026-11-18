package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func isQuit(cmd tea.Cmd) bool {
	if cmd == nil {
		return false
	}
	_, ok := cmd().(tea.QuitMsg)
	return ok
}

// Ctrl+C (or q) asks first mid-setup; Keep going stays, Quit quits, Ctrl+C twice quits at once.
// Where nothing is lost (Welcome) it just quits.
func TestQuitAsksMidSetup(t *testing.T) {
	m := toKeysScreen(t, "docker", true) // (answers given: Where, the database)
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if isQuit(cmd) || !m.(app).confirming {
		t.Fatal("Ctrl+C mid-setup quit without asking")
	}
	if v := snap(t, m, "confirm-quit"); !strings.Contains(v, "Quit setting up?") || !strings.Contains(v, "Your answers so far are lost.") {
		t.Error("the question isn't said")
	}
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter}) // (Keep going: the default)
	if isQuit(cmd) || m.(app).confirming || m.(app).screen != keysScreenID {
		t.Fatal("Keep going didn't keep going")
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	m = press(m, "down")
	if _, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter}); !isQuit(cmd) {
		t.Error("Quit didn't quit")
	}
	if _, cmd = m.Update(tea.KeyMsg{Type: tea.KeyCtrlC}); !isQuit(cmd) {
		t.Error("Ctrl+C twice didn't quit")
	}

	var w tea.Model = newApp()
	w, _ = w.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	if _, cmd := w.Update(tea.KeyMsg{Type: tea.KeyCtrlC}); !isQuit(cmd) {
		t.Error("Welcome asked before quitting")
	}
}
