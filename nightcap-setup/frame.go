package main

import (
	"regexp"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// The frame every screen sits in: the header, the step tracker (on the setup steps), the screen,
// and a footer with the keys that work there. It's as wide as the terminal, up to a comfortable
// reading width, and centred. In a wide window the setup steps go down a column on the left, with
// what's been chosen at each, and a server's screen gets the room for its logs.

const (
	maxWidth  = 84
	wideWidth = 116 // (the wide frame at its widest)
	wideFrom  = 100 // (a window at least this wide gets it)
	sideWidth = 22
)

// The setup steps, in order, as the tracker shows them.
var steps = []string{"Where", "Database", "Keys", "Settings", "Review", "Deploy"}

type key struct{ keys, does string }

type frame struct {
	width, height int
	step          int // the setup step this screen is (0-based), or -1 for none
	body          string
	keys          []key
	wide          bool   // the wide frame
	side          string // the steps' column, in the wide frame
	hero          bool   // the screen has its own big header (Welcome)
}

// maxHeight: a taller window doesn't stretch the box; it's centred instead.
const maxHeight = 42

func (f frame) render() string {
	w := min(max(f.width, 40), maxWidth)
	if f.wide {
		w = min(f.width, wideWidth)
	}
	inner := w - 4 // the border, and a space each side
	foot := footer(f.keys, inner)
	room := max(min(f.height, maxHeight)-2, 0) // (the box fills the window's height, less its own border)

	var body string
	if f.side != "" {
		// The steps on the left, a line, the screen on the right; the line runs down to the footer.
		top := header(inner) + "\n"
		bodyW := inner - sideWidth - 3
		fits := room - lipgloss.Height(top) - lipgloss.Height(foot) - 2
		main := clip(lipgloss.NewStyle().Width(bodyW).Render(f.body), fits)
		sideCol := clip(f.side, fits)
		h := max(lipgloss.Height(main), lipgloss.Height(sideCol), fits)
		side := lipgloss.NewStyle().Width(sideWidth).Height(h).Render(sideCol)
		line := frameLine.Render(strings.TrimSuffix(strings.Repeat("│\n", h), "\n"))
		body = top + "\n" + lipgloss.JoinHorizontal(lipgloss.Top, side, " ", line, " ", main)
	} else {
		sections := []string{header(inner)}
		if f.hero {
			sections = []string{""}
		}
		if f.step >= 0 {
			sections = append(sections, tracker(f.step, inner))
		}
		// (Wrapped to the box's width first, so its height is measured as it will be drawn.)
		top := lipgloss.NewStyle().Width(inner).Render(strings.Join(append(sections, ""), "\n"))
		main := clip(lipgloss.NewStyle().Width(inner).Render(f.body), room-lipgloss.Height(top)-1-lipgloss.Height(foot))
		body = top + "\n" + main
	}

	// The footer at the bottom.
	used := lipgloss.Height(body) + 1 + lipgloss.Height(foot)
	if gap := room - used; gap > 0 && !f.hero { // (Welcome is as tall as it is)
		body += strings.Repeat("\n", gap)
	}
	rule := frameLine.Render(strings.Repeat("─", inner))
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(faint).
		Padding(0, 1).
		Width(w - 2).
		Render(body + "\n" + rule + "\n" + foot)

	return lipgloss.Place(max(f.width, w), max(f.height, lipgloss.Height(box)), lipgloss.Center, lipgloss.Center, box)
}

func header(width int) string {
	mark := accentB.Render("☾  N I G H T C A P")
	tag := muted.Render("Setup  v" + version)
	gap := max(width-lipgloss.Width(mark)-lipgloss.Width(tag), 1)
	return "\n" + mark + strings.Repeat(" ", gap) + tag + "\n" + muted.Render("   Your own streaming server")
}

// tracker draws the setup steps: done ones ticked in green, this one in gold, the rest dim.
// A narrow window gets the short form: "Step 2 of 6 · Database".
func tracker(at, width int) string {
	var parts []string
	for i, s := range steps {
		switch {
		case i < at:
			parts = append(parts, good.Render("✓ "+s))
		case i == at:
			parts = append(parts, accentB.Render("● "+s))
		default:
			parts = append(parts, muted.Render("○ "+s))
		}
	}
	line := strings.Join(parts, frameLine.Render(" ── "))
	if lipgloss.Width(line) > width {
		line = muted.Render("Step ") + accentB.Render(itoa(at+1)) + muted.Render(" of "+itoa(len(steps))+"  ·  ") + accentB.Render(steps[at])
	}
	return "\n" + line
}

// sideSteps is the wide frame's column of steps: done ones ticked, with what was chosen under
// them; this one in gold; the rest dim; a line joining them.
func sideSteps(at int, chosen []string) string {
	var b strings.Builder
	b.WriteString(muted.Render("SETUP") + "\n\n")
	for i, s := range steps {
		switch {
		case i < at:
			b.WriteString(good.Render("✓  ") + plain.Render(s) + "\n")
		case i == at:
			b.WriteString(accentB.Render("●  "+s) + "\n")
		default:
			b.WriteString(muted.Render("○  "+s) + "\n")
		}
		if i == len(steps)-1 {
			break
		}
		joint := frameLine.Render("│  ")
		if i < at && i < len(chosen) && chosen[i] != "" {
			for _, l := range strings.Split(lipgloss.NewStyle().Width(sideWidth-3).Render(chosen[i]), "\n") {
				b.WriteString(joint + muted.Render(l) + "\n")
			}
		}
		b.WriteString(joint + "\n")
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func footer(keys []key, width int) string {
	var parts []string
	for _, k := range keys {
		parts = append(parts, accent.Render(k.keys)+" "+muted.Render(k.does))
	}
	line := strings.Join(parts, "   ")
	if lipgloss.Width(line) > width {
		line = strings.Join(parts, "  ")
	}
	return line
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}

// detail is a "label  value  note" line, its note wrapping under itself (not back to the left)
// when it's too long for the room left.
func detail(width, labelW, valueW int, label, value, note string) string {
	noteW := max(width-2-labelW-valueW, 16)
	notes := strings.Split(lipgloss.NewStyle().Width(noteW).Render(note), "\n")
	shown := ""
	if valueW > 0 {
		shown = pad(value, valueW)
	}
	out := "  " + muted.Render(pad(label, labelW)) + plain.Render(shown) + muted.Render(notes[0]) + "\n"
	indent := strings.Repeat(" ", 2+labelW+valueW)
	for _, n := range notes[1:] {
		out += indent + muted.Render(n) + "\n"
	}
	return out
}

// note is a paragraph after a mark ("⚠ "), its lines lined up after the mark.
func note(width int, mark, text string) string {
	lines := strings.Split(lipgloss.NewStyle().Width(max(width-lipgloss.Width(mark), 16)).Render(text), "\n")
	out := mark + muted.Render(lines[0])
	pad := strings.Repeat(" ", lipgloss.Width(mark))
	for _, l := range lines[1:] {
		out += "\n" + pad + muted.Render(l)
	}
	return out
}

// clip fits a body into [rows] lines when it's taller than the window: the part around what's
// chosen (the gold bar) is shown, with "↑ more" / "↓ more" where lines are left out.
func clip(body string, rows int) string {
	lines := strings.Split(body, "\n")
	if rows < 4 || len(lines) <= rows {
		return body
	}
	first, last := -1, -1
	for i, l := range lines {
		if strings.Contains(ansi.ReplaceAllString(l, ""), "┃") {
			if first < 0 {
				first = i
			}
			last = i
		}
	}
	start := 0
	if last >= rows-1 { // (what's chosen is below the fold: scrolled to)
		start = min(last-(rows-3), first)
	}
	end := min(start+rows, len(lines))
	if end < len(lines) {
		end--
	}
	out := append([]string{}, lines[start:end]...)
	if start > 0 {
		out[0] = muted.Render("  ↑ more")
	}
	if end < len(lines) {
		out = append(out, muted.Render("  ↓ more"))
	}
	return strings.Join(out, "\n")
}

// ansi matches colour codes, to read a line's text.
var ansi = regexp.MustCompile("\x1b\\[[0-9;]*m")
