package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// One server, chosen under Manage: its status (looked at as the screen opens, then again every
// few seconds while it's open, and with r), then what can be done with it. Its logs, when shown,
// follow along. One this computer runs: its logs, an update, stop or start. One
// run elsewhere: only whether its address answers, and where its files are.

type statusMsg struct {
	dir   string
	st    serverStatus
	quiet bool // a look of its own accord (not asked for)
}

// liveTick is time for the next look (or the logs' next lines); one of an older round is let go.
type liveTick struct {
	dir string
	gen int
}

const (
	lookEvery = 5 * time.Second
	logsEvery = 3 * time.Second
)

type actionDone struct {
	what string
	err  error
}

type logsMsg struct {
	text   string
	err    error
	follow bool // the next lines of logs already shown
}

type serverScreen struct {
	s        savedServer
	st       *serverStatus
	loading  bool
	spin     spinner.Model
	actions  choices
	busy     string // an action under way ("Stopping…")
	note     string // what the last action did
	noteBad  bool
	logs     bool // showing the logs
	view     viewport.Model
	logsText string
	errsOnly bool            // the logs: errors and warnings only
	search   string          // the logs: lines with this only
	finding  bool            // typing a search
	find     textinput.Model // what's typed
	gen      int             // the round of looks under way
	quiet    bool            // a look of its own accord, under way
	x        extras          // a full look's extras: who's using it, versions, cost or use
	xDone    bool
	showKey  bool      // the owner key on screen
	lookedAt time.Time // when it was last looked at
}

func newServerScreen(s savedServer) (serverScreen, tea.Cmd) {
	sc := serverScreen{s: s, loading: true, spin: spinner.New(spinner.WithSpinner(spinner.MiniDot), spinner.WithStyle(accent))}
	sc.setActions()
	return sc, tea.Batch(sc.spin.Tick, sc.lookCmd())
}

func (sc serverScreen) lookCmd() tea.Cmd {
	s := sc.s
	return tea.Batch(func() tea.Msg { return statusMsg{s.Dir, statusOf(s, true), false} },
		func() tea.Msg { return extrasOf(s) })
}

// every is how often it's looked at: less often on Google Cloud, where a look is a request to
// Google (and asking whether it answers can start a copy of it).
func (sc serverScreen) every(d time.Duration) time.Duration {
	if sc.s.Where == "cloudrun" {
		return 6 * d
	}
	return d
}

// next is the next look, after [d] (any looks already waiting are let go).
func (sc *serverScreen) next(d time.Duration) tea.Cmd {
	sc.gen++
	t := liveTick{sc.s.Dir, sc.gen}
	return tea.Tick(d, func(time.Time) tea.Msg { return t })
}

// logsCmd gets the server's last lines of logs, its keys taken out.
func (sc serverScreen) logsCmd(follow bool) tea.Cmd {
	s := sc.s
	secrets := serverSecrets(s.Dir)
	return func() tea.Msg {
		var out string
		var err error
		switch s.Where {
		case "kubernetes":
			out, err = kubectlQuick(s.Context, "logs", "-n", s.Namespace, "deploy/"+s.Slug+"-server", "-c", "server", "--tail", "300")
		case "cloudrun":
			out, err = gcloudQuick("run", "services", "logs", "read", s.Slug, "--region="+s.Region, "--project="+s.Project, "--limit=300", as(s.Account))
		default:
			out, err = composeOut(s.Dir, "logs", "--no-color", "--tail", "300", "server")
		}
		for _, x := range secrets {
			if len(x) >= 4 {
				out = strings.ReplaceAll(out, x, "•••")
			}
		}
		return logsMsg{plainText(scrub2(out)), err, follow}
	}
}

func (sc *serverScreen) running() bool {
	if sc.st == nil {
		return false
	}
	for _, p := range sc.st.parts {
		if p.name == "server" {
			return p.state == "running"
		}
	}
	return false
}

