package main

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// The Postgres in Docker screen: what will be made (names and port picked so nothing clashes
// with what's on this computer), made later, on the last step, after the review.

type dockerDBPlanned struct {
	db  dockerDB
	err error
}

func planDockerDBCmd(here bool) tea.Cmd {
	return func() tea.Msg {
		d, err := planDockerDB(here)
		return dockerDBPlanned{d, err}
	}
}

type dockerDBScreen struct {
	kube    bool // in the cluster, not on a machine
	db      *dockerDB
	err     error
	choices choices
}

func newDockerDBScreen() dockerDBScreen {
	return dockerDBScreen{choices: choices{opts: []option{
		{value: "use", title: "Make it"},
		{value: "back", title: "Choose something else"},
	}}}
}

func (s dockerDBScreen) View(width int) string {
	var b strings.Builder
	where := "Docker"
	if s.kube {
		where = "your cluster"
	}
	b.WriteString(heading("A database, made for you", "Made in "+where+" when Nightcap is set up."))
	look := "this computer"
	if s.kube {
		look = "your cluster"
	}
	switch {
	case s.err != nil:
		b.WriteString(note(width, bad.Render("  ✗ "), "Couldn't look at "+look+": "+s.err.Error()) + "\n\n")
		return b.String() + s.choices.view(width)
	case s.db == nil:
		return b.String() + muted.Render("  Looking at "+look+"…")
	}
	d := s.db
	if s.kube {
		b.WriteString(plain.Render("  Postgres 16, in your cluster, with 5 GB for its data.") + "\n")
	} else {
		b.WriteString(plain.Render("  Postgres 16. Its data stays on this computer.") + "\n")
	}
	b.WriteString(muted.Render("  "+d.image+", a password made for you") + "\n")
	b.WriteString("\n" + s.choices.view(width))
	return b.String()
}
