package main

import (
	"os/exec"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"

	tea "github.com/charmbracelet/bubbletea"
)

// Where in Google Cloud, one question at a time: which Google account (one gcloud has; one whose
// sign-in has run out, signed in again; or another, signed in from here; gcloud's own default is
// left as it is), its billing account (asked only when it has none, to add one in Google's page,
// or several, to pick one), the region (the nearest first), and the new project's name (always a
// new one, just for Nightcap, so its costs are on their own). Nothing is made until the last step.

type cloudStage int

const (
	pickAccount cloudStage = iota
	pickBilling
	pickRegion
	pickProject
)

type cloudScreen struct {
	stage    cloudStage
	accounts []gaccount
	list     choices // this stage's
	account  string
	billing  []billingAccount
	bill     billingAccount
	busy     string // what it's waiting for ("Looking at its billing…")
	err      string
	opened   bool   // Google's billing page was opened
	region   string // the one chosen
	all      bool   // the full list of regions is showing
	project  form   // the new project's name
	spin     string // the spinner's frame (drawn by the app)
}

// cloudProject is whether a project name is free to use (none of theirs has it).
type cloudProject struct {
	id     string
	err    string
	theirs bool // one of theirs already: used as it is
}

type gaccount struct {
	email   string
	expired bool // its sign-in has run out
}

// (Choices that do something rather than choose.)
const (
	signInChoice = "+sign-in"
	openBilling  = "+open"
	lookAgain    = "+again"
)

type cloudLoaded struct {
	accounts []gaccount
	prefer   string
}

type cloudBilling struct {
	account string
	billing []billingAccount
	err     string
}

type signedIn struct {
	before []string
	err    error
}

type cloudChecked struct{ plan cloudPlan }

func newCloudScreen() (cloudScreen, tea.Cmd) {
	c := cloudScreen{busy: "Looking at your Google accounts…"}
	c.project.fields = []*field{newText("Project", "", newProjectID(), "nightcap-home", false)}
	c.project.fields[0].input.Focus()
	c.project.fields[0].input.CursorEnd()
	c.project.fields[0].status = "6 to 30 small letters, digits and dashes. It can't be changed later."
	return c, func() tea.Msg { return loadAccounts("") }
}

// loadAccounts finds the accounts gcloud has, and whether each one's sign-in still works.
func loadAccounts(prefer string) tea.Msg {
	emails := gcloudAccounts()
	accounts := make([]gaccount, len(emails))
	var wg sync.WaitGroup
	for i, e := range emails {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := gcloudQuick("auth", "print-access-token", as(e))
			accounts[i] = gaccount{email: e, expired: err != nil}
		}()
	}
	wg.Wait()
	return cloudLoaded{accounts, prefer}
}

func loadBilling(account string) tea.Msg {
	list, err := billingAccounts(account)
	if err != nil { // (once more: Google sometimes doesn't answer the first time)
		list, err = billingAccounts(account)
	}
	r := cloudBilling{account: account, billing: list}
	if err != nil {
		r.err = "Couldn't see its billing: " + err.Error()
	}
	return r
}

func (c *cloudScreen) loaded(m cloudLoaded) {
	c.busy, c.err, c.stage = "", "", pickAccount
	c.accounts = m.accounts
	c.list = choices{}
	for i, a := range m.accounts {
		o := option{value: a.email, title: a.email}
		if a.expired {
			o.desc = "Signed out. Enter signs in again."
		}
		c.list.opts = append(c.list.opts, o)
		if a.email == m.prefer {
			c.list.cursor = i
		}
	}
	c.list.opts = append(c.list.opts, option{value: signInChoice, title: "Sign in with another account", desc: "Your browser opens."})
}

func (c *cloudScreen) billingLoaded(m cloudBilling) tea.Cmd {
	if m.account != c.account || c.busy == "" {
		return nil // (another account chosen since)
	}
	c.busy, c.billing = "", m.billing
	if m.err != "" {
		c.err = m.err + ". Choose it to try again, or another account."
		return nil
	}
	if len(m.billing) == 1 { // (the one there is: no question)
		c.bill = m.billing[0]
		c.toRegions()
		return nil
	}
	c.showBilling()
	return nil
}