func (sc *serverScreen) setActions() {
	cursor := sc.actions.cursor
	defer func() { sc.actions.cursor = min(cursor, len(sc.actions.opts)-1) }()
	if sc.s.Status == settingUp { // (its setup didn't finish: take it away, or just off the list)
		sc.actions = choices{opts: []option{
			{value: "remove", title: "Remove", desc: "Delete what its setup made."},
			{value: "forget", title: "Forget", desc: "Take it off the list. Nothing is deleted."},
		}}
		return
	}
	if sc.s.Where != "docker" && sc.s.Where != "kubernetes" && sc.s.Where != "cloudrun" {
		sc.actions = choices{opts: []option{{value: "refresh", title: "Check again", desc: "Is it reachable?"},
			{value: "remove", title: "Remove", desc: "Forget it here. The other machine isn't touched."}}}
		return
	}
	key := option{value: "key", title: "Show owner key", desc: "Your admin password, for the owner page."}
	if sc.showKey {
		key = option{value: "key", title: "Hide owner key", desc: "Take it off the screen."}
	}
	opts := []option{
		{value: "open", title: "Open owner page", desc: "In your browser: households, invites."},
		key,
		{value: "logs", title: "Logs", desc: "What it's been doing, live."},
		{value: "update", title: "Update", desc: "Get the newest version. Nothing is lost."},
		{value: "restart", title: "Restart", desc: "Turn it off and on again."},
	}
	plugins := []option{}
	var states map[string]string
	if sc.st != nil {
		states = sc.st.plugins
	}
	if title, desc := pluginsLine(sc.s, states); title != "" {
		plugins = append(plugins, option{value: "plugins", title: title, desc: desc})
	}
	if sc.st != nil && sc.s.Where != "cloudrun" && !sc.running() {
		// Stopped: start it (opening its page, restarting or updating it wait for that).
		sc.actions = choices{opts: append(append([]option{
			{value: "start", title: "Start", desc: "Bring it back."},
			{value: "logs", title: "Logs", desc: "What it was doing."},
			key,
		}, plugins...), option{value: "remove", title: "Remove", desc: "Delete it and its data, for good."})}
		return
	}
	opts = append(opts, plugins...)
	switch {
	case sc.s.Where == "cloudrun":
		// (No Stop: it already runs only while someone's watching.)
		opts = append(opts, option{value: "remove", title: "Remove", desc: "Delete it from Google Cloud, for good."})
		sc.actions = choices{opts: opts}
		return
	case sc.running():
		opts = append(opts, option{value: "stop", title: "Stop", desc: "Pause it. Your data stays."})
	default:
		opts = append(opts, option{value: "start", title: "Start", desc: "Bring it back."})
	}
	opts = append(opts, option{value: "remove", title: "Remove", desc: "Delete it and its data, for good."})
	sc.actions = choices{opts: opts}
}

// act starts the chosen action ("update" is handled by the app: it has a screen of its own).
func (sc *serverScreen) act(what string) tea.Cmd {
	dir := sc.s.Dir
	switch what {
	case "refresh":
		sc.loading, sc.note, sc.xDone = true, "", false
		return tea.Batch(sc.spin.Tick, sc.lookCmd())
	case "logs":
		sc.busy = "Getting the logs…"
		return tea.Batch(sc.spin.Tick, sc.logsCmd(false))
	case "open":
		addr := sc.s.Address
		if sc.s.Where == "docker" {
			addr = localAddress()
		}
		page := strings.TrimRight(addr, "/") + "/app/server"
		openURL(page)
		sc.note, sc.noteBad = "Opened in your browser: "+page, false
		return nil
	case "key":
		sc.showKey = !sc.showKey
		sc.setActions()
		return nil
	case "restart":
		sc.busy = "Restarting " + sc.s.Name + "…"
		s := sc.s
		return tea.Batch(sc.spin.Tick, func() tea.Msg { return actionDone{"restart", restartServer(s)} })
	case "stop", "start":
		word := map[string]string{"stop": "Stopping", "start": "Starting"}[what]
		sc.busy = word + " " + sc.s.Name + "…"
		args := map[string][]string{"stop": {"stop"}, "start": {"up", "-d"}}[what]
		s := sc.s
		return tea.Batch(sc.spin.Tick, func() tea.Msg {
			var err error
			if s.Where == "kubernetes" {
				// (Its parts scaled to none, or one: their volumes stay.)
				n := map[string]string{"stop": "0", "start": "1"}[what]
				sel := kubeSelector(s.Slug)
				_, err = kubectlQuick(s.Context, "scale", "-n", s.Namespace, "deployment,statefulset", "-l", sel, "--replicas="+n)
				if err == nil && what == "stop" { // (until its pods are gone, so it reads as stopped)
					ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
					kubectl(ctx, s.Context, "wait", "-n", s.Namespace, "--for=delete", "pod", "-l", sel, "--timeout=60s")
					cancel()
				}
			} else {
				_, err = composeLong(dir, args...)
			}
			return actionDone{what, err}
		})
	}
	return nil
}

