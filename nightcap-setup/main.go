// nightcap-setup sets up and manages Nightcap servers: where one runs (Docker, Kubernetes, Google
// Cloud Run), its database, its keys; then its status, updates, costs and backups. See SCREENS.md.
package main

import (
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type screen int

const (
	welcomeScreen screen = iota
	whereScreen
	audienceScreen
	databaseScreen
	connScreen
	dockerDBScreenID
	keysScreenID
	settingsScreenID
	reviewScreenID
	deployScreenID
	doneScreenID
	manageScreenID
	serverScreenID
	removeScreenID
	clusterScreenID
	cloudScreenID
	secretsKeyScreenID
	pluginsScreenID
)

// app is the whole program: the window's size, the screen showing, and what's been chosen.
type app struct {
	width, height int
	screen        screen
	back          []screen // where Esc goes
	welcome       welcome
	where         choices
	audience      choices
	database      choices
	conn          connField
	dockerDB      dockerDBScreen
	keys          keysScreen
	settings      settingsScreen
	review        choices
	reviewD       *deployer // the server's own name and folder, worked out once
	deploy        deployScreen
	servers       []savedServer
	serversErr    error
	manage        choices
	manageNote    string
	manageLines   map[string]string
	done          choices // Done's: manage this server, or quit
	whereMoved    bool    // the user moved on Where (the checks landing don't move it then)
	confirming    bool    // asking "Stop setting up?" before quitting
	confirm       choices // its choices
	secretsKey    string  // a database's existing secrets key ("" for a new one) // each server in a line, by folder, as it answers
	server        serverScreen
	remove        removeScreen
	cluster       clusterScreen
	cloud         cloudScreen
	secrets       secretsKeyScreen
	plugins       pluginsScreen
	plan          plan
}

func newApp() app {
	a := app{welcome: newWelcome(), audience: audienceChoices(0), conn: newConnField()}
	if list, err := loadServers(); err == nil {
		a.welcome.saved = len(list)
	}
	return a
}

func (a app) Init() tea.Cmd { return a.welcome.Init() }

func (a app) goTo(to screen) app {
	a.back = append(a.back, a.screen)
	a.screen = to
	return a
}

func (a app) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		a.width, a.height = msg.Width, msg.Height
		return a, nil
	case animTick:
		if a.screen != welcomeScreen {
			return a, nil // (it starts again on coming back)
		}
	case spinner.TickMsg:
		// The shared spinner (Welcome's, drawn on Google's and the cluster's waits too) keeps
		// turning whatever screen shows: no screen may swallow its ticks.
		if msg.ID == a.welcome.spin.ID() {
			var cmd tea.Cmd
			a.welcome, cmd = a.welcome.Update(msg)
			return a, cmd
		}
	case release:
		a.welcome, _ = a.welcome.Update(msg) // (whatever screen is showing)
		return a, nil
	case pluginMsg:
		cmd, _ := a.plugins.update(msg)
		a.server.s = a.plugins.s
		a.server.setActions()
		return a, cmd
	case checked:
		// The checks finish on their own time, whatever screen is showing.
		a.welcome, _ = a.welcome.Update(msg)
		cursor := a.where.cursor
		if !a.whereMoved {
			cursor = 0 // (the Recommended one, once it can be had)
		}
		a.where = whereChoices(a.welcome.tools, cursor)
		return a, nil
	case tea.KeyMsg:
		if a.confirming { // ("Stop setting up?": its own keys)
			switch msg.String() {
			case "ctrl+c":
				return a, tea.Quit // (twice: no question)
			case "up", "k":
				a.confirm.move(-1)
			case "down", "j", "tab":
				a.confirm.move(1)
			case "esc":
				a.confirming = false
			case "enter":
				if o, _ := a.confirm.chosen(); o.value == "quit" {
					return a, tea.Quit
				}
				a.confirming = false
			}
			return a, nil
		}
		if a.screen == pluginsScreenID && msg.String() != "ctrl+c" { // (its own keys, Esc and typing included)
			cmd, leave := a.plugins.update(msg)
			a.server.s = a.plugins.s
			a.server.setActions()
			if leave {
				a.screen, a.back = serverScreenID, a.back[:max(len(a.back)-1, 0)]
				return a, a.server.act("refresh")
			}
			return a, cmd
		}
		switch msg.String() {
		case "ctrl+c":
			return a.quit()
		case "q", "esc":
			// (The logs close first.)
			if a.screen == serverScreenID && a.server.logs {
				_, w := a.layout()
				return a, a.server.update(msg, w, a.height)
			}
		}
		switch msg.String() {
		case "q":
			// (Typed as a letter where there's something to type.)
			if a.screen != connScreen && !(a.screen == keysScreenID && a.keys.stage == 0) && !(a.screen == settingsScreenID && a.settings.stage != settingsCountry) && a.screen != removeScreenID && a.screen != clusterScreenID && a.screen != secretsKeyScreenID && !(a.screen == cloudScreenID && a.cloud.stage == pickProject) &&
				!(a.screen == deployScreenID && a.deploy.err == nil) {
				return a.quit()
			}
		case "esc":
			if a.screen == deployScreenID && a.deploy.err == nil || a.screen == removeScreenID && a.remove.working {
				return a, nil // (not while it's setting up, or removing)
			}
			if a.screen == cloudScreenID && a.cloud.back() ||
				a.screen == keysScreenID && a.keys.back() ||
				a.screen == settingsScreenID && a.settings.back() {
				return a, nil // (a screen's own questions first)
			}
			if n := len(a.back); n > 0 {
				a.screen, a.back = a.back[n-1], a.back[:n-1]
				if a.screen == serverScreenID {
					return a, a.server.act("refresh") // (back from Remove: looked at afresh, and live again)
				}
				if a.screen == welcomeScreen {
					return a, a.welcome.animate()
				}
				if a.screen == manageScreenID { // (back from a server: each one looked at again)
					a.manageLines = map[string]string{}
					a.manage = manageChoices(a.servers, a.manageLines)
					return a, lookAtAll(a.servers)
				}
			}
			return a, nil
		}
	}

	switch a.screen {
	case welcomeScreen:
		if k, ok := msg.(tea.KeyMsg); ok && k.String() == "enter" {
			if a.welcome.cursor == 0 {
				a.where = whereChoices(a.welcome.tools, a.where.cursor)
				return a.goTo(whereScreen), recheck() // (Docker started since? gcloud installed? looked again)
			}
			a.servers, a.serversErr = loadServers()
			a.welcome.saved = len(a.servers)
			a.manageLines = map[string]string{}
			a.manage, a.manageNote = manageChoices(a.servers, a.manageLines), ""
			return a.goTo(manageScreenID), lookAtAll(a.servers)
		}
		var cmd tea.Cmd
		a.welcome, cmd = a.welcome.Update(msg)
		return a, cmd
	case whereScreen:
		if k, ok := msg.(tea.KeyMsg); ok {
			switch k.String() {
			case "up", "k":
				a.where.move(-1)
				a.whereMoved = true
			case "down", "j", "tab":
				a.where.move(1)
				a.whereMoved = true
			case "enter":
				if o, ok := a.where.chosen(); ok {
					a.plan.where = o.value
					// Google Cloud Run is for people anywhere; Docker and Kubernetes are for this home
					// (opening them to the internet is up to their owner). None of them asks.
					if mode := map[string]string{"cloudrun": "cloud", "docker": "home", "kubernetes": "home"}[o.value]; mode != "" {
						a.plan.mode = mode
						if o.value == "kubernetes" {
							a.cluster = newClusterScreen(a.welcome.tools)
							return a.goTo(clusterScreenID), nil
						}
						if o.value == "cloudrun" {
							var cmd tea.Cmd
							a.cloud, cmd = newCloudScreen()
							return a.goTo(cloudScreenID), cmd
						}
						a.database = databaseChoices(a.plan.where, 0)
						return a.goTo(databaseScreen), nil
					}
					return a.goTo(audienceScreen), nil
				}
			}
		}
	case audienceScreen:
		if k, ok := msg.(tea.KeyMsg); ok {
			switch k.String() {
			case "up", "k":
				a.audience.move(-1)
			case "down", "j", "tab":
				a.audience.move(1)
			case "enter":
				o, _ := a.audience.chosen()
				a.plan.mode = o.value
				if a.plan.where == "kubernetes" {
					a.cluster = newClusterScreen(a.welcome.tools)
					return a.goTo(clusterScreenID), nil
				}
				a.database = databaseChoices(a.plan.where, 0)
				return a.goTo(databaseScreen), nil
			}
		}
	case databaseScreen:
		if k, ok := msg.(tea.KeyMsg); ok {
			switch k.String() {
			case "up", "k":
				a.database.move(-1)
			case "down", "j", "tab":
				a.database.move(1)
			case "enter":
				if o, ok := a.database.chosen(); ok {
					switch o.value {
					case "url":
						return a.goTo(connScreen), nil
					case "docker":
						a.dockerDB = newDockerDBScreen()
						a.dockerDB.kube = a.plan.where == "kubernetes"
						return a.goTo(dockerDBScreenID), planDockerDBCmd(a.plan.where == "docker")
					}
				}
			}
		}
	case dockerDBScreenID:
		switch msg := msg.(type) {
		case dockerDBPlanned:
			if msg.err != nil {
				a.dockerDB.err = msg.err
				a.dockerDB.choices = choices{opts: []option{{value: "again", title: "Try again"}, {value: "back", title: "Choose something else"}}}
			} else {
				a.dockerDB.db = &msg.db
			}
			return a, nil
		case tea.KeyMsg:
			if a.dockerDB.db == nil && a.dockerDB.err == nil {
				break // (still looking)
			}
			switch msg.String() {
			case "up", "k":
				a.dockerDB.choices.move(-1)
			case "down", "j", "tab":
				a.dockerDB.choices.move(1)
			case "enter":
				o, _ := a.dockerDB.choices.chosen()
				if o.value == "again" {
					kube := a.dockerDB.kube
					a.dockerDB = newDockerDBScreen()
					a.dockerDB.kube = kube
					return a, planDockerDBCmd(a.plan.where == "docker")
				}
				if o.value == "use" {
					d := *a.dockerDB.db
					a.plan.db = connPlan{where: "Postgres in Docker, alongside", docker: &d}
					if a.plan.where == "kubernetes" {
						a.plan.db.where = "Postgres in Kubernetes, alongside"
					}
					return a.toKeys(), nil
				}
				n := len(a.back)
				a.screen, a.back = a.back[n-1], a.back[:n-1]
			}
			return a, nil
		}
	case keysScreenID:
		switch msg := msg.(type) {
		case tmdbChecked:
			a.keys.checkedMsg(msg)
			return a, nil
		case tea.KeyMsg:
			if a.keys.stage == 1 { // (the stream finder)
				switch msg.String() {
				case "up", "k":
					a.keys.aio.move(-1)
				case "down", "j", "tab":
					a.keys.aio.move(1)
				case "enter":
					a.plan.keys = a.keys.plan()
					a.settings = newSettingsScreen(a.plan)
					return a.goTo(settingsScreenID), nil
				}
				return a, nil
			}
			if msg.Type == tea.KeyEnter {
				if a.keys.ready() {
					a.keys.stage = 1
					return a, nil
				}
				return a, a.keys.check()
			}
			_, cmd := a.keys.form.Update(msg)
			if a.keys.form.fields[tmdbField].value() != a.keys.checked {
				a.keys.checked = ""
			}
			return a, cmd
		}
	case settingsScreenID:
		if r, ok := msg.(deployerReady); ok && a.settings.busy {
			a.settings.busy = false
			prev := a.reviewD
			a.reviewD = r.d
			a.reviewD.carryOn(prev) // (an earlier, unfinished try's name and what it made)
			return a.goTo(reviewScreenID), nil
		}
		if msg, ok := msg.(tea.KeyMsg); ok {
			if msg.Type == tea.KeyEnter {
				if a.settings.busy {
					return a, nil
				}
				if a.settings.next() {
					a.plan.settings = a.settings.plan()
					a.review = reviewChoices(a.plan)
					a.settings.busy = true
					p := a.plan
					return a, func() tea.Msg { return deployerReady{newDeployer(p)} } // (it asks Docker or the cluster: a moment)
				}
				return a, nil
			}
			return a, a.settings.Update(msg)
		}
	case reviewScreenID:
		if k, ok := msg.(tea.KeyMsg); ok {
			switch k.String() {
			case "up", "k":
				a.review.move(-1)
			case "down", "j", "tab":
				a.review.move(1)
			case "enter":
				if o, _ := a.review.chosen(); o.value == "back" {
					n := len(a.back)
					a.screen, a.back = a.back[n-1], a.back[:n-1]
					return a, nil
				}
				a.deploy = deployScreenFor(a.reviewD)
				d := a.deploy.d
				go d.run(0)
				return a.goTo(deployScreenID), tea.Batch(d.listen(), a.deploy.spin.Tick)
			}
		}
	case deployScreenID:
		switch msg := msg.(type) {
		case deployMsg:
			a.deploy.apply(msg)
			if msg.end && a.deploy.d.update == "" {
				// Remembered, to manage later.
				a.deploy.d.finished = true
				a.deploy.saveErr = saveServer(a.deploy.d.saved())
			}
			if a.deploy.done || a.deploy.err != nil {
				return a, nil
			}
			return a, a.deploy.d.listen()
		case spinner.TickMsg:
			var cmd tea.Cmd
			a.deploy.spin, cmd = a.deploy.spin.Update(msg)
			return a, cmd
		case tea.KeyMsg:
			switch {
			case a.deploy.done && msg.Type == tea.KeyEnter && a.deploy.d.update != "":
				// Updated: back to the server, looked at afresh.
				n := len(a.back)
				a.screen, a.back = a.back[n-1], a.back[:n-1]
				return a, a.server.act("refresh")
			case a.deploy.done && msg.Type == tea.KeyEnter:
				a.screen, a.back = doneScreenID, nil
				a.done = doneChoices(a.deploy.d)
			case a.deploy.err != nil && (msg.String() == "up" || msg.String() == "k"):
				a.deploy.failed.move(-1)
			case a.deploy.err != nil && (msg.String() == "down" || msg.String() == "j" || msg.String() == "tab"):
				a.deploy.failed.move(1)
			case a.deploy.err != nil && (msg.Type == tea.KeyEnter || msg.String() == "r"):
				if o, _ := a.deploy.failed.chosen(); o.value == "glogs" && msg.Type == tea.KeyEnter {
					c := a.deploy.d.b.plan.cloud
					openURL("https://console.cloud.google.com/run/detail/" + c.region + "/" + a.deploy.d.b.slug + "/logs?project=" + c.project + "&authuser=" + c.account)
					return a, nil
				}
				if o, _ := a.deploy.failed.chosen(); o.value == "back" && msg.Type == tea.KeyEnter {
					if n := len(a.back); n > 0 {
						a.screen, a.back = a.back[n-1], a.back[:n-1]
					}
					if a.screen == serverScreenID { // (back from a failed update: looked at afresh, and live again)
						return a, a.server.act("refresh")
					}
					return a, nil
				}
				from := a.deploy.d.retryFrom(a.deploy.at)
				a.deploy.err = nil
				go a.deploy.d.run(from)
				return a, tea.Batch(a.deploy.d.listen(), a.deploy.spin.Tick)
			}
			return a, nil
		}
	case manageScreenID:
		if k, ok := msg.(tea.KeyMsg); ok && len(a.servers) == 0 && k.Type == tea.KeyEnter {
			a.where = whereChoices(a.welcome.tools, a.where.cursor) // (nothing yet: set one up)
			return a.goTo(whereScreen), recheck()
		}
		if l, ok := msg.(serverLine); ok {
			if a.manageLines == nil {
				a.manageLines = map[string]string{}
			}
			a.manageLines[l.dir] = l.text
			cursor := a.manage.cursor
			a.manage = manageChoices(a.servers, a.manageLines)
			a.manage.cursor = cursor
			return a, nil
		}
		if k, ok := msg.(tea.KeyMsg); ok && len(a.servers) > 0 {
			switch k.String() {
			case "up", "k":
				a.manage.move(-1)
			case "down", "j", "tab":
				a.manage.move(1)
			case "enter":
				o, _ := a.manage.chosen()
				for _, sv := range a.servers {
					if sv.Dir == o.value {
						var cmd tea.Cmd
						a.server, cmd = newServerScreen(freshServer(sv)) // (as saved now: its plugins too)
						return a.goTo(serverScreenID), cmd
					}
				}
			}
		}
	case doneScreenID:
		if k, ok := msg.(tea.KeyMsg); ok {
			switch k.String() {
			case "up", "k":
				a.done.move(-1)
			case "down", "j", "tab":
				a.done.move(1)
			case "enter":
				if o, _ := a.done.chosen(); o.value == "quit" {
					return a, tea.Quit
				}
				// This server's own screen, from the list (as Manage opens it).
				a.servers, a.serversErr = loadServers()
				a.welcome.saved = len(a.servers)
				a.manageLines = map[string]string{}
				a.manage = manageChoices(a.servers, a.manageLines)
				for _, sv := range a.servers {
					if sv.Dir == a.deploy.d.dir {
						var cmd tea.Cmd
						a.server, cmd = newServerScreen(freshServer(sv)) // (as saved now: its plugins too)
						a.screen, a.back = serverScreenID, []screen{welcomeScreen, manageScreenID}
						return a, tea.Batch(cmd, lookAtAll(a.servers))
					}
				}
				a.screen, a.back = manageScreenID, []screen{welcomeScreen}
				return a, lookAtAll(a.servers)
			}
			return a, nil
		}
	case clusterScreenID:
		switch msg := msg.(type) {
		case clusterChecked:
			if a.cluster.checked(msg) {
				a.plan.kube = msg.plan
				a.database = databaseChoices(a.plan.where, 0)
				return a.goTo(databaseScreen), nil
			}
			return a, nil
		case tea.KeyMsg:
			if msg.Type == tea.KeyEnter {
				return a, a.cluster.check()
			}
			_, cmd := a.cluster.form.Update(msg)
			return a, cmd
		}
	case secretsKeyScreenID:
		switch msg := msg.(type) {
		case secretsChecked:
			if a.secrets.checkedMsg(msg) {
				a.secretsKey = msg.key
				return a.toKeys(), nil
			}
			return a, nil
		case tea.KeyMsg:
			if msg.Type == tea.KeyEnter {
				return a, a.secrets.check()
			}
			_, cmd := a.secrets.form.Update(msg)
			return a, cmd
		}
	case cloudScreenID:
		switch msg := msg.(type) {
		case cloudLoaded:
			if a.cloud.busy == "" && len(a.cloud.accounts) > 0 {
				return a, nil // (Esc'd while waiting: let go)
			}
			a.cloud.loaded(msg)
			return a, nil
		case cloudBilling:
			return a, a.cloud.billingLoaded(msg)
		case signedIn:
			return a, a.cloud.signedInAs(msg)
		case cloudProject:
			return a, a.cloud.projectChecked(msg)
		case cloudChecked:
			a.plan.cloud = msg.plan
			return a.goTo(connScreen), nil // (Google Cloud's database is one of theirs: no choice to make)
		case tea.KeyMsg:
			if a.cloud.stage == pickProject && msg.Type != tea.KeyEnter {
				_, cmd := a.cloud.project.Update(msg) // (its name, typed)
				return a, cmd
			}
			switch msg.String() {
			case "up", "k":
				a.cloud.list.move(-1)
			case "down", "j", "tab":
				a.cloud.list.move(1)
			case "enter":
				return a, a.cloud.enter()
			}
			return a, nil
		}
	case removeScreenID:
		switch msg := msg.(type) {
		case removed:
			a.remove.working, a.remove.err = false, msg.err
			if msg.err != nil {
				a.remove.failed(msg.err)
			}
			if msg.err == nil {
				// Gone: back to the list, read again.
				a.servers, a.serversErr = loadServers()
				a.welcome.saved = len(a.servers)
				a.welcome.saved = len(a.servers)
				a.manage = manageChoices(a.servers, a.manageLines)
				a.manageNote = a.remove.s.Name + " was removed."
				if msg.note != "" {
					a.manageNote += " " + msg.note
				}
				a.screen, a.back = manageScreenID, []screen{welcomeScreen}
			}
			return a, nil
		case spinner.TickMsg:
			if a.remove.working {
				var cmd tea.Cmd
				a.remove.spin, cmd = a.remove.spin.Update(msg)
				return a, cmd
			}
			return a, nil
		case tea.KeyMsg:
			if a.remove.working {
				return a, nil
			}
			if a.remove.err != nil { // (it failed: what now)
				switch msg.String() {
				case "up", "k":
					a.remove.after.move(-1)
				case "down", "j", "tab":
					a.remove.after.move(1)
				case "enter":
					switch o, _ := a.remove.after.chosen(); o.value {
					case "again":
						return a, a.remove.start()
					case "forget":
						if err := forgetServer(a.remove.s.Dir); err != nil {
							a.remove.failed(err)
							return a, nil
						}
						a.servers, a.serversErr = loadServers()
						a.welcome.saved = len(a.servers)
						a.manage = manageChoices(a.servers, a.manageLines)
						a.manageNote = a.remove.s.Name + " was taken off the list."
						a.screen, a.back = manageScreenID, []screen{welcomeScreen}
					case "back":
						n := len(a.back)
						a.screen, a.back = a.back[n-1], a.back[:n-1]
						return a, a.server.act("refresh")
					}
				}
				return a, nil
			}
			if msg.Type == tea.KeyEnter {
				return a, a.remove.start()
			}
			var cmd tea.Cmd
			a.remove.input, cmd = a.remove.input.Update(msg)
			return a, cmd
		}
	case serverScreenID:
		if k, ok := msg.(tea.KeyMsg); ok && !a.server.logs && a.server.busy == "" {
			switch k.String() {
			case "up", "k":
				a.server.actions.move(-1)
			case "down", "j", "tab":
				a.server.actions.move(1)
			case "r":
				return a, a.server.act("refresh")
			case "enter":
				o, _ := a.server.actions.chosen()
				if o.value == "remove" {
					a.remove = newRemoveScreen(freshServer(a.server.s)) // (with its plugins as saved)
					return a.goTo(removeScreenID), nil
				}
				if o.value == "plugins" {
					a.plugins = newPluginsScreen(a.server.s, a.server.s.Where == "cloudrun" || a.server.running())
					return a.goTo(pluginsScreenID), nil
				}
				if o.value == "forget" {
					if err := forgetServer(a.server.s.Dir); err != nil {
						a.server.note, a.server.noteBad = err.Error(), true
						return a, nil
					}
					a.servers, a.serversErr = loadServers()
					a.welcome.saved = len(a.servers)
					a.manage = manageChoices(a.servers, a.manageLines)
					a.manageNote = a.server.s.Name + " was taken off the list."
					a.screen, a.back = manageScreenID, []screen{welcomeScreen}
					return a, nil
				}
				if o.value == "update" {
					up := newUpdater(a.server.s)
					switch a.server.s.Where {
					case "kubernetes":
						up = newKubeUpdater(a.server.s)
					case "cloudrun":
						up = newCloudUpdater(a.server.s)
					}
					a.deploy = deployScreenFor(up)
					d := a.deploy.d
					go d.run(0)
					return a.goTo(deployScreenID), tea.Batch(d.listen(), a.deploy.spin.Tick)
				}
				return a, a.server.act(o.value)
			}
			return a, nil
		}
		_, w := a.layout()
		return a, a.server.update(msg, w, a.height)
	case connScreen:
		switch msg := msg.(type) {
		case tea.KeyMsg:
			if msg.String() == "enter" {
				if a.conn.good() {
					a.plan.db = connPlan{url: normalizeURL(a.conn.checked), where: dbWhere(a.conn.checked)}
					if a.conn.report != nil && a.conn.report.hasHouseholds() {
						// (Its households' keys are locked with their server's secrets key: asked for.)
						a.secrets = newSecretsKeyScreen(a.plan.db.url)
						return a.goTo(secretsKeyScreenID), nil
					}
					a.secretsKey = ""
					return a.toKeys(), nil
				}
				return a, a.conn.check()
			}
			var cmd tea.Cmd
			a.conn, cmd = a.conn.Update(msg)
			return a, cmd
		case dbChecked, spinner.TickMsg:
			var cmd tea.Cmd
			a.conn, cmd = a.conn.Update(msg)
			if _, tick := msg.(spinner.TickMsg); tick {
				var wcmd tea.Cmd
				a.welcome, wcmd = a.welcome.Update(msg)
				return a, tea.Batch(cmd, wcmd)
			}
			return a, cmd
		}
	}
	// (Spinner ticks and the like go to the Welcome screen, which owns them.)
	var cmd tea.Cmd
	if _, isKey := msg.(tea.KeyMsg); !isKey {
		a.welcome, cmd = a.welcome.Update(msg)
	}
	return a, cmd
}