// showBilling asks for the billing account: one of several, or (with none) to add one.
func (c *cloudScreen) showBilling() {
	c.stage, c.list = pickBilling, choices{}
	for _, b := range c.billing {
		c.list.opts = append(c.list.opts, option{value: b.id, title: orDefault(b.name, b.id)})
	}
	if len(c.billing) == 0 {
		c.list.opts = []option{
			{value: openBilling, title: "Open Google's billing page", desc: "Add a card there. Then come back here."},
			{value: lookAgain, title: "I've added it, check again"},
		}
		if c.opened {
			c.list.cursor = 1
		}
	}
}

// toRegions: the 3 best for where this computer is, the first recommended, and the rest a step away.
func (c *cloudScreen) toRegions() {
	c.stage, c.list, c.all = pickRegion, choices{}, false
	for i, r := range bestRegions(here()) {
		o := option{value: r.id, title: r.label()}
		if i == 0 {
			o.badge = "Recommended"
		}
		c.list.opts = append(c.list.opts, o)
	}
	c.list.opts = append(c.list.opts, option{value: moreRegions, title: "Somewhere else…"})
}

const moreRegions = "more regions"

// allRegions: every region, by area, the cursor on the recommended one.
func (c *cloudScreen) allRegions() {
	c.list, c.all = choices{compact: true}, true
	first := bestRegions(here())[0].id
	for _, area := range []string{"North America", "South America", "Europe", "Middle East", "Africa", "Asia", "Australia"} {
		for _, r := range cloudRegions {
			if r.area == area {
				if r.id == first {
					c.list.cursor = len(c.list.opts)
				}
				c.list.opts = append(c.list.opts, option{value: r.id, title: r.label(), desc: r.id, group: area})
			}
		}
	}
}

// back goes to the stage before; false when this is the first.
func (c *cloudScreen) back() bool {
	switch {
	case c.busy != "" && c.stage == pickAccount:
		c.busy = "" // (waiting: Esc goes back all the same; its answer is let go)
		return false
	case c.busy != "":
		c.busy = ""
		return true
	case c.stage == pickProject:
		c.stage = pickRegion
		return true
	case c.stage == pickRegion && c.all:
		c.toRegions()
		return true
	case c.stage == pickRegion && len(c.billing) != 1:
		c.showBilling()
		return true
	case c.stage != pickAccount:
		c.loaded(cloudLoaded{c.accounts, c.account})
		return true
	}
	return false
}

func (c *cloudScreen) enter() tea.Cmd {
	if c.busy != "" {
		return nil
	}
	c.err = ""
	if c.stage == pickProject {
		f := c.project.fields[0]
		id := f.value()
		if !projectID.MatchString(id) {
			f.status, f.statusKind = "6 to 30 small letters, digits and dashes, starting with a letter.", -1
			return nil
		}
		c.busy = "Checking the name…"
		account := c.account
		return func() tea.Msg {
			state, err := gcloudQuick("projects", "describe", id, "--format=value(lifecycleState)", as(account))
			switch {
			case err != nil && projectMissing(err):
				// (None of theirs. Google says the same for a name that's someone else's: that
				// shows when it's made, on the last step.)
				return cloudProject{id: id}
			case err != nil:
				return cloudProject{id: id, err: "Couldn't check the name (" + err.Error() + "). Press Enter to try again."}
			case state == "DELETE_REQUESTED":
				return cloudProject{id: id, err: "A project with this name was deleted recently: Google keeps the name for 30 days. Pick another."}
			}
			return cloudProject{id: id, theirs: true}
		}
	}
	o, ok := c.list.chosen()
	if !ok {
		return nil
	}
	switch c.stage {
	case pickAccount:
		before := make([]string, len(c.accounts))
		for i, a := range c.accounts {
			before[i] = a.email
		}
		login := func(args ...string) tea.Cmd {
			// (gcloud's own sign-in, in this window; its default account stays as it is.)
			return tea.ExecProcess(exec.Command("gcloud", append([]string{"auth", "login", "--no-activate"}, args...)...), func(err error) tea.Msg {
				return signedIn{before, err}
			})
		}
		if o.value == signInChoice {
			return login()
		}
		if i := slices.IndexFunc(c.accounts, func(a gaccount) bool { return a.email == o.value }); i >= 0 && c.accounts[i].expired {
			return login(o.value)
		}
		c.account, c.busy = o.value, "Looking at its billing…"
		return func() tea.Msg { return loadBilling(o.value) }
	case pickBilling:
		switch o.value {
		case openBilling:
			c.opened = true
			c.list.cursor = 1
			openURL("https://console.cloud.google.com/billing?authuser=" + c.account)
			return nil
		case lookAgain:
			c.busy = "Looking at its billing…"
			account := c.account
			return func() tea.Msg { return loadBilling(account) }
		}
		for _, b := range c.billing {
			if b.id == o.value {
				c.bill = b
			}
		}
		c.toRegions()
		return nil
	}
	if o.value == moreRegions {
		c.allRegions()
		return nil
	}
	// The region: on to the project's name.
	c.region, c.stage = o.value, pickProject
	return nil
}