// scrub2 takes passwords out of connection strings in a log (one the env files didn't name).
func scrub2(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		if j := strings.Index(l, "://"); j >= 0 {
			if at := strings.Index(l[j:], "@"); at > 0 {
				userinfo := l[j+3 : j+at]
				if u, _, ok := strings.Cut(userinfo, ":"); ok {
					lines[i] = l[:j+3] + u + ":•••" + l[j+at:]
				}
			}
		}
	}
	return strings.Join(lines, "\n")
}

func (sc *serverScreen) update(msg tea.Msg, width, height int) tea.Cmd {
	switch msg := msg.(type) {
	case statusMsg:
		if msg.dir == sc.s.Dir {
			if msg.quiet && sc.st != nil {
				msg.st.newer = sc.st.newer // (a quiet look doesn't ask the registry)
				if msg.st.notAsked {       // (nor wake a Google Cloud server: what it last said stands)
					msg.st.answers, msg.st.answerErr, msg.st.name, msg.st.mode, msg.st.households = sc.st.answers, sc.st.answerErr, sc.st.name, sc.st.mode, sc.st.households
				}
			}
			if sc.xDone {
				msg.st.take(sc.x) // (the last full look's extras, until the next)
			}
			sc.st, sc.loading, sc.quiet, sc.lookedAt = &msg.st, false, false, time.Now()
			sc.setActions()
			if sc.s.Where != "files" { // (one elsewhere is looked at when asked)
				return sc.next(sc.every(lookEvery))
			}
		}
	case extras:
		if msg.dir == sc.s.Dir {
			sc.x, sc.xDone = msg, true
			if sc.st != nil {
				sc.st.take(msg)
			}
		}
	case liveTick:
		if msg.dir != sc.s.Dir || msg.gen != sc.gen || sc.loading || sc.busy != "" || sc.quiet {
			return nil // (what's under way looks again when it's done)
		}
		sc.quiet = true
		if sc.logs {
			return sc.logsCmd(true)
		}
		s := sc.s
		return func() tea.Msg { return statusMsg{s.Dir, statusOf(s, false), true} }
	case actionDone:
		sc.busy = ""
		if msg.err != nil {
			sc.note, sc.noteBad = msg.err.Error(), true
		} else {
			sc.note, sc.noteBad = map[string]string{"stop": "Stopped.", "start": "Started.", "restart": "Restarted."}[msg.what], false
		}
		sc.loading = true
		return tea.Batch(sc.spin.Tick, sc.lookCmd())
	case logsMsg:
		if msg.follow {
			sc.quiet = false
			if sc.logs && msg.err == nil && msg.text != sc.logsText {
				bottom := sc.view.AtBottom()
				sc.logsText = msg.text
				sc.view.SetContent(sc.logLines())
				if bottom {
					sc.view.GotoBottom()
				}
			}
			return sc.next(sc.every(map[bool]time.Duration{true: logsEvery, false: lookEvery}[sc.logs]))
		}
		sc.busy = ""
		if msg.err != nil {
			sc.note, sc.noteBad = msg.err.Error(), true
			return nil
		}
		sc.logs, sc.logsText = true, msg.text
		sc.view = viewport.New(width-2, max(height-14, 6))
		sc.errsOnly, sc.search, sc.finding = false, "", false
		sc.view.SetContent(sc.logLines())
		sc.view.GotoBottom()
		return sc.next(sc.every(logsEvery))
	case spinner.TickMsg:
		if sc.loading || sc.busy != "" {
			var cmd tea.Cmd
			sc.spin, cmd = sc.spin.Update(msg)
			return cmd
		}
	case tea.KeyMsg:
		if sc.logs && sc.finding { // (typing a search: Enter keeps it, Esc drops it)
			switch msg.Type {
			case tea.KeyEnter:
				sc.finding, sc.search = false, strings.TrimSpace(sc.find.Value())
			case tea.KeyEsc:
				sc.finding = false
			default:
				var cmd tea.Cmd
				sc.find, cmd = sc.find.Update(msg)
				return cmd
			}
			sc.view.SetContent(sc.logLines())
			sc.view.GotoBottom()
			return nil
		}
		if sc.logs {
			switch msg.String() {
			case "esc", "q":
				if sc.search != "" || sc.errsOnly { // (a filter goes first, then the logs)
					sc.search, sc.errsOnly = "", false
					sc.view.SetContent(sc.logLines())
					sc.view.GotoBottom()
					return nil
				}
				sc.logs = false
				return nil
			case "e":
				sc.errsOnly = !sc.errsOnly
				sc.view.SetContent(sc.logLines())
				sc.view.GotoBottom()
				return nil
			case "/":
				sc.finding = true
				sc.find = textinput.New()
				sc.find.Prompt = ""
				sc.find.SetValue(sc.search)
				sc.find.CursorEnd()
				sc.find.Focus()
				return nil
			case "end", "G":
				sc.view.GotoBottom() // (following again)
				return nil
			case "home", "g":
				sc.view.GotoTop()
				return nil
			}
			var cmd tea.Cmd
			sc.view, cmd = sc.view.Update(msg)
			return cmd
		}
	}
	return nil
}