func (a app) View() string {
	if a.width == 0 {
		return ""
	}
	wide, inner := a.layout()
	f := frame{width: a.width, height: a.height, step: -1, wide: wide}
	choose := []key{{"↑↓", "choose"}, {"enter", "select"}, {"esc", "back"}, {"q", "quit"}}
	switch a.screen {
	case welcomeScreen:
		f.body, f.keys = a.welcome.View(inner, a.height), a.welcome.keys()
		f.hero = heroFits(inner, a.height)
	case whereScreen:
		f.step, f.keys = 0, choose
		f.body = heading("Where should Nightcap run?", "You can add more servers later.") + a.where.view(inner)
	case audienceScreen:
		f.step, f.keys = 0, choose
		f.body = heading("Who will watch?", "This decides how TVs and phones join.") + a.audience.view(inner)
	case databaseScreen:
		f.step, f.keys = 1, choose
		f.body = heading("Where should it keep its data?", "Profiles, watch history and settings go in a database.") + a.database.view(inner)
	case connScreen:
		f.step, f.keys = 1, a.conn.keys()
		f.body = a.conn.View(inner)
	case dockerDBScreenID:
		f.step, f.keys = 1, choose
		f.body = a.dockerDB.View(inner)
	case keysScreenID:
		f.step, f.keys = 2, a.keys.keys()
		f.body = a.keys.View(inner)
	case settingsScreenID:
		f.step, f.keys = 3, a.settings.keys()
		f.body = a.settings.View(inner)
	case reviewScreenID:
		f.step, f.keys = 4, choose
		f.body = reviewView(a.plan, a.reviewD, inner, a.review)
	case deployScreenID:
		f.step, f.keys = 5, a.deploy.keys()
		f.body = a.deploy.View(inner)
	case serverScreenID:
		f.keys, f.body = a.server.keys(), a.server.View(inner)
	case removeScreenID:
		f.keys, f.body = a.remove.keys(), a.remove.View(inner)
	case pluginsScreenID:
		a.plugins.spin = a.welcome.spin.View()
		f.keys, f.body = a.plugins.keys(), a.plugins.View(inner)
	case secretsKeyScreenID:
		f.step, f.keys = 1, a.secrets.keys()
		f.body = a.secrets.View(inner)
	case cloudScreenID:
		a.cloud.spin = a.welcome.spin.View()
		f.step, f.keys = 0, a.cloud.keys()
		f.body = a.cloud.View(inner)
	case clusterScreenID:
		a.cluster.spin = a.welcome.spin.View()
		f.step, f.keys = 0, a.cluster.keys()
		f.body = a.cluster.View(inner)
	case manageScreenID:
		f.keys = []key{{"↑↓", "choose"}, {"enter", "select"}, {"esc", "back"}, {"q", "quit"}}
		f.body = manageView(a.servers, a.serversErr, a.manage, a.manageNote, inner)
	case doneScreenID:
		f.keys = []key{{"↑↓", "choose"}, {"enter", "select"}, {"q", "quit"}}
		f.body = doneView(a.plan, a.deploy.d, inner, a.done)
	}
	if wide && f.step >= 0 {
		f.side = sideSteps(f.step, chosenSoFar(a.plan))
	}
	if a.confirming {
		f.keys, f.body = []key{{"↑↓", "choose"}, {"enter", "select"}, {"esc", "keep going"}}, a.confirmView(inner)
	}
	return f.render()
}

