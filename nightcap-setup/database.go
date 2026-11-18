package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The database: which kind (only what fits where Nightcap runs is offered), then, for one that
// exists already, its connection string, checked live. The password shows as dots as it's typed
// or pasted, and is never shown or written anywhere.

func databaseChoices(where string, cursor int) choices {
	c := choices{cursor: cursor}
	switch where {
	case "docker", "files":
		c.opts = append(c.opts, option{value: "docker", title: "Make one for me", badge: "Recommended",
			desc: "Nothing to set up. It lives next to Nightcap.\nPostgres 16 in Docker"})
	case "kubernetes":
		c.opts = append(c.opts, option{value: "docker", title: "Make one for me", badge: "Recommended",
			desc: "Nothing to set up. It lives in your cluster, with its own storage.\nPostgres 16, a StatefulSet"})
	}
	c.opts = append(c.opts, option{value: "url", title: "I already have one", desc: "Paste its address.\nAny Postgres. Free options: Neon, Supabase"})
	c.usable()
	return c
}

type dbChecked struct {
	url    string
	report dbReport
}

// connField is the connection string being typed, and what its check found.
type connField struct {
	input    textinput.Model
	spin     spinner.Model
	checking bool
	report   *dbReport // the last check's, for the text it was made for
	checked  string
}

func newConnField() connField {
	in := textinput.New()
	in.Placeholder = "paste it here (postgresql://…)"
	in.Prompt = ""
	in.CharLimit = 2000
	in.EchoMode = textinput.EchoNone // drawn here instead, with the password as dots
	in.Focus()
	return connField{input: in, spin: spinner.New(spinner.WithSpinner(spinner.MiniDot), spinner.WithStyle(accent))}
}

// check starts a check of what's typed (nothing if it's empty or being checked).
func (f *connField) check() tea.Cmd {
	url := strings.TrimSpace(f.input.Value())
	if url == "" || f.checking {
		return nil
	}
	f.checking, f.report = true, nil
	return tea.Batch(f.spin.Tick, func() tea.Msg { return dbChecked{url, checkDatabase(url)} })
}

func (f connField) Update(msg tea.Msg) (connField, tea.Cmd) {
	switch msg := msg.(type) {
	case dbChecked:
		f.checking = false
		if msg.url == strings.TrimSpace(f.input.Value()) {
			f.report, f.checked = &msg.report, msg.url
		}
		return f, nil
	case spinner.TickMsg:
		if !f.checking {
			return f, nil
		}
		var cmd tea.Cmd
		f.spin, cmd = f.spin.Update(msg)
		return f, cmd
	case tea.KeyMsg:
		before := f.input.Value()
		var cmd tea.Cmd
		f.input, cmd = f.input.Update(msg)
		if f.input.Value() != before {
			f.report = nil // changed since it was checked
		}
		return f, cmd
	}
	return f, nil
}

// good is whether what's typed now has been checked and is fine to use.
func (f connField) good() bool {
	return f.report != nil && f.report.ok && f.checked == strings.TrimSpace(f.input.Value())
}

func (f connField) View(width int) string {
	boxW := min(width-2, 76)
	value := f.input.Value()
	var shown string
	if value == "" {
		shown = muted.Render(f.input.Placeholder)
	} else {
		masked := []rune(maskURL(value))
		pos := min(f.input.Position(), len(masked))
		// The text that fits, with the cursor in view (long strings scroll).
		view := boxW - 4
		start := max(0, pos-view+1)
		end := min(len(masked), start+view)
		before, at, after := string(masked[start:pos]), " ", ""
		if pos < end {
			at, after = string(masked[pos]), string(masked[pos+1:end])
		}
		shown = plain.Render(before) + lipgloss.NewStyle().Reverse(true).Render(at) + plain.Render(after)
	}
	field := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(gold).
		Padding(0, 1).Width(boxW).Render(shown)

	var b strings.Builder
	b.WriteString(heading("Paste your database's address", "It starts with postgresql://. The password stays hidden."))
	b.WriteString(muted.Render("Free options: Neon (neon.com), Supabase (supabase.com).") + "\n\n")
	b.WriteString(field + "\n\n")

	switch {
	case f.checking:
		b.WriteString("  " + f.spin.View() + " " + plain.Render("Checking "+dbWhere(value)+"…"))
	case f.report != nil && f.report.ok:
		r := f.report
		b.WriteString(row(good.Render("✓"), "Connected", plain.Render("It works")+muted.Render("  ·  PostgreSQL "+r.version+", pgcrypto "+r.pgcrypto)))
		switch {
		case r.households >= 0:
			b.WriteString(row(accent.Render("•"), "Already has", plain.Render(
				fmt.Sprintf("%s, %s", count(r.households, "household"), count(r.profiles, "profile")))+muted.Render("  ·  kept")))
		default:
			b.WriteString(row(muted.Render("•"), "Data", muted.Render("empty: a fresh start")))
		}
		if r.others > 0 {
			b.WriteString("\n" + note(width, accent.Render("  ⚠ "), fmt.Sprintf("It also has %s from something else. A database of its own is best.", count(r.others, "table"))))
		}
	case f.report != nil:
		b.WriteString(note(width, bad.Render("  ✗ "), f.report.problem))
		if f.report.advice != "" {
			b.WriteString("\n" + note(width, "    ", f.report.advice))
		}
	}
	return b.String()
}

func (f connField) keys() []key {
	switch {
	case f.good():
		return []key{{"enter", "continue"}, {"esc", "back"}, {"ctrl+c", "quit"}}
	case f.report != nil:
		return []key{{"enter", "check again"}, {"esc", "back"}, {"ctrl+c", "quit"}}
	}
	return []key{{"enter", "check"}, {"esc", "back"}, {"ctrl+c", "quit"}}
}

func row(mark, label, value string) string {
	return "  " + mark + "  " + plain.Render(pad(label, 15)) + value + "\n"
}

func count(n int, what string) string {
	if n == 1 {
		return "1 " + what
	}
	return fmt.Sprintf("%d %ss", n, what)
}