func (sc serverScreen) View(width int) string {
	s := sc.s
	var b strings.Builder
	where := map[string]string{"docker": "On this computer", "kubernetes": "On Kubernetes  ·  " + s.Context + "  ·  " + s.Namespace, "cloudrun": "On Google Cloud  ·  " + s.Project + "  ·  " + regionName(s.Region), "files": "On another machine"}[s.Where]
	b.WriteString(bold.Render(s.Name) + "   " + sc.overall() + "\n" + muted.Render(where) + "\n\n")
	if s.Status == settingUp {
		b.WriteString(note(width, accent.Render("◐ "), "Its setup didn't finish. Remove deletes what it made; Forget only takes it off this list.") + "\n\n")
	}
	if sc.logs {
		follow := good.Render("● live")
		if !sc.view.AtBottom() {
			follow = accent.Render("❚❚ paused") + muted.Render(" (End to follow)")
		}
		head := bold.Render("Logs") + "  " + follow + muted.Render("   ·   passwords hidden")
		switch {
		case sc.finding:
			head += "\n" + accent.Render("  Find: ") + sc.find.View()
		case sc.search != "" && sc.errsOnly:
			head += "\n" + accent.Render("  Errors with \""+sc.search+"\"") + muted.Render("  (Esc shows all)")
		case sc.search != "":
			head += "\n" + accent.Render("  Lines with \""+sc.search+"\"") + muted.Render("  (Esc shows all)")
		case sc.errsOnly:
			head += "\n" + bad.Render("  Errors and warnings only") + muted.Render("  (Esc shows all)")
		}
		b.WriteString(head + "\n\n")
		b.WriteString(sc.view.View())
		return b.String()
	}
	b.WriteString(detail(width, 12, 0, "Address", "", s.Address))
	b.WriteString(detail(width, 12, 0, "Files", "", tildePath(s.Dir)) + "\n")

	// What it's doing, and what can be done with it: side by side when there's room.
	wide := width >= 96
	statusW := width
	if wide {
		statusW = width * 3 / 5
	}
	left := sc.statusView(statusW)
	if sc.showKey {
		key := ownerKeyOf(s.Dir)
		if key == "" {
			key = "not in its folder"
		}
		left += "\n\n  " + muted.Render("Owner key  ") + accentB.Render(key)
	}
	if sc.busy != "" {
		left += "\n\n  " + sc.spin.View() + " " + plain.Render(sc.busy)
	} else if sc.note != "" {
		mark := good.Render("✓ ")
		if sc.noteBad {
			mark = bad.Render("✗ ")
		}
		left += "\n\n" + note(statusW, "  "+mark, sc.note)
	}
	if s.Where == "files" {
		left += "\n\n" + note(statusW, "", "It runs on another machine: see its logs and update it there.") + "\n" +
			note(statusW, "", "In its folder: docker compose logs -f server · docker compose pull && docker compose up -d")
	}
	if wide {
		actW := width - statusW - 4
		right := bold.Render("What to do") + "\n\n" + sc.actions.view(actW)
		b.WriteString(lipgloss.JoinHorizontal(lipgloss.Top,
			lipgloss.NewStyle().Width(statusW).Render(left), "    ", lipgloss.NewStyle().Width(actW).Render(right)))
		return b.String()
	}
	b.WriteString(left + "\n\n" + sc.actions.view(width))
	return b.String()
}