// quit quits, or first asks when something would be lost: answers being given, a setup or an
// update under way or failed. (Welcome, Manage, a server's screen and Done just quit.)
func (a app) quit() (tea.Model, tea.Cmd) {
	running := a.screen == deployScreenID && !a.deploy.done
	if stepOf(a.screen) < 0 && !running {
		return a, tea.Quit
	}
	a.confirming = true
	quitDesc := "Your answers so far are lost."
	switch {
	case running && a.deploy.d != nil && a.deploy.d.update != "":
		quitDesc = "It may be left half updated: update it again from Manage."
	case running && a.deploy.d != nil && a.deploy.d.kept:
		quitDesc = "What's made so far stays on your list: Manage can remove it."
	case running:
		quitDesc = "Nothing is made yet."
	}
	a.confirm = choices{opts: []option{
		{value: "stay", title: "Keep going", badge: "Recommended"},
		{value: "quit", title: "Quit", desc: quitDesc},
	}}
	return a, nil
}

func (a app) confirmView(width int) string {
	title := "Quit setting up?"
	if a.screen == deployScreenID && !a.deploy.done {
		title = "Stop now?"
		if a.deploy.d != nil && a.deploy.d.update != "" {
			title = "Stop updating?"
		}
	}
	return heading(title, "") + a.confirm.view(width)
}

