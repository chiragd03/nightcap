package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/lipgloss"
)

// Review (everything chosen, and where its files go), then setting it up step by step with a
// live log, then what to do next.

// reviewView is everything chosen, in groups, a fact a row: a long value wraps in its own column.
func reviewView(p plan, d *deployer, width int, c choices) string {
	var b strings.Builder
	b.WriteString(heading("All set?", "Check it over. Nothing is made until you say so."))
	const labelW = 16
	row := func(label, value string) {
		lines := strings.Split(lipgloss.NewStyle().Width(max(width-labelW-2, 20)).Render(value), "\n")
		b.WriteString("  " + muted.Render(pad(label, labelW)) + lines[0] + "\n")
		for _, l := range lines[1:] {
			b.WriteString(strings.Repeat(" ", labelW+2) + l + "\n")
		}
	}
	group := func(title string) { b.WriteString(bold.Render(title) + "\n") }

	st := p.settings
	group("Server")
	row("Name", plain.Render(st.name))
	row("Watched", plain.Render(map[string]string{"home": "Just at home", "cloud": "Anywhere, with invite codes"}[p.mode]))
	row("Country", plain.Render(countryName(st.country)))
	row("Time zone", plain.Render(st.timezone))
	switch {
	case p.where == "cloudrun":
		row("Address", plain.Render("Google's, once it's made"))
	case st.address != "":
		row("Address", plain.Render(st.address))
	}

	b.WriteString("\n")
	switch p.where {
	case "cloudrun":
		c := p.cloud
		group("Google Cloud")
		row("Account", plain.Render(c.account))
		proj := plain.Render(c.project)
		if c.newProject {
			proj += muted.Render("  (new)")
		} else {
			proj += muted.Render("  (yours, used as it is)")
		}
		row("Project", proj)
		if c.billingName != "" || c.billing != "" {
			row("Billing", plain.Render(orDefault(c.billingName, c.billing)))
		}
		row("Region", plain.Render(regionName(c.region))+muted.Render("  "+c.region))
		row("Cost", plain.Render(costWords(c.region))+muted.Render("  It only runs while someone watches."))
	case "kubernetes":
		group("Kubernetes")
		row("Cluster", plain.Render(p.kube.context))
		ns := plain.Render(p.kube.namespace)
		if p.kube.newNamespace {
			ns += muted.Render("  (new)")
		}
		row("Namespace", ns)
	default:
		group("Runs on")
		row("Where", plain.Render(whereNames[p.where]))
	}

	b.WriteString("\n")
	group("Database and keys")
	switch {
	case p.db.docker != nil:
		row("Database", plain.Render("made for you")+muted.Render("  "+p.db.where))
	case p.db.where != "":
		row("Database", plain.Render(p.db.where)+good.Render("  ✓ connected"))
	}
	row("TMDB key", good.Render("✓ works"))
	if p.keys.ownAIO {
		row("Stream finder", plain.Render("included"))
	} else {
		row("Stream finder", plain.Render("none")+muted.Render("  (households add their own)"))
	}

	b.WriteString("\n")
	row("Image", muted.Render(d.b.image))
	row("Files", muted.Render(tildePath(d.dir)))
	b.WriteString("\n")
	if p.where == "files" {
		b.WriteString(note(width, muted.Render("• "), "Nothing starts here. You'll copy the folder to the other machine.") + "\n\n")
	} else if p.mode == "home" && !d.b.hostNet {
		b.WriteString(note(width, accent.Render("⚠ "), "On Docker Desktop, TVs can't find it by themselves. You'll type its address on each TV once.") + "\n\n")
	}
	b.WriteString(c.view(width))
	return b.String()
}

func reviewChoices(p plan) choices {
	go_ := "Set it up"
	if p.where == "files" {
		go_ = "Write the files"
	}
	return choices{opts: []option{{value: "go", title: go_}, {value: "back", title: "Change something"}}}
}

type deployScreen struct {
	d       *deployer
	steps   []deployStep
	log     []string
	spin    spinner.Model
	err     error
	at      int // the step running (or that failed)
	done    bool
	saveErr error   // set up, but not saved in the list
	failed  choices // after a failure: try again, or go back
}

func failChoices() choices {
	return choices{opts: []option{
		{value: "again", title: "Try again", desc: "From the step that failed."},
		{value: "back", title: "Go back", desc: "Change something first."},
	}}
}