// overall is how it is, in a word or two.
func (sc serverScreen) overall() string {
	st := sc.st
	switch {
	case st == nil:
		return muted.Render("● checking…")
	case st.answers:
		return good.Render("● running")
	case sc.s.Where == "files":
		return bad.Render("● not reachable")
	}
	stopped, moving := true, false
	for _, p := range st.parts {
		if p.state == "running" || p.state == "stopping" {
			stopped = false
		}
		if p.state == "stopping" || p.health == "starting" {
			moving = true
		}
	}
	switch {
	case stopped:
		return bad.Render("● stopped")
	case moving:
		return accent.Render("● starting or stopping…")
	}
	return bad.Render("● having trouble")
}

// friendly is a part's state in plain words (Docker's and Kubernetes' own, dim, after).
func friendly(p part) string {
	switch {
	case p.state == "running" && (p.health == "healthy" || p.health == ""):
		return "OK"
	case p.state == "running" && p.health == "starting":
		return "starting…"
	case p.state == "running":
		return "having trouble" + muted.Render("  ("+p.health+")")
	case p.state == "stopping":
		return "stopping…"
	case p.state == "exited" || p.state == "created":
		return "stopped"
	}
	return "having trouble" + muted.Render("  ("+p.state+")")
}

// statusView is each of its parts, whether it answers, and whether it's the newest version.
func (sc serverScreen) statusView(width int) string {
	var b strings.Builder
	row := func(mark, name, state string) {
		lines := strings.Split(lipgloss.NewStyle().Width(max(width-20, 16)).Render(state), "\n")
		b.WriteString("  " + mark + "  " + plain.Render(pad(name, 15)) + lines[0] + "\n")
		for _, l := range lines[1:] {
			b.WriteString(strings.Repeat(" ", 20) + l + "\n")
		}
	}
	switch {
	case sc.loading && sc.st == nil:
		return "  " + sc.spin.View() + " " + plain.Render("Checking…")
	case sc.st == nil:
		return ""
	}
	st := sc.st
	if st.partsErr != "" {
		b.WriteString(note(width, bad.Render("  ✗ "), st.partsErr) + "\n")
	}
	for _, p := range st.parts {
		mark, state := good.Render("●"), friendly(p)
		switch {
		case p.state == "stopping":
			mark = accent.Render("●")
		case p.state != "running":
			mark = bad.Render("●")
		case p.health == "unhealthy":
			mark = bad.Render("●")
		case p.health == "starting":
			mark = accent.Render("●")
		}
		name := map[string]string{"db": "Database", "aiostreams": "Stream finder", "server": "Nightcap"}[p.name]
		if name == "" {
			name = p.name
		}
		row(mark, name, plain.Render(state))
	}
	if st.answers {
		hh := ""
		if st.households >= 0 {
			hh = muted.Render("  ·  " + count(st.households, "household"))
		}
		row(good.Render("✓"), "Reachable", plain.Render("yes")+hh)
	} else {
		why := ""
		if st.answerErr != "" {
			why = muted.Render("  ·  " + st.answerErr)
		}
		row(bad.Render("✗"), "Reachable", plain.Render("no")+why)
	}
	waiting := !sc.xDone
	// Who's using it, and its versions (the server's own owner API).
	switch o := st.owner; {
	case o != nil:
		row(good.Render("●"), "Using it", plain.Render(fmt.Sprintf("%s · %s · %s", count(o.households, "household"), count(o.profiles, "profile"), count(o.devices, "device"))))
	case st.ownerErr != "":
		row(muted.Render("○"), "Using it", muted.Render("couldn't ask: "+st.ownerErr))
	case waiting && st.answers:
		row(muted.Render("○"), "Using it", muted.Render("looking…"))
	}
	switch o := st.owner; {
	case o != nil && o.version != "" && o.update:
		row(accent.Render("↑"), "Version", accent.Render("Nightcap "+o.version+" · "+o.latest+" is out: Update"))
	case o != nil && o.version != "":
		row(good.Render("✓"), "Version", plain.Render("Nightcap "+o.version)+muted.Render(" · the newest"))
	case st.newer == "yes":
		row(accent.Render("↑"), "Version", accent.Render("a newer one is out: Update"))
	case st.newer == "no":
		row(good.Render("✓"), "Version", plain.Render("up to date"))
	}
	if o := st.owner; o != nil && o.hasAIO {
		switch {
		case o.aioVersion == "":
			row(muted.Render("○"), "Stream finder", muted.Render("not answering yet"))
		case o.aioOK:
			row(good.Render("✓"), "Stream finder", plain.Render("v"+o.aioVersion)+muted.Render(" · the tested one"))
		default:
			row(accent.Render("⚠"), "Stream finder", accent.Render("v"+o.aioVersion+" · not the tested v"+o.aioTested))
		}
	}
	// What it costs (Google Cloud) or uses (at home).
	switch {
	case st.cost != nil:
		c := st.cost
		row(good.Render("$"), "Cost", plain.Render(money(c.soFar)+" so far · ~"+money(c.month)+" this month")+
			muted.Render(fmt.Sprintf(" (CPU %.0f%% of free, %.1f GB out)", c.cpuPct, c.sentGiB*1.073741824)))
	case st.costErr != "":
		row(muted.Render("$"), "Cost", muted.Render("couldn't tell: "+st.costErr))
	case st.use != "":
		row(good.Render("●"), "Uses", plain.Render(st.use))
	case st.useErr != "":
		row(muted.Render("○"), "Uses", muted.Render("couldn't tell: "+st.useErr))
	case waiting && (sc.s.Where == "cloudrun"):
		row(muted.Render("$"), "Cost", muted.Render("asking Google…"))
	}
	// When it was checked: again every few seconds while this is open.
	live := muted.Render("checked")
	if sc.s.Where != "files" {
		live = muted.Render("live, checked")
	}
	if sc.loading || sc.quiet {
		live = muted.Render("checking…")
	} else if !sc.lookedAt.IsZero() {
		live += muted.Render(" " + sc.lookedAt.Format("15:04:05"))
	}
	b.WriteString("\n  " + live)
	return b.String()
}