// stepOf is the setup step a screen is part of, or -1.
func stepOf(s screen) int {
	switch s {
	case whereScreen, audienceScreen, clusterScreenID, cloudScreenID:
		return 0
	case databaseScreen, connScreen, secretsKeyScreenID, dockerDBScreenID:
		return 1
	case keysScreenID:
		return 2
	case settingsScreenID:
		return 3
	case reviewScreenID:
		return 4
	case deployScreenID:
		return 5
	}
	return -1
}

// layout is whether this screen gets the wide frame (the setup steps, Manage, and a server's
// screen, in a wide window), and the width its own part of the frame has.
func (a app) layout() (wide bool, width int) {
	step := stepOf(a.screen)
	if a.screen == deployScreenID && a.deploy.d != nil && a.deploy.d.update != "" {
		step = -1 // (an update isn't a setup)
	}
	wide = a.width >= wideFrom && (step >= 0 || a.screen == welcomeScreen || a.screen == manageScreenID || a.screen == serverScreenID)
	if !wide {
		return false, min(max(a.width, 40), maxWidth) - 4
	}
	inner := min(a.width, wideWidth) - 4
	if step >= 0 {
		return true, inner - sideWidth - 3
	}
	return true, inner
}

// chosenSoFar is what's been chosen at each setup step, short, for the wide frame's column.
func chosenSoFar(p plan) []string {
	out := make([]string, len(steps))
	if p.where != "" {
		out[0] = map[string]string{"docker": "This computer", "kubernetes": "Kubernetes", "cloudrun": "Google Cloud", "files": "Another machine"}[p.where]
		if who := map[string]string{"home": "home", "cloud": "anywhere"}[p.mode]; who != "" {
			out[0] += " · " + who
		}
		if p.where == "kubernetes" && p.kube.namespace != "" {
			out[0] += " · " + p.kube.namespace
		}
		if p.where == "cloudrun" && p.cloud.project != "" {
			out[0] = "Google Cloud · " + regionName(p.cloud.region)
		}
	}
	out[1] = shortDB(p.db)
	if p.keys.tmdb != "" {
		out[2] = "TMDB key works"
		if p.keys.ownAIO {
			out[2] += " · own AIOStreams"
		}
	}
	out[3] = p.settings.name
	return out
}

