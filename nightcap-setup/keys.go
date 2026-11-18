package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// The keys: TMDB's (required; checked live), whether Nightcap runs its own AIOStreams, and the
// two made for the server: the owner key (to sign in to the owner page) and the secrets key
// (households' saved keys are locked with it in the database). An AI key isn't asked for here:
// each household sets its own in the web app.

type keysPlan struct {
	tmdb       string
	ownAIO     bool
	ownerKey   string
	secretsKey string
}

type tmdbChecked struct {
	key string
	ok  bool
	why string
	net bool // TMDB couldn't be reached (not a no): the key can be used unchecked
}

// checkTMDB asks TMDB about the key: a v4 read token ("eyJ…") as a bearer token, a v3 key as
// api_key, as the server uses them.
func checkTMDB(key string) tmdbChecked {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	u := "https://api.themoviedb.org/3/configuration"
	if !strings.HasPrefix(key, "eyJ") {
		u += "?api_key=" + url.QueryEscape(key)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if strings.HasPrefix(key, "eyJ") {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return tmdbChecked{key: key, why: "Couldn't reach TMDB from this computer. Press Enter again to use it anyway.", net: true}
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return tmdbChecked{key: key, ok: true}
	case http.StatusUnauthorized:
		return tmdbChecked{key: key, why: "TMDB says this key isn't valid."}
	}
	return tmdbChecked{key: key, why: fmt.Sprintf("TMDB answered %d. Try again in a moment.", resp.StatusCode)}
}

// The keys, one question a screen: TMDB's key (checked live; on to the next once it works), then
// whether to include a stream finder. The owner and secrets keys are made here and shown at the end.
type keysScreen struct {
	stage    int // 0: TMDB's key; 1: the stream finder
	form     form
	aio      choices
	checking bool
	checked  string // the key last found to work
	unreach  string // the key TMDB couldn't be asked about (Enter again uses it)
	owner    string
	secrets  string
}

const tmdbField = 0

func newKeysScreen() keysScreen {
	s := keysScreen{owner: ownerKey(), secrets: newSecret(48)}
	s.form.fields = []*field{newText("TMDB key", "", "", "paste your key", true)}
	s.form.fields[tmdbField].input.Focus()
	s.form.fields[tmdbField].status = "Free: themoviedb.org → Settings → API"
	s.aio = choices{opts: []option{
		{value: "own", title: "Yes, include one", badge: "Recommended", desc: "It finds something to play for every title.\nAIOStreams, next to Nightcap"},
		{value: "none", title: "No", desc: "Each household adds its own later, in the web app."},
	}}
	return s
}

// ownerKey is a key to sign in to the owner page: 8 groups of 4, easy to read out, and long
// enough for the server (it refuses one shorter than 32 characters).
func ownerKey() string {
	k := newSecret(32)
	groups := make([]string, 0, 8)
	for i := 0; i < len(k); i += 4 {
		groups = append(groups, k[i:i+4])
	}
	return strings.Join(groups, "-")
}

// ready: the key works (and it's on to the stream finder).
func (s keysScreen) ready() bool {
	t := s.form.fields[tmdbField].value()
	return t != "" && t == s.checked
}

// back goes from the stream finder to the key; false on the key.
func (s *keysScreen) back() bool {
	if s.stage == 1 {
		s.stage = 0
		return true
	}
	return false
}

func (s *keysScreen) check() tea.Cmd {
	t := s.form.fields[tmdbField].value()
	if t == "" || s.checking {
		return nil
	}
	if t == s.unreach { // (Enter again: used as it is, unchecked)
		s.checked, s.stage = t, 1
		return nil
	}
	s.checking = true
	f := s.form.fields[tmdbField]
	f.status, f.statusKind = "Checking with TMDB…", 0
	return func() tea.Msg { return checkTMDB(t) }
}

// checkedMsg takes TMDB's answer: a key that works goes on to the stream finder.
func (s *keysScreen) checkedMsg(m tmdbChecked) {
	s.checking = false
	f := s.form.fields[tmdbField]
	if m.key != f.value() {
		return
	}
	if m.ok {
		s.checked = m.key
		f.status, f.statusKind = "works", 1
		s.stage = 1
	} else if m.net {
		s.unreach = m.key
		f.status, f.statusKind = m.why, -1
	} else {
		f.status, f.statusKind = m.why, -1
	}
}

func (s keysScreen) plan() keysPlan {
	o, _ := s.aio.chosen()
	return keysPlan{tmdb: s.checked, ownAIO: o.value == "own", ownerKey: s.owner, secretsKey: s.secrets}
}

func (s keysScreen) View(width int) string {
	if s.stage == 1 {
		return heading("Include a stream finder?", "Without one, nothing plays until a household adds its own.") + s.aio.view(width)
	}
	return heading("Paste your TMDB key", "Nightcap gets posters and details from it.") + s.form.fields[tmdbField].alone(width)
}

func (s keysScreen) keys() []key {
	if s.stage == 1 {
		return []key{{"↑↓", "choose"}, {"enter", "select"}, {"esc", "back"}, {"q", "quit"}}
	}
	return []key{{"enter", "check the key"}, {"esc", "back"}, {"ctrl+c", "quit"}}
}