func (sc serverScreen) keys() []key {
	if sc.logs {
		if sc.finding {
			return []key{{"enter", "find"}, {"esc", "cancel"}}
		}
		e := key{"e", "errors only"}
		if sc.errsOnly {
			e = key{"e", "show all"}
		}
		return []key{{"↑↓", "scroll"}, e, {"/", "find"}, {"end", "follow"}, {"esc", "back"}}
	}
	return []key{{"↑↓", "choose"}, {"enter", "select"}, {"r", "check again"}, {"esc", "back"}, {"q", "quit"}}
}

// restartServer stops a server and starts it again: its containers, its pods, or (on Google
// Cloud) a new copy of the same version.
func restartServer(s savedServer) error {
	switch s.Where {
	case "docker":
		_, err := composeLong(s.Dir, "restart")
		return err
	case "kubernetes":
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		sel := kubeSelector(s.Slug)
		if _, err := kubectl(ctx, s.Context, "-n", s.Namespace, "rollout", "restart", "deployment", "-l", sel); err != nil {
			return err
		}
		_, err := kubectl(ctx, s.Context, "-n", s.Namespace, "rollout", "status", "deployment/"+s.Slug+"-server", "--timeout=4m")
		return err
	case "cloudrun":
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		api, err := newRunAPI(ctx, s.Account, s.Project, s.Region)
		if err != nil {
			return err
		}
		svc, _, err := api.do(ctx, http.MethodGet, api.url(s.Slug), nil)
		if err != nil {
			return err
		}
		// (A new revision, the same in every way but when it was asked for.)
		delete(svc, "status")
		tm, _ := at(svc, "spec", "template", "metadata").(map[string]any)
		if tm == nil {
			return fmt.Errorf("Google's answer about it wasn't readable")
		}
		delete(tm, "name")
		ann, _ := tm["annotations"].(map[string]any)
		if ann == nil {
			ann = map[string]any{}
			tm["annotations"] = ann
		}
		ann["nightcap-setup/restarted"] = time.Now().UTC().Format(time.RFC3339)
		out, _, err := api.do(ctx, http.MethodPut, api.url(s.Slug), svc)
		if err != nil {
			return err
		}
		gen, _ := at(out, "metadata", "generation").(float64)
		for until := time.Now().Add(4 * time.Minute); time.Now().Before(until); time.Sleep(4 * time.Second) {
			svc, _, err := api.do(ctx, http.MethodGet, api.url(s.Slug), nil)
			if err != nil {
				continue
			}
			if g, _ := at(svc, "metadata", "generation").(float64); g >= gen {
				if ready, why := serviceReady(svc); ready {
					return nil
				} else if why != "" {
					return fmt.Errorf("%s", why)
				}
			}
		}
		return fmt.Errorf("it didn't come back in 4 minutes")
	}
	return nil
}

// logLines are the logs as shown: errors in red, warnings in gold, the rest dim; only errors, or
// only lines with what's searched for, when asked.
func (sc serverScreen) logLines() string {
	var out []string
	want := strings.ToLower(sc.search)
	for _, l := range strings.Split(strings.TrimRight(sc.logsText, "\n"), "\n") {
		low := strings.ToLower(l)
		isErr := strings.Contains(low, "error") || strings.Contains(low, "traceback") || strings.Contains(low, "exception") || strings.Contains(l, "✗")
		isWarn := strings.Contains(low, "warn")
		if sc.errsOnly && !isErr && !isWarn || want != "" && !strings.Contains(low, want) {
			continue
		}
		switch {
		case isErr:
			out = append(out, bad.Render(l))
		case isWarn:
			out = append(out, accent.Render(l))
		default:
			out = append(out, muted.Render(l))
		}
	}
	if len(out) == 0 {
		return muted.Render("Nothing here.")
	}
	return strings.Join(out, "\n")
}
