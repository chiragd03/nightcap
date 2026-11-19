package main

import (
	"fmt"
	"slices"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The Plugins screen, opened from a server's screen: its plugins and "Add a plugin" (when there's a
// plugin file); a plugin's own actions (Show address, Update, Remove); adding asks each of its
// settings on a screen of its own; then the steps, and Done with the address to paste.

type pluginStage int

const (
	plList pluginStage = iota
	plOne
	plPick
	plAsk
	plRun
	plDone
	plConfirm
)

type pluginsScreen struct {
	s       savedServer
	running bool // the server runs (adding and updating wait for that)
	stage   pluginStage
	list    choices
	files   []pluginFile
	cur     savedPlugin // the plugin chosen
	file    pluginFile  // its file (adding, updating)
	values  map[string]string
	asks    []pluginSetting // the settings still to ask, in order
	ask     int
	field   *field
	show    bool // its address on screen
	op      *pluginOp
	ended   bool // its steps' end has come (keys wait for it)
	steps   []deployStep
	out     chan pluginMsg
	err     error
	note    string
	spin    string // the spinner's frame (drawn by the app)
}

type pluginMsg struct {
	s     savedServer // the server's entry as the op left it (a copy)
	step  int
	state stepState
	note  string
	err   error
	end   bool
	p     savedPlugin // at the end: the plugin as the op left it
}

// pluginsLine is the server screen's one line about plugins ("" when there's none, and no file to
// add one from).
func pluginsLine(s savedServer, states map[string]string) (title, desc string) {
	if s.Where == "files" || s.Status == settingUp {
		return "", ""
	}
	var names []string
	for _, p := range s.Plugins {
		state := states[p.ID]
		switch {
		case p.Status == settingUp:
			state = "adding didn't finish"
		case state == "":
			state = "not there"
		}
		names = append(names, p.Name+" "+state)
	}
	switch {
	case len(names) > 0:
		return "Plugins", strings.Join(names, " · ")
	case slices.ContainsFunc(loadPluginFiles(), func(f pluginFile) bool { return f.Err == "" }):
		return "Plugins", "Add one: a plugin file is ready."
	}
	return "", ""
}

func newPluginsScreen(s savedServer, running bool) pluginsScreen {
	p := pluginsScreen{s: freshServer(s), running: running}
	p.toList("")
	return p
}

func (p *pluginsScreen) toList(note string) {
	p.stage, p.note, p.err, p.show = plList, note, nil, false
	p.files = loadPluginFiles()
	p.list = choices{}
	for _, sp := range p.s.Plugins {
		desc := "Show its address, update or remove it."
		if sp.Status == settingUp {
			desc = "Adding it didn't finish: remove it, or update it to try again."
		}
		p.list.opts = append(p.list.opts, option{value: "p:" + sp.ID, title: sp.Name, desc: desc})
	}
	if len(p.files) > 0 {
		o := option{value: "add", title: "Add a plugin", desc: count(len(p.files), "plugin file") + " in " + tildePath(pluginsDir()) + "."}
		if !p.running {
			o.why = "Start the server first."
		}
		p.list.opts = append(p.list.opts, o)
	}
	p.list.usable()
}

func (p *pluginsScreen) toOne(sp savedPlugin) {
	p.stage, p.cur, p.err, p.show = plOne, sp, nil, false
	f, ok := p.fileFor(sp.ID)
	update := option{value: "update", title: "Update", desc: "Get the newest image its file names."}
	switch {
	case !p.running:
		update.why = "Start the server first."
	case !ok:
		update.why = "Its plugin file isn't in " + tildePath(pluginsDir()) + " any more."
	case f.Err != "":
		update.why = "Its plugin file " + f.Err + "."
	}
	p.list = choices{opts: []option{
		{value: "show", title: "Show address", desc: "The one to paste in Nightcap."},
		update,
		{value: "remove", title: "Remove", desc: "Stop it and delete it. Its settings go too."},
	}}
	p.list.usable()
}

func (p pluginsScreen) fileFor(id string) (pluginFile, bool) {
	i := slices.IndexFunc(p.files, func(f pluginFile) bool { return f.ID == id })
	if i < 0 {
		return pluginFile{}, false
	}
	return p.files[i], true
}

func (p *pluginsScreen) toPick() {
	p.stage, p.list = plPick, choices{}
	for _, f := range p.files {
		o := option{value: f.ID, title: f.Name, desc: f.Image}
		switch {
		case f.Err != "":
			o.why = "Its file " + f.Err + "."
		case slices.ContainsFunc(p.s.Plugins, func(sp savedPlugin) bool { return sp.ID == f.ID }):
			o.why = "Already added."
		case p.s.Where == "cloudrun" && !strings.HasPrefix(f.Image, "docker.io/"):
			o.why = "On Google Cloud, its image must be on Docker Hub (docker.io/…)."
		}
		p.list.opts = append(p.list.opts, o)
	}
	p.list.usable()
}

// startAsking: the settings to ask (adding: all but the ones the tool makes; updating: only new
// ones it needs), the made ones made.
func (p *pluginsScreen) startAsking(f pluginFile, values map[string]string) tea.Cmd {
	p.file, p.values, p.asks, p.ask = f, values, nil, 0
	for _, st := range f.Settings {
		_, have := values[st.Name]
		switch {
		case st.Made && !have:
			values[st.Name] = randomToken()
		case !st.Made && !have && (p.op.what == "add" || !st.Optional):
			p.asks = append(p.asks, st)
		}
	}
	if len(p.asks) == 0 {
		return p.run()
	}
	p.toAsk()
	return nil
}

func (p *pluginsScreen) toAsk() {
	st := p.asks[p.ask]
	p.stage = plAsk
	placeholder := "type it here"
	if st.Optional {
		placeholder = "or leave it empty"
	}
	p.field = newText(st.Name, "", p.values[st.Name], placeholder, st.Secret)
	p.field.input.Focus()
	p.field.input.CursorEnd()
}

// run starts the steps.
func (p *pluginsScreen) run() tea.Cmd {
	p.stage, p.err, p.ended = plRun, nil, false
	p.steps = nil
	for _, t := range p.op.steps() {
		p.steps = append(p.steps, deployStep{title: t})
	}
	p.out = make(chan pluginMsg, 16)
	op, out := p.op, p.out
	go func() {
		n := 0
		ok := op.run(func(title string, fn func() (string, error)) bool {
			i := n
			n++
			snap := func() savedServer { c := op.s; c.Plugins = slices.Clone(op.s.Plugins); return c }
			out <- pluginMsg{s: snap(), step: i, state: running}
			note, err := fn()
			if err != nil {
				out <- pluginMsg{s: snap(), step: i, state: failed, err: err}
				return false
			}
			out <- pluginMsg{s: snap(), step: i, state: done, note: note}
			return true
		})
		c := op.s
		c.Plugins = slices.Clone(op.s.Plugins)
		out <- pluginMsg{s: c, step: -1, end: ok, p: op.p}
	}()
	return p.listen()
}

func (p pluginsScreen) listen() tea.Cmd {
	out := p.out
	return func() tea.Msg { return <-out }
}

// update handles a key or a step's news; leave says Esc went back past the list.
func (p *pluginsScreen) update(msg tea.Msg) (cmd tea.Cmd, leave bool) {
	switch msg := msg.(type) {
	case pluginMsg:
		if msg.step >= 0 && msg.step < len(p.steps) {
			p.steps[msg.step].state, p.steps[msg.step].note = msg.state, msg.note
			if msg.err != nil {
				p.err = msg.err
			}
		}
		if msg.s.Dir != "" {
			p.s = msg.s // (its plugins, as saved: the op's copy, not its live entry)
		}
		if msg.step < 0 {
			p.ended = true
			switch {
			case !msg.end:
				p.list = choices{opts: []option{{value: "again", title: "Try again"}, {value: "back", title: "Go back"}}}
			case p.op.what == "remove":
				p.toList(p.cur.Name + " was removed.")
			default:
				p.cur = msg.p
				p.stage, p.show = plDone, true
				p.list = choices{opts: []option{{value: "back", title: "Back to plugins"}}}
			}
			return nil, false
		}
		return p.listen(), false
	case tea.KeyMsg:
		return p.key(msg)
	}
	return nil, false
}

func (p *pluginsScreen) key(msg tea.KeyMsg) (tea.Cmd, bool) {
	k := msg.String()
	if p.stage == plAsk {
		switch k {
		case "esc":
			if p.ask > 0 {
				p.ask--
				p.toAsk()
			} else if p.op.what == "add" {
				p.toPick()
			} else {
				p.toOne(p.cur)
			}
			return nil, false
		case "enter":
			st, v := p.asks[p.ask], p.field.value()
			if v == "" && !st.Optional {
				p.field.status, p.field.statusKind = "It's needed.", -1
				return nil, false
			}
			p.values[st.Name] = v
			if p.ask++; p.ask < len(p.asks) {
				p.toAsk()
				return nil, false
			}
			return p.run(), false
		}
		var cmd tea.Cmd
		p.field.input, cmd = p.field.input.Update(msg)
		p.field.status = ""
		return cmd, false
	}
	if p.stage == plRun && !p.ended {
		return nil, false // (not while it's working, nor before its end has come)
	}
	switch k {
	case "up", "k":
		p.list.move(-1)
	case "down", "j", "tab":
		p.list.move(1)
	case "esc":
		switch p.stage {
		case plList:
			return nil, true
		case plConfirm:
			p.toOne(p.cur)
		default:
			p.toList("")
		}
	case "enter":
		o, ok := p.list.chosen()
		if !ok {
			return nil, false
		}
		return p.choose(o.value), false
	}
	return nil, false
}

func (p *pluginsScreen) choose(v string) tea.Cmd {
	switch {
	case strings.HasPrefix(v, "p:"):
		i := slices.IndexFunc(p.s.Plugins, func(sp savedPlugin) bool { return "p:"+sp.ID == v })
		if i >= 0 {
			p.toOne(p.s.Plugins[i])
		}
	case v == "add":
		p.toPick()
	case v == "show":
		p.show = !p.show
	case v == "update":
		f, _ := p.fileFor(p.cur.ID)
		values, _, err := readPluginEnv(p.s.Dir, p.cur.ID)
		if err != nil {
			values = map[string]string{}
		}
		p.op = &pluginOp{what: "update", s: p.s, f: f, p: p.cur, values: values}
		return p.startAsking(f, values)
	case v == "remove":
		p.stage = plConfirm
		p.list = choices{opts: []option{{value: "really", title: "Remove " + p.cur.Name}, {value: "keep", title: "Keep it"}}}
	case v == "really":
		p.op = &pluginOp{what: "remove", s: p.s, p: p.cur}
		return p.run()
	case v == "keep":
		p.toOne(p.cur)
	case v == "again":
		return p.run()
	case v == "back":
		p.toList("")
	case p.stage == plPick:
		f, _ := p.fileFor(v)
		values := map[string]string{}
		p.op = &pluginOp{what: "add", s: p.s, f: f, values: values}
		return p.startAsking(f, values)
	}
	return nil
}

// address is the plugin's add-on address, its values in it ("" if they can't be read).
func (p pluginsScreen) address(sp savedPlugin) string {
	values, _, err := readPluginEnv(p.s.Dir, sp.ID)
	if err != nil || sp.Address == "" {
		return ""
	}
	return fill(sp.Address, values)
}

func (p pluginsScreen) View(width int) string {
	var b strings.Builder
	wrapped := func(s string, style lipgloss.Style) string {
		return style.Width(max(width-2, 20)).Render(s)
	}
	switch p.stage {
	case plList:
		b.WriteString(heading("Plugins on "+p.s.Name, "They run next to it and add to what it finds."))
		if len(p.list.opts) == 0 {
			b.WriteString(muted.Render("  No plugins yet, and no plugin files in " + tildePath(pluginsDir()) + "."))
		} else {
			b.WriteString(p.list.view(width))
		}
		if p.note != "" {
			b.WriteString("\n\n" + note(width, good.Render("✓ "), p.note))
		}
	case plOne:
		b.WriteString(heading(p.cur.Name, p.cur.Image))
		if p.show {
			if a := p.address(p.cur); a != "" {
				b.WriteString("  " + wrapped(a, accent) + "\n\n")
			} else {
				b.WriteString(note(width, bad.Render("✗ "), "It has no address yet: adding it didn't finish. Update it to try again.") + "\n\n")
			}
		}
		b.WriteString(p.list.view(width))
	case plPick:
		b.WriteString(heading("Which plugin?", "From the plugin files in "+tildePath(pluginsDir())+"."))
		b.WriteString(p.list.view(width))
	case plAsk:
		st := p.asks[p.ask]
		sub := fmt.Sprintf("%s: %d of %d.", p.file.Name, p.ask+1, len(p.asks))
		if st.Optional {
			sub += " Leave it empty to skip."
		}
		b.WriteString(heading(st.Ask, sub))
		b.WriteString(p.field.alone(width))
	case plRun:
		title := map[string]string{"add": "Adding ", "update": "Updating ", "remove": "Removing "}[p.op.what] + p.op.f.Name
		if p.op.what == "remove" {
			title = "Removing " + p.cur.Name
		}
		b.WriteString(heading(title, ""))
		for _, st := range p.steps {
			mark := muted.Render("·")
			switch st.state {
			case running:
				mark = p.spin
			case done:
				mark = good.Render("✓")
			case failed:
				mark = bad.Render("✗")
			}
			line := "  " + mark + " " + plain.Render(st.title)
			if st.note != "" && st.state == done {
				line += muted.Render("  " + st.note)
			}
			b.WriteString(line + "\n")
		}
		if p.err != nil {
			b.WriteString("\n" + note(width, bad.Render("✗ "), p.err.Error()) + "\n\n" + p.list.view(width))
		}
	case plDone:
		title, sub := p.cur.Name+" is running", "Paste this address in Nightcap's web app, as the household's admin: Settings, Extra add-ons."
		if p.op.what == "update" {
			title, sub = p.cur.Name+" is up to date", "Its address, the same unless its file changed it:"
		}
		b.WriteString(heading(title, sub))
		b.WriteString("  " + wrapped(p.address(p.cur), accent) + "\n\n")
		b.WriteString(muted.Render("  To see it again: Plugins, "+p.cur.Name+", Show address.") + "\n\n")
		b.WriteString(p.list.view(width))
	case plConfirm:
		b.WriteString(heading("Remove "+p.cur.Name+"?", "It stops, and its settings are deleted. Take its address out of Nightcap too."))
		b.WriteString(p.list.view(width))
	}
	return b.String()
}

func (p pluginsScreen) keys() []key {
	switch {
	case p.stage == plAsk:
		return []key{{"enter", "next"}, {"esc", "back"}}
	case p.stage == plRun && !p.ended:
		return []key{{"ctrl+c", "quit"}}
	}
	return []key{{"↑↓", "move"}, {"enter", "choose"}, {"esc", "back"}}
}
