package main

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/jackc/pgx/v5"
)

// A database that already has Nightcap's households: their saved keys, TV links and invites are
// locked with the secrets key of the server that made them. A new key would leave them all
// unreadable, so that server's key is asked for (filled in when a server on this list used the same
// database) and checked, read-only, by opening one saved value with it.

type secretsKeyScreen struct {
	form     form
	dbURL    string
	checking bool
	checked  string // the key found to work (or that there was nothing to check it on)
}

type secretsChecked struct {
	key  string
	ok   bool
	none bool // nothing saved yet to check it on
	why  string
}

func newSecretsKeyScreen(dbURL string) secretsKeyScreen {
	s := secretsKeyScreen{dbURL: dbURL}
	f := newText("Secrets key", "", knownSecretsKey(dbURL), "paste it here", true)
	f.status = "It's SECRETS_KEY in that server's nightcap.env (or secret.yaml)."
	f.input.Focus()
	f.input.CursorEnd()
	s.form.fields = []*field{f}
	return s
}

// knownSecretsKey is the secrets key of a server on this list that used the same database ("" if none).
func knownSecretsKey(dbURL string) string {
	want := dbIdentity(dbURL)
	list, _ := loadServers()
	for _, sv := range list {
		for _, f := range []string{"nightcap.env", "secret.yaml"} {
			data, err := os.ReadFile(filepath.Join(sv.Dir, f))
			if err != nil {
				continue
			}
			var db, key string
			for _, l := range strings.Split(string(data), "\n") {
				l = strings.TrimSpace(l)
				for _, sep := range []string{"=", ": "} {
					if v, ok := strings.CutPrefix(l, "DATABASE_URL"+sep); ok {
						db = strings.Trim(v, `'" `)
					}
					if v, ok := strings.CutPrefix(l, "SECRETS_KEY"+sep); ok {
						key = strings.Trim(v, `'" `)
					}
				}
			}
			if key != "" && db != "" && dbIdentity(db) == want {
				return key
			}
		}
	}
	return ""
}

// dbIdentity is a database's host and name, whoever connects to it.
func dbIdentity(raw string) string {
	u, err := url.Parse(normalizeURL(raw))
	if err != nil {
		return raw
	}
	return strings.ToLower(u.Hostname()) + "/" + strings.TrimPrefix(u.Path, "/")
}

func (s *secretsKeyScreen) check() tea.Cmd {
	key := s.form.fields[0].value()
	if key == "" || s.checking {
		return nil
	}
	s.checking = true
	f := s.form.fields[0]
	f.status, f.statusKind = "Checking it…", 0
	dbURL := s.dbURL
	return func() tea.Msg { return checkSecretsKey(dbURL, key) }
}

// checkSecretsKey opens one saved value with [key], changing nothing.
func checkSecretsKey(dbURL, key string) secretsChecked {
	r := secretsChecked{key: key}
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	conn, err := pgx.Connect(ctx, normalizeURL(dbURL))
	if err != nil {
		r.why = "Couldn't reach the database: " + scrub(err.Error())
		return r
	}
	defer conn.Close(context.Background())
	for _, q := range []string{
		"SELECT %s FROM account_secrets WHERE %s IS NOT NULL LIMIT 1",
		"SELECT %s FROM play_links WHERE %s IS NOT NULL LIMIT 1",
	} {
		cols := []string{"aiostreams_url", "subtitle_urls", "stream_urls", "ai_api_key", "debrid_keys", "aiostreams_setup", "livetv_urls"}
		if strings.Contains(q, "play_links") {
			cols = []string{"links"}
		}
		for _, c := range cols {
			var exists bool
			if conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2)",
				strings.Fields(q)[3], c).Scan(&exists); !exists {
				continue
			}
			var found []byte
			if err := conn.QueryRow(ctx, strings.ReplaceAll(q, "%s", c)).Scan(&found); err != nil {
				continue // (none saved in it)
			}
			var opened string
			if err := conn.QueryRow(ctx, "SELECT pgp_sym_decrypt($1::bytea, $2)", found, key).Scan(&opened); err != nil {
				r.why = "That key doesn't open its saved keys. Check it's that server's SECRETS_KEY."
				return r
			}
			r.ok = true
			return r
		}
	}
	r.ok, r.none = true, true // (nothing saved with a key yet: any key will do)
	return r
}

func (s *secretsKeyScreen) checkedMsg(m secretsChecked) bool {
	s.checking = false
	f := s.form.fields[0]
	if m.key != f.value() {
		return false
	}
	if !m.ok {
		f.status, f.statusKind = m.why, -1
		return false
	}
	s.checked = m.key
	if m.none {
		f.status, f.statusKind = "nothing saved with it yet: it's kept", 1
	} else {
		f.status, f.statusKind = "works: their saved keys open with it", 1
	}
	return true
}

func (s secretsKeyScreen) View(width int) string {
	return heading("This database already has households", "Paste the secrets key of the server that made them, so their saved keys keep working.") +
		s.form.fields[0].alone(width)
}

func (s secretsKeyScreen) keys() []key {
	return []key{{"enter", "check it"}, {"esc", "back"}, {"ctrl+c", "quit"}}
}
