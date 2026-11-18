package main

import (
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Manage: the servers this tool has set up, newest first; one chosen opens its own screen
// (server_screen.go).

// manageChoices lists the servers: each with how it is (looked at as the list opens: [lines], by
// folder; "" while it's being looked at), then where it is.
func manageChoices(list []savedServer, lines map[string]string) choices {
	c := choices{}
	if len(list) == 0 {
		c.opts = []option{{value: "+new", title: "Set up a new server", desc: "About 5 minutes."}}
	}
	for _, s := range list {
		where := map[string]string{"docker": "On this computer", "kubernetes": "On Kubernetes · " + s.Context, "cloudrun": "On Google Cloud", "files": "On another machine"}[s.Where]
		if s.Address != "" {
			where += "  ·  " + s.Address
		}
		line := lines[s.Dir]
		if line == "" {
			line = muted.Render("looking…")
		}
		c.opts = append(c.opts, option{value: s.Dir, title: s.Name, desc: line + "\n" + where})
	}
	return c
}

// serverLine is a server in a line, for the list: "● running · 2 households" (only what's quick to
// tell: its cost is on its own screen).
type serverLine struct{ dir, text string }

func lineOf(s savedServer) serverLine {
	if s.Status == settingUp {
		return serverLine{s.Dir, accent.Render("◐ setting up didn't finish") + muted.Render("  ·  open it to remove it")}
	}
	st := statusOf(s, s.Where == "cloudrun") // (Google Cloud: asked whether it answers; elsewhere a quick look)
	parts := []string{}
	switch {
	case st.answers:
		parts = append(parts, good.Render("● running"))
	case s.Where == "files":
		parts = append(parts, bad.Render("● not reachable"))
	default:
		stopped := true
		for _, p := range st.parts {
			if p.state == "running" {
				stopped = false
			}
		}
		if stopped && st.partsErr == "" {
			parts = append(parts, bad.Render("● stopped"))
		} else {
			parts = append(parts, bad.Render("● not answering"))
		}
	}
	if st.answers {
		addr := s.Address
		if s.Where == "docker" {
			addr = localAddress()
		}
		if o, err := ownerOf(addr, ownerKeyOf(s.Dir), 10*time.Second); err == nil {
			parts = append(parts, plain.Render(count(o.households, "household")))
			if o.update {
				parts = append(parts, accent.Render(o.latest+" is out"))
			}
		}
	}
	return serverLine{s.Dir, strings.Join(parts, muted.Render("  ·  "))}
}

// lookAtAll looks at every server, each as it answers.
func lookAtAll(list []savedServer) tea.Cmd {
	var cmds []tea.Cmd
	for _, s := range list {
		cmds = append(cmds, func() tea.Msg {
			// (Never "looking…" for long: a server that takes too long says so.)
			done := make(chan serverLine, 1)
			go func() { done <- lineOf(s) }()
			select {
			case l := <-done:
				return l
			case <-time.After(15 * time.Second):
				return serverLine{s.Dir, muted.Render("● couldn't tell in time: open it to look")}
			}
		})
	}
	return tea.Batch(cmds...)
}

func manageView(list []savedServer, err error, c choices, note string, width int) string {
	var b strings.Builder
	b.WriteString(heading("Your servers", "Pick one to see how it's doing."))
	switch {
	case err != nil:
		b.WriteString(bad.Render("  ✗ ") + plain.Render("Couldn't read the list: "+err.Error()))
	case len(list) == 0:
		b.WriteString(muted.Render("  None yet.") + "\n\n" + c.view(width))
	default:
		b.WriteString(c.view(width))
	}
	if note != "" {
		b.WriteString("\n\n" + good.Render("  ✓ ") + plain.Render(note))
	}
	return b.String()
}
