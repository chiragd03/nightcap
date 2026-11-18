package main

import (
	"net"
	"os"
	"slices"
	"strings"
	"time"
	_ "time/tzdata" // time zones by name on every system, Windows too

	tea "github.com/charmbracelet/bubbletea"
)

type settingsPlan struct {
	name, country, timezone, address string
}

var countries = []option{
	{value: "CA", title: "Canada"}, {value: "US", title: "United States"}, {value: "IN", title: "India"},
	{value: "GB", title: "United Kingdom"}, {value: "AU", title: "Australia"},
}

// The settings, one question a screen: the server's name, then its country. The time zone is this
// computer's, and the address is worked out (this computer's on the network, or a node's; on Google
// Cloud, Google's): both are shown on Review. Only files run on another machine ask for its address.
type settingsScreen struct {
	stage      int // settingsName, settingsCountry, settingsAddress
	name       form
	country    choices
	address    form
	askAddress bool   // files for another machine: its address is theirs to give
	needTLS    bool   // for people anywhere: https:// is needed
	guess      string // the address worked out, when it isn't asked
	busy       bool   // getting Review ready
	tz         string
}

const (
	settingsName = iota
	settingsCountry
	settingsAddress
)

func newSettingsScreen(p plan) settingsScreen {
	s := settingsScreen{tz: localTimezone(), askAddress: p.where == "files", needTLS: p.mode == "cloud"}
	s.name.fields = []*field{newText("Name", "", "Nightcap", "type a name", false)}
	s.name.fields[0].input.CharLimit = 60
	s.name.fields[0].input.Focus()
	s.name.fields[0].input.CursorEnd()
	for i, c := range countries {
		s.country.opts = append(s.country.opts, c)
		if c.value == countryFor(s.tz) {
			s.country.cursor = i
		}
	}
	placeholder := "e.g. http://192.168.1.20:7171 (or leave it empty)"
	if s.needTLS {
		placeholder = "e.g. https://tv.yourdomain.com"
	}
	s.address.fields = []*field{newText("Address", "", "", placeholder, false)}
	s.address.fields[0].input.Focus()
	if p.mode == "home" && p.where != "files" {
		ip := localIP()
		if p.where == "kubernetes" {
			ip = p.kube.nodeIP // (a node's, where it's reached)
		}
		if ip != "" {
			s.guess = "http://" + ip + ":" + serverPort(p.where)
		}
	}
	return s
}

// serverPort is the port the server answers on, where it runs (Kubernetes's is a node port).
func serverPort(where string) string {
	if where == "kubernetes" {
		return "30171"
	}
	return "7171"
}

// next takes Enter: on to the next question, if this one's answer is right; it says whether
// they're all answered.
func (s *settingsScreen) next() bool {
	switch s.stage {
	case settingsName:
		f := s.name.fields[0]
		if f.value() == "" {
			f.status, f.statusKind = "Give it a name.", -1
			return false
		}
		f.status, f.statusKind = "", 0
		s.stage = settingsCountry
		return false
	case settingsCountry:
		if s.askAddress {
			s.stage = settingsAddress
			return false
		}
		return true
	}
	f := s.address.fields[0]
	a := f.value()
	switch {
	case s.needTLS && !strings.HasPrefix(a, "https://"):
		f.status, f.statusKind = "For people anywhere it needs an https:// address.", -1
		return false
	case !s.needTLS && a != "" && !strings.HasPrefix(a, "http://") && !strings.HasPrefix(a, "https://"):
		f.status, f.statusKind = "It starts with http:// or https://.", -1
		return false
	}
	return true
}

// back goes to the question before; false on the first.
func (s *settingsScreen) back() bool {
	if s.stage > settingsName {
		s.stage--
		return true
	}
	return false
}

func (s settingsScreen) plan() settingsPlan {
	o, _ := s.country.chosen()
	p := settingsPlan{name: s.name.fields[0].value(), country: o.value, timezone: s.tz, address: s.guess}
	if s.askAddress {
		p.address = strings.TrimRight(s.address.fields[0].value(), "/")
	}
	return p
}

func (s settingsScreen) View(width int) string {
	if s.busy {
		return heading("Getting ready…", "A moment: looking at what's already there.")
	}
	switch s.stage {
	case settingsCountry:
		return heading("Which country?", "For release dates and the Top 10.") + s.country.view(width)
	case settingsAddress:
		if s.needTLS {
			return heading("What's its web address?", "Where people reach it. It starts with https://.") + s.address.fields[0].alone(width)
		}
		return heading("What's its address?", "Where TVs reach it on your network. You can leave it empty.") + s.address.fields[0].alone(width)
	}
	return heading("Name your server", "It's shown on your TVs.") + s.name.fields[0].alone(width)
}

func (s settingsScreen) keys() []key {
	if s.stage == settingsCountry {
		return []key{{"↑↓", "choose"}, {"enter", "select"}, {"esc", "back"}, {"q", "quit"}}
	}
	return []key{{"enter", "continue"}, {"esc", "back"}, {"ctrl+c", "quit"}}
}

func (s *settingsScreen) Update(msg tea.KeyMsg) tea.Cmd {
	switch s.stage {
	case settingsCountry:
		switch msg.String() {
		case "up", "k":
			s.country.move(-1)
		case "down", "j", "tab":
			s.country.move(1)
		}
		return nil
	case settingsAddress:
		_, cmd := s.address.Update(msg)
		return cmd
	}
	_, cmd := s.name.Update(msg)
	return cmd
}

// localTimezone is this computer's time zone by name (from /etc/localtime on Mac and Linux, TZ
// if set), else UTC.
func localTimezone() string {
	if tz := os.Getenv("TZ"); tz != "" {
		if _, err := time.LoadLocation(tz); err == nil {
			return tz
		}
	}
	if target, err := os.Readlink("/etc/localtime"); err == nil {
		if _, name, ok := strings.Cut(target, "zoneinfo/"); ok {
			return strings.TrimPrefix(strings.TrimPrefix(name, "posix/"), "right/")
		}
	}
	if data, err := os.ReadFile("/etc/timezone"); err == nil && strings.TrimSpace(string(data)) != "" {
		return strings.TrimSpace(string(data)) // (where /etc/localtime is a copy, not a link)
	}
	if tz := windowsTimezone(); tz != "" {
		return tz
	}
	return "UTC"
}

// countryFor guesses the country from a time zone (one of the five Nightcap has a Top 10 for).
func countryFor(tz string) string {
	if p, ok := placeOf(tz); ok && slices.ContainsFunc(countries, func(c option) bool { return c.value == p.cc }) {
		return p.cc
	}
	switch {
	case strings.HasPrefix(tz, "Asia/Kolkata"), strings.HasPrefix(tz, "Asia/Calcutta"):
		return "IN"
	case strings.HasPrefix(tz, "Europe/London"):
		return "GB"
	case strings.HasPrefix(tz, "Australia/"):
		return "AU"
	}
	for _, ca := range []string{"Toronto", "Vancouver", "Montreal", "Edmonton", "Winnipeg", "Halifax", "Regina", "St_Johns", "Moncton", "Whitehorse"} {
		if tz == "America/"+ca {
			return "CA"
		}
	}
	return "US"
}

// localIP is this computer's address on its network (nothing is sent: a UDP "connection" only
// picks the way out).
func localIP() string {
	c, err := net.Dial("udp", "192.0.2.1:9")
	if err != nil {
		return ""
	}
	defer c.Close()
	if a, ok := c.LocalAddr().(*net.UDPAddr); ok && !a.IP.IsLoopback() {
		return a.IP.String()
	}
	return ""
}