// projectChecked: a free name is the last answer.
func (c *cloudScreen) projectChecked(m cloudProject) tea.Cmd {
	c.busy = ""
	f := c.project.fields[0]
	if m.id != f.value() {
		return nil
	}
	if m.err != "" {
		f.status, f.statusKind = m.err, -1
		return nil
	}
	p := cloudPlan{account: c.account, project: m.id, newProject: !m.theirs, billing: c.bill.id,
		billingName: c.bill.name, region: c.region}
	return func() tea.Msg { return cloudChecked{p} }
}

// signedInAs: back from signing in, with the account just signed in chosen.
func (c *cloudScreen) signedInAs(m signedIn) tea.Cmd {
	if m.err != nil {
		c.err = "The sign-in didn't finish. Choose the account to try again."
		return nil
	}
	c.busy = "Looking at your Google accounts…"
	before := m.before
	return func() tea.Msg {
		r := loadAccounts("").(cloudLoaded)
		for _, a := range r.accounts {
			if !slices.Contains(before, a.email) {
				r.prefer = a.email
			}
		}
		return r
	}
}

// openURL opens a page in the browser.
func openURL(url string) {
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("open", url).Start()
	case "windows":
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		_ = exec.Command("xdg-open", url).Start()
	}
}

var projectID = regexp.MustCompile(`^[a-z][a-z0-9-]{4,28}[a-z0-9]$`)

func (c cloudScreen) View(width int) string {
	var b strings.Builder
	switch c.stage {
	case pickAccount:
		b.WriteString(heading("Which Google account?", "Nightcap gets a new project there, just for it."))
	case pickBilling:
		if len(c.billing) == 0 {
			b.WriteString(heading("Add billing to "+c.account, "Google needs a card, even for its free tier."))
		} else {
			b.WriteString(heading("Which billing account?", "The new project goes on it."))
		}
	case pickRegion:
		b.WriteString(heading("Where should it run?", "Pick one near you."))
	case pickProject:
		b.WriteString(heading("Name your Google project", "A new project, just for Nightcap. Its costs show on their own."))
		if c.busy != "" {
			return b.String() + muted.Render("  "+c.busy)
		}
		return b.String() + c.project.fields[0].alone(width)
	}
	switch {
	case c.busy != "":
		b.WriteString("  " + c.spin + " " + plain.Render(c.busy) + "\n\n" + muted.Render("  Google can take a minute."))
		return b.String()
	case c.err != "":
		b.WriteString(note(width, bad.Render("✗ "), c.err) + "\n\n")
	}
	b.WriteString(c.list.view(width))
	if c.stage == pickBilling && len(c.billing) == 0 && c.opened {
		b.WriteString("\n\n" + note(width, accent.Render("→ "), "Opened in your browser. Add the card, then choose \"check again\"."))
	}
	return b.String()
}

func (c cloudScreen) keys() []key {
	if c.stage == pickProject {
		return []key{{"enter", "continue"}, {"esc", "back"}, {"ctrl+c", "quit"}}
	}
	return []key{{"↑↓", "choose"}, {"enter", "select"}, {"esc", "back"}, {"q", "quit"}}
}
