package main

import (
	"fmt"
	"math"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The first screen: what this computer has (checked live), then a new server or an existing one.

type checked struct {
	i int
	t tool
}

type welcome struct {
	spin    spinner.Model
	tools   []*tool // nil until its check is back
	choices []string
	cursor  int
	note    string   // a line under the choices ("Coming next: …")
	saved   int      // how many servers are saved here
	tick    int      // the animation's frame
	animGen int      // the animation's round (one left behind by another screen is let go)
	newer   *release // a newer version of this tool, when there is one
}

// animTick is the next frame of Welcome's sky and shine.
type animTick struct{ gen int }

const animEvery = 70 * time.Millisecond

// still: no animation, when asked for (NIGHTCAP_NO_MOTION=1) or the terminal can't redraw well.
var still = os.Getenv("NIGHTCAP_NO_MOTION") != "" || os.Getenv("TERM") == "dumb"

// animate starts (or restarts) the animation.
func (w *welcome) animate() tea.Cmd {
	if still {
		return nil
	}
	w.animGen++
	gen := w.animGen
	return tea.Tick(animEvery, func(time.Time) tea.Msg { return animTick{gen} })
}

func newWelcome() welcome {
	s := spinner.New(spinner.WithSpinner(spinner.MiniDot), spinner.WithStyle(accent))
	return welcome{
		spin:    s,
		tools:   make([]*tool, len(checks)),
		choices: []string{"Set up a new server", "Manage an existing server"},
	}
}

func (w welcome) Init() tea.Cmd {
	cmds := []tea.Cmd{w.spin.Tick}
	if !still {
		cmds = append(cmds, tea.Tick(animEvery, func(time.Time) tea.Msg { return animTick{0} }))
	}
	for i, check := range checks {
		cmds = append(cmds, func() tea.Msg { return checked{i, check()} })
	}
	cmds = append(cmds, checkForUpdate)
	return tea.Batch(cmds...)
}

func (w welcome) Update(msg tea.Msg) (welcome, tea.Cmd) {
	switch msg := msg.(type) {
	case checked:
		w.tools[msg.i] = &msg.t
	case release:
		w.newer = &msg
	case animTick:
		if msg.gen != w.animGen {
			return w, nil
		}
		w.tick++
		gen := w.animGen
		return w, tea.Tick(animEvery, func(time.Time) tea.Msg { return animTick{gen} })
	case spinner.TickMsg:
		var cmd tea.Cmd
		w.spin, cmd = w.spin.Update(msg)
		return w, cmd
	case tea.KeyMsg:
		switch msg.String() {
		case "up", "k", "left", "h":
			w.cursor = (w.cursor + len(w.choices) - 1) % len(w.choices)
			w.note = ""
		case "down", "j", "tab", "right", "l":
			w.cursor = (w.cursor + 1) % len(w.choices)
			w.note = ""
		}
	}
	return w, nil
}

func (w welcome) done() bool {
	for _, t := range w.tools {
		if t == nil {
			return false
		}
	}
	return true
}

func (w welcome) View(width, height int) string {
	var b strings.Builder
	colW := min(width, 80) // (one column, centred: the cards, then the checks)
	if heroFits(width, height) {
		lw := lipgloss.Width(logoLines[0])
		b.WriteString(center(width, sky(lw+16, w.tick)) + "\n")
		b.WriteString(center(width, logo(w.tick)) + "\n")
		b.WriteString(center(width, muted.Render("Your own streaming server  ·  setup "+versionLabel())) + "\n\n")
	} else {
		b.WriteString(plain.Render("Let's get a Nightcap server running.") + "\n\n")
	}

	// The two ways in, as cards: side by side when there's room.
	saved := "None yet."
	if w.saved > 0 {
		saved = count(w.saved, "server") + " saved here."
	}
	cards := []struct{ title, desc, foot string }{
		{"Set up a new server", "On this computer, on Kubernetes, on Google Cloud, or on another machine.", "About 5 minutes."},
		{"Manage your servers", "See how they're doing, read their logs, update, stop or remove them.", saved},
	}
	side := colW >= 64
	cardW := colW
	if side {
		cardW = (colW - 2) / 2
	}
	card := func(i, h int) string {
		border := faint
		if i == w.cursor {
			border = gold
		}
		return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(border).
			Padding(0, 1).Width(cardW - 2).Height(h).Render(cardBody(cards[i].title, cards[i].desc, cards[i].foot, i == w.cursor, cardW))
	}
	var menu string
	if side {
		// (Both as tall as the taller.)
		h := max(lipgloss.Height(card(0, 0)), lipgloss.Height(card(1, 0))) - 2
		menu = lipgloss.JoinHorizontal(lipgloss.Top, card(0, h), "  ", card(1, h))
	} else {
		// (A narrow window: a plain list.)
		var rows []string
		for i, c := range cards {
			if i == w.cursor {
				rows = append(rows, accentB.Render("▸ "+c.title))
			} else {
				rows = append(rows, plain.Render("  "+c.title))
			}
		}
		menu = lipgloss.NewStyle().Width(colW).Render(lipgloss.JoinVertical(lipgloss.Left, rows...))
	}

	// What this computer has: a row of its tools, centred, and what's wrong with any, under it.
	var chips, problems []string
	for i, t := range w.tools {
		switch {
		case t == nil:
			chips = append(chips, w.spin.View()+" "+plain.Render(toolName(i))+muted.Render("  checking…"))
		case t.ok:
			chip := good.Render("✓ ") + bold.Render(t.name) + muted.Render(" "+t.ver)
			if t.detail != "ready" {
				chip += muted.Render(" · " + t.detail)
			}
			chips = append(chips, chip)
		default:
			chips = append(chips, muted.Render("– "+t.name)) // (not here: only needed for its own place)
			why := t.name + ": " + t.detail
			if t.hint != "" {
				why += " (" + t.hint + ")"
			}
			problems = append(problems, why)
		}
	}
	row := strings.Join(chips, frameLine.Render("    ·    "))
	if lipgloss.Width(row) > width {
		row = strings.Join(chips, "\n")
	}
	var checks strings.Builder
	checks.WriteString(center(width, muted.Render("THIS COMPUTER")) + "\n\n")
	checks.WriteString(center(width, row))
	for _, p := range problems {
		checks.WriteString("\n" + center(width, muted.Render(p)))
	}
	if !w.done() {
		checks.WriteString("\n\n" + center(width, muted.Render("Still checking: you can choose already.")))
	}
	if w.note != "" {
		checks.WriteString("\n\n" + center(width, muted.Render(w.note)))
	}
	if w.newer != nil {
		checks.WriteString("\n\n" + center(width, accent.Render("New version "+w.newer.version)) + "\n" +
			center(width, lipgloss.NewStyle().Width(min(width, 110)).Align(lipgloss.Center).Render(muted.Render(w.newer.how()))))
	}
	b.WriteString(center(width, menu) + "\n\n\n" + checks.String() + "\n")
	return b.String()
}

// cardBody is what's in one of Welcome's cards.
func cardBody(title, desc, foot string, chosen bool, cardW int) string {
	t, mark := plain.Bold(true), "  "
	if chosen {
		t, mark = accentB, accentB.Render("▸ ")
	}
	return mark + t.Render(title) + "\n\n" +
		lipgloss.NewStyle().Width(cardW-6).PaddingLeft(2).Foreground(dim).Render(desc) + "\n\n" + muted.Render("  "+foot)
}

// center puts a block in the middle of [width], its lines kept lined up with each other.
func center(width int, block string) string {
	return lipgloss.PlaceHorizontal(width, lipgloss.Center, block)
}

// The big NIGHTCAP: its letters in a gold that deepens left to right, their shadows dim.
var logoLines = []string{
	"███╗   ██╗██╗ ██████╗ ██╗  ██╗████████╗ ██████╗ █████╗ ██████╗ ",
	"████╗  ██║██║██╔════╝ ██║  ██║╚══██╔══╝██╔════╝██╔══██╗██╔══██╗",
	"██╔██╗ ██║██║██║  ███╗███████║   ██║   ██║     ███████║██████╔╝",
	"██║╚██╗██║██║██║   ██║██╔══██║   ██║   ██║     ██╔══██║██╔═══╝ ",
	"██║ ╚████║██║╚██████╔╝██║  ██║   ██║   ╚██████╗██║  ██║██║     ",
	"╚═╝  ╚═══╝╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝╚═╝     ",
}

// heroFits: the big NIGHTCAP, when the window has the room for it.
func heroFits(width, height int) bool {
	return width >= lipgloss.Width(logoLines[0])+20 && height >= 36
}

// The sky over the NIGHTCAP: a moon, and stars that twinkle, each in its own time.
var stars = []struct {
	x, y  int
	phase float64
}{{3, 0, 0}, {11, 2, 2.1}, {19, 1, 4.0}, {27, 0, 1.3}, {36, 2, 5.2}, {44, 1, 3.1}, {52, 0, 0.7}, {60, 2, 2.8}, {67, 1, 4.6}, {74, 0, 1.9}}

func sky(width, tick int) string {
	rows := [3][]string{}
	for y := range rows {
		rows[y] = make([]string, width)
		for x := range rows[y] {
			rows[y][x] = " "
		}
	}
	for _, s := range stars {
		if s.x >= width-4 {
			continue
		}
		v := (math.Sin(float64(tick)*0.09+s.phase) + 1) / 2 // 0 to 1
		if still {
			v = 0.5
		}
		switch {
		case v > 0.85:
			rows[s.y][s.x] = plain.Render("✦")
		case v > 0.45:
			rows[s.y][s.x] = muted.Render("·")
		default:
			rows[s.y][s.x] = frameLine.Render("·")
		}
	}
	rows[0][width-3] = accentB.Render("☾")
	var out []string
	for _, r := range rows {
		out = append(out, strings.Join(r, ""))
	}
	return strings.Join(out, "\n")
}

func logo(tick int) string {
	from, to := [3]float64{0xFF, 0xD9, 0x8A}, [3]float64{0xE8, 0x89, 0x2B} // (pale gold to amber)
	if !lipgloss.HasDarkBackground() {
		from, to = [3]float64{0xB0, 0x78, 0x10}, [3]float64{0x8A, 0x45, 0x00}
	}
	n := lipgloss.Width(logoLines[0])
	// A shine sweeps across, slanted, every few seconds.
	const every = 110 // frames
	at := float64(tick%every)*2.2 - 12
	if tick == 0 || still {
		at = -100
	}
	var out []string
	for row, l := range logoLines {
		var b strings.Builder
		for i, r := range []rune(l) {
			switch {
			case r == ' ':
				b.WriteRune(r)
			case r == '█':
				f := float64(i) / float64(n-1)
				rgb := [3]float64{}
				for k := range rgb {
					rgb[k] = from[k] + (to[k]-from[k])*f
				}
				if shine := 1 - math.Abs(float64(i)-at-float64(row))/5; shine > 0 {
					for k, white := range [3]float64{0xFF, 0xF8, 0xE6} {
						rgb[k] += (white - rgb[k]) * shine * 0.75
					}
				}
				c := fmt.Sprintf("#%02X%02X%02X", int(rgb[0]), int(rgb[1]), int(rgb[2]))
				b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(c)).Render(string(r)))
			default:
				b.WriteString(frameLine.Render(string(r)))
			}
		}
		out = append(out, b.String())
	}
	return strings.Join(out, "\n")
}

func (w welcome) keys() []key {
	return []key{{"↑↓", "choose"}, {"enter", "select"}, {"q", "quit"}}
}

var toolNames = []string{"Docker", "kubectl", "gcloud"}

func toolName(i int) string { return toolNames[i] }

func pad(s string, n int) string {
	if w := lipgloss.Width(s); w < n {
		return s + strings.Repeat(" ", n-w)
	}
	return s + " "
}

// recheck looks at this computer again (Docker started, a tool installed since the app opened).
func recheck() tea.Cmd {
	var cmds []tea.Cmd
	for i, check := range checks {
		cmds = append(cmds, func() tea.Msg { return checked{i, check()} })
	}
	return tea.Batch(cmds...)
}