func countryName(code string) string {
	for _, c := range countries {
		if c.value == code {
			return c.title
		}
	}
	return code
}

// toKeys goes on to the keys, making them the first time only (going back and forth keeps them).
func (a app) toKeys() app {
	if a.keys.owner == "" {
		a.keys = newKeysScreen()
	}
	if a.secretsKey != "" {
		a.keys.secrets = a.secretsKey // (the households' own, from the database's server)
	}
	return a.goTo(keysScreenID)
}

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Println("Nightcap Server Setup", version)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "template" {
		if err := templateCommand(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "Not changed:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "update" {
		if err := selfUpdate(); err != nil {
			fmt.Fprintln(os.Stderr, "Not updated:", err)
			os.Exit(1)
		}
		return
	}
	// The terminal's background is asked about now, once: asked while the screen is up, its answer
	// would be read as keys.
	switch os.Getenv("NIGHTCAP_THEME") { // (for a terminal that can't say: light or dark)
	case "light":
		lipgloss.SetHasDarkBackground(false)
	case "dark":
		lipgloss.SetHasDarkBackground(true)
	default:
		lipgloss.HasDarkBackground()
	}
	if _, err := tea.NewProgram(newApp(), tea.WithAltScreen()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, "nightcap:", err)
		os.Exit(1)
	}
}

// shortDB is the database, short enough for the steps' column: "made for you", or its host's
// last two names (ep-dry-truth….neon.tech: neon.tech).
func shortDB(db connPlan) string {
	if db.docker != nil {
		return "made for you"
	}
	host, _, _ := strings.Cut(db.where, "/")
	host, _, _ = strings.Cut(host, ":")
	if labels := strings.Split(host, "."); len(host) > sideWidth-4 && len(labels) > 2 && net.ParseIP(host) == nil {
		host = strings.Join(labels[len(labels)-2:], ".")
	}
	return host
}

// deployerReady is the setup, worked out (its name and folder) for Review.
type deployerReady struct{ d *deployer }