func newDeployScreen(p plan) deployScreen { return deployScreenFor(newDeployer(p)) }

func deployScreenFor(d *deployer) deployScreen {
	return deployScreen{d: d, steps: d.steps(), spin: spinner.New(spinner.WithSpinner(spinner.MiniDot), spinner.WithStyle(accent))}
}

func (s *deployScreen) apply(m deployMsg) {
	if m.line != "" {
		s.log = append(s.log, m.line)
		if len(s.log) > 200 {
			s.log = s.log[len(s.log)-200:]
		}
	}
	if m.end {
		s.done = true
		return
	}
	if m.step >= 0 && m.step < len(s.steps) {
		if m.state == running && s.steps[m.step].state != running {
			s.steps[m.step].began = time.Now()
		}
		s.steps[m.step].state = m.state
		if m.note != "" {
			s.steps[m.step].note = m.note
		}
		s.at = m.step
		if m.state == failed {
			s.err, s.failed = m.err, failChoices()
			if s.d != nil && s.d.cloud && s.d.b.slug != "" {
				s.failed.opts = append(s.failed.opts[:1], append([]option{{value: "glogs", title: "Open its log in Google's console", desc: "What Google saw, in your browser."}}, s.failed.opts[1:]...)...)
			}
		}
	}
}

func (s deployScreen) View(width int) string {
	var b strings.Builder
	sub := "A few minutes. You can watch below."
	switch {
	case s.err != nil:
		sub = "Something went wrong. The details are below."
	case s.done:
		sub = "Done."
	}
	b.WriteString(heading(s.d.title(), sub))
	finished := 0
	for _, st := range s.steps {
		mark := muted.Render("○")
		name := muted.Render(pad(st.title, 26))
		switch st.state {
		case running:
			mark, name = s.spin.View(), plain.Render(pad(st.title, 26))
			if el := time.Since(st.began); !st.began.IsZero() && el > 5*time.Second {
				st.note = fmt.Sprintf("%d:%02d", int(el.Minutes()), int(el.Seconds())%60)
				if el > time.Minute {
					st.note += " · a first start can take a few minutes"
				}
			}
		case done:
			mark, name = good.Render("✓"), plain.Render(pad(st.title, 26))
			finished++
		case failed:
			mark, name = bad.Render("✗"), bold.Render(pad(st.title, 26))
		}
		b.WriteString("  " + mark + "  " + name + muted.Render(st.note) + "\n")
	}
	// Progress, in gold.
	barW := min(width-10, 60)
	fill := barW * finished / max(len(s.steps), 1)
	b.WriteString("\n  " + accent.Render(strings.Repeat("━", fill)) + frameLine.Render(strings.Repeat("─", barW-fill)) +
		muted.Render(fmt.Sprintf("  %d%%", 100*finished/max(len(s.steps), 1))) + "\n\n")
	if s.err != nil {
		b.WriteString(note(width, bad.Render("✗ "), s.err.Error()) + "\n\n")
		b.WriteString(s.failed.view(width) + "\n\n")
	}
	if s.saveErr != nil {
		b.WriteString(note(width, accent.Render("⚠ "), "It's set up, but couldn't be added to the list of servers: "+s.saveErr.Error()) + "\n\n")
	}
	// What the commands are saying, as a line under the bar while it runs (all of it is in setup.log).
	if s.err == nil && !s.done && len(s.log) > 0 {
		l := []rune(s.log[len(s.log)-1])
		if len(l) > width-4 {
			l = append(l[:width-5], '…')
		}
		b.WriteString(muted.Render("  "+string(l)) + "\n")
	}
	if s.err != nil {
		b.WriteString(note(width, "  ", "Everything it did: "+tildePath(filepath.Join(s.d.dir, "setup.log"))) + "\n")
	}
	return b.String()
}

func (s deployScreen) keys() []key {
	switch {
	case s.err != nil:
		return []key{{"↑↓", "choose"}, {"enter", "select"}, {"esc", "back"}, {"q", "quit"}}
	case s.done:
		return []key{{"enter", "continue"}}
	}
	return []key{{"ctrl+c", "stop"}}
}

