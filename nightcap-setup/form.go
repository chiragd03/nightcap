package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// A form: fields one under another, Tab (or ↓) to the next, Shift+Tab (or ↑) back. A text field is
// typed in; a secret one shows as dots but for its last four characters. A choice field is
// changed with ← →. Each field can show a status beside it ("✓ works").

type fieldKind int

const (
	textField fieldKind = iota
	choiceField
)

type field struct {
	label, hint string
	kind        fieldKind
	input       textinput.Model
	secret      bool
	opts        []option // a choice field's
	sel         int
	status      string // shown under the field
	statusKind  int    // 0 plain, 1 good, -1 bad
}

func newText(label, hint, value, placeholder string, secret bool) *field {
	in := textinput.New()
	in.Prompt = ""
	in.Placeholder = placeholder
	in.CharLimit = 500
	in.SetValue(value)
	in.EchoMode = textinput.EchoNone // drawn here (a secret one as dots)
	return &field{label: label, hint: hint, kind: textField, input: in, secret: secret}
}

func newChoice(label, hint string, opts []option, sel int) *field {
	return &field{label: label, hint: hint, kind: choiceField, opts: opts, sel: sel}
}

func (f *field) value() string {
	if f.kind == choiceField {
		return f.opts[f.sel].value
	}
	return strings.TrimSpace(f.input.Value())
}

type form struct {
	fields []*field
	focus  int
}

func (fm *form) focused() *field { return fm.fields[fm.focus] }

func (fm *form) move(by int) {
	fm.fields[fm.focus].input.Blur()
	fm.focus = (fm.focus + by + len(fm.fields)) % len(fm.fields)
	if f := fm.fields[fm.focus]; f.kind == textField {
		f.input.Focus()
		f.input.CursorEnd()
	}
}

// Update handles moving between fields and the focused field's own keys; it says whether the
// key was one it used.
func (fm *form) Update(msg tea.KeyMsg) (bool, tea.Cmd) {
	f := fm.focused()
	switch msg.String() {
	case "tab", "down":
		fm.move(1)
		return true, nil
	case "shift+tab", "up":
		fm.move(-1)
		return true, nil
	}
	if f.kind == choiceField {
		switch msg.String() {
		case "left", "h":
			f.sel = (f.sel + len(f.opts) - 1) % len(f.opts)
			return true, nil
		case "right", "l", " ":
			f.sel = (f.sel + 1) % len(f.opts)
			return true, nil
		}
		return false, nil
	}
	if msg.Type == tea.KeyEnter {
		return false, nil
	}
	before := f.input.Value()
	var cmd tea.Cmd
	f.input, cmd = f.input.Update(msg)
	if f.input.Value() != before {
		f.status, f.statusKind = "", 0 // changed since it was checked
	}
	return true, cmd
}

func (fm form) View(width int) string {
	boxW := min(width-2, 64)
	var parts []string
	for i, f := range fm.fields {
		on := i == fm.focus
		label := bold.Render(f.label)
		if on {
			label = accentB.Render(f.label)
		}
		if f.hint != "" {
			label += "  " + muted.Render(f.hint)
		}
		var body string
		if f.kind == choiceField {
			// One row of choices (the chosen one lit), and what the chosen one means under it.
			var opts []string
			for j, o := range f.opts {
				switch {
				case j == f.sel && on:
					opts = append(opts, accentB.Render("● "+o.title))
				case j == f.sel:
					opts = append(opts, bold.Render("● "+o.title))
				default:
					opts = append(opts, muted.Render("○ "+o.title))
				}
			}
			body = "  " + strings.Join(opts, "    ")
			if lipgloss.Width(body) > width || len(f.opts) > 5 {
				// (Many, or too wide for a row: the chosen one alone, flipped through with ←→.)
				style := bold
				if on {
					style = accentB
				}
				body = "  " + muted.Render("‹ ") + style.Render(f.opts[f.sel].title) + muted.Render(" ›") +
					muted.Render(fmt.Sprintf("    %d of %d", f.sel+1, len(f.opts)))
			}
			if d := f.opts[f.sel].desc; d != "" {
				body += "\n" + muted.Render("  "+d)
			}
		} else {
			var border lipgloss.TerminalColor = faint
			if on {
				border = gold
			}
			body = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(border).Padding(0, 1).
				Width(boxW).Render(f.shown(on, boxW-4))
		}
		part := label + "\n" + body
		switch f.statusKind {
		case 1:
			part += "\n" + good.Render("  ✓ "+f.status)
		case -1:
			part += "\n" + bad.Render("  ✗ ") + plain.Render(f.status)
		default:
			if f.status != "" {
				part += "\n" + muted.Render("  "+f.status)
			}
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, "\n\n")
}

// shown is a text field's value as drawn: a secret's characters as dots but its last four, the
// cursor where it is (when focused), scrolled to keep it in view.
func (f *field) shown(focused bool, room int) string {
	v := []rune(f.input.Value())
	if len(v) == 0 {
		if focused {
			return lipgloss.NewStyle().Reverse(true).Render(" ") + muted.Render(f.input.Placeholder)
		}
		return muted.Render(f.input.Placeholder)
	}
	if f.secret {
		keep := min(4, len(v)/4)
		masked := []rune(strings.Repeat("•", len(v)-keep) + string(v[len(v)-keep:]))
		v = masked
	}
	pos := min(f.input.Position(), len(v))
	if !focused {
		if len(v) > room {
			v = append(v[:room-1], '…')
		}
		return plain.Render(string(v))
	}
	start := max(0, pos-room+1)
	end := min(len(v), start+room)
	before, at, after := string(v[start:pos]), " ", ""
	if pos < end {
		at, after = string(v[pos]), string(v[pos+1:end])
	}
	return plain.Render(before) + lipgloss.NewStyle().Reverse(true).Render(at) + plain.Render(after)
}

// alone is a text field drawn by itself, under its screen's own question: its box, and under it
// what it's for or how its check went. (One question a screen: no label, no other fields.)
func (f *field) alone(width int) string {
	boxW := min(width-2, 64)
	out := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(gold).Padding(0, 1).
		Width(boxW).Render(f.shown(true, boxW-4))
	switch f.statusKind {
	case 1:
		out += "\n" + good.Render("  ✓ "+f.status)
	case -1:
		out += "\n" + note(width, bad.Render("  ✗ "), f.status)
	default:
		if f.status != "" {
			out += "\n" + note(width, "  ", f.status)
		}
	}
	return out
}