func doneView(p plan, d *deployer, width int, next choices) string {
	var b strings.Builder
	local := fmt.Sprintf("http://localhost:%d", serverPortN)
	addr, open := local, local // (its address, and where to open it from this computer)
	switch {
	case d.cloud:
		addr, open = d.cloudURL, d.cloudURL
	case d.kube && p.kube.nodeIP != "":
		addr = fmt.Sprintf("http://%s:%d", p.kube.nodeIP, nodePort)
		open = addr
	case d.kube:
		addr = fmt.Sprintf("a node's address, port %d", nodePort)
		open = fmt.Sprintf("http://<a node's address>:%d", nodePort)
	case p.settings.address != "":
		addr = p.settings.address
		if !d.here {
			open = addr
		}
	}
	title, sub := "Nightcap is running", "Two things left, and you're watching."
	if !d.here {
		title, sub = "The files are ready", "Three steps on the other machine."
	}
	// One centred column: the key, the steps, where it is. Long addresses wrap inside it.
	colW := min(width, 72)
	wrap := func(s string, indent int, style func(...string) string) string {
		lines := strings.Split(lipgloss.NewStyle().Width(colW-indent).Render(s), "\n")
		for i, l := range lines {
			lines[i] = strings.Repeat(" ", indent) + style(l)
		}
		return strings.Join(lines, "\n")
	}
	keyFile := "nightcap.env"
	if d.kube {
		keyFile = "secret.yaml"
	}
	var col strings.Builder
	key := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(gold).Padding(0, 2).Width(colW - 2).Render(
		muted.Render("Owner key") + "\n" + accentB.Render(p.keys.ownerKey) + "\n" +
			muted.Render("Your admin password. Save it now (it's also in "+keyFile+")."))
	col.WriteString(key + "\n\n")
	step := func(n int, what, link, detail string) {
		col.WriteString(accentB.Render(itoa(n)) + "  " + plain.Render(what) + "\n")
		if link != "" {
			col.WriteString(wrap(link, 3, accent.Render) + "\n")
		}
		if detail != "" {
			col.WriteString(wrap(detail, 3, muted.Render) + "\n")
		}
		col.WriteString("\n")
	}
	// How TVs join: by invite code (for people anywhere), by typing its address (Docker Desktop can't
	// let TVs find it), or by picking it (found on the Wi-Fi).
	tvs, tvsDetail := "On each TV, install Nightcap and pick this server.", "TVs on your Wi-Fi find it by themselves."
	switch {
	case p.mode == "cloud":
		tvs, tvsDetail = "On the owner page, make an invite for each TV or phone.", "Each one joins with its code."
	case d.here && !d.kube && !d.b.hostNet:
		tvs, tvsDetail = "On each TV, install Nightcap and type its address:", addr
	}
	if !d.here {
		if open == fmt.Sprintf("http://localhost:%d", serverPortN) { // (no address given: that machine's)
			open = fmt.Sprintf("http://<that machine's address>:%d", serverPortN)
		}
		step(1, "Copy the folder to the machine Nightcap runs on.", "", tildePath(d.dir))
		step(2, "Start it there, in the folder:", "docker compose up -d", "")
		step(3, "Open the owner page:", open+"/app/server", "Sign in with the owner key and add your household.")
		step(4, tvs, "", tvsDetail)
	} else {
		step(1, "Open the owner page:", open+"/app/server", "Sign in with the owner key and add your household.")
		step(2, tvs, "", tvsDetail)
		col.WriteString(muted.Render("Address") + "\n" + wrap(addr, 3, plain.Render) + "\n")
		col.WriteString(muted.Render("Files") + "\n" + wrap(tildePath(d.dir), 3, muted.Render))
	}

	b.WriteString(center(width, good.Render("✦  ")+bold.Render(title)+good.Render("  ✦")) + "\n")
	b.WriteString(center(width, muted.Render(sub)) + "\n\n")
	if len(next.opts) > 0 {
		col.WriteString("\n\n" + next.view(colW))
	}
	b.WriteString(center(width, lipgloss.NewStyle().Width(colW).Render(strings.TrimRight(col.String(), "\n"))))
	return b.String()
}

// doneChoices are what's next on Done: this server's own screen (when it's on the list), or quit.
func doneChoices(d *deployer) choices {
	c := choices{}
	if d != nil && d.here && d.update == "" {
		c.opts = append(c.opts, option{value: "manage", title: "Manage this server", desc: "Its status, logs, updates."})
	}
	return choices{opts: append(c.opts, option{value: "quit", title: "Quit"})}
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
