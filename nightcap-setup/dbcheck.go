package main

import (
	"context"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Checking a database before anything is made on it: that it answers, its version, that it has
// pgcrypto (Nightcap keeps households' keys encrypted with it), and whether Nightcap's data is
// there already (then it's kept and brought up to date) or other tables are (Nightcap's household
// export allows only its own in the public schema). Nothing is changed. The password is never
// shown or written anywhere.

type dbReport struct {
	ok          bool
	version     string // "16.4"
	pgcrypto    string // "installed", "available", or "" when it can't be had
	households  int    // Nightcap's data already there (-1: none, or couldn't be counted)
	hasNightcap bool   // Nightcap's tables are there
	profiles    int
	others      int    // other tables in the public schema
	problem     string // what went wrong, in plain words ("" when ok)
	advice      string // what to try
}

const dbTimeout = 12 * time.Second

// normalizeURL makes a connection string usable as typed: a password with characters that mean
// something in an address ("#", "@", "/", "?") is percent-encoded, as Postgres's own tools expect.
// "postgres://" and "postgresql://" both work; one without a scheme gets "postgresql://".
func normalizeURL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return s
	}
	if !strings.Contains(s, "://") {
		s = "postgresql://" + s
	}
	scheme, rest, _ := strings.Cut(s, "://")
	at := strings.LastIndex(rest, "@")
	if at < 0 {
		return s
	}
	userinfo, hostpart := rest[:at], rest[at+1:]
	user, pass, hasPass := strings.Cut(userinfo, ":")
	// (Already encoded, "%23": taken as it is; otherwise as typed.)
	if u, err := url.PathUnescape(user); err == nil {
		user = u
	}
	if p, err := url.PathUnescape(pass); err == nil {
		pass = p
	}
	info := url.User(user)
	if hasPass {
		info = url.UserPassword(user, pass)
	}
	return scheme + "://" + info.String() + "@" + hostpart
}

// where tells, for showing: "db.example.com:5432/nightcap" (never the user or password).
func dbWhere(raw string) string {
	u, err := url.Parse(normalizeURL(raw))
	if err != nil || u.Host == "" {
		return "the database"
	}
	return u.Host + u.Path
}

// maskURL shows a connection string with its password as dots, one for each character, so a
// cursor on it stays where it is in the text.
func maskURL(raw string) string {
	scheme := strings.Index(raw, "://")
	start := 0
	if scheme >= 0 {
		start = scheme + 3
	}
	at := strings.LastIndex(raw, "@")
	if at <= start {
		return raw
	}
	colon := strings.Index(raw[start:at], ":")
	if colon < 0 {
		return raw
	}
	p0 := start + colon + 1
	return raw[:p0] + strings.Repeat("•", len([]rune(raw[p0:at]))) + raw[at:]
}

// checkDatabase connects and looks, changing nothing.
func checkDatabase(raw string) dbReport {
	r := dbReport{households: -1}
	cfg, err := pgx.ParseConfig(normalizeURL(raw))
	if err != nil {
		r.problem = "That isn't a connection string Postgres understands."
		r.advice = "It looks like postgresql://user:password@host:5432/database"
		return r
	}
	ctx, cancel := context.WithTimeout(context.Background(), dbTimeout)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		r.problem, r.advice = explain(err, cfg.Host)
		return r
	}
	defer conn.Close(context.Background())

	var full string
	if err := conn.QueryRow(ctx, "SHOW server_version").Scan(&full); err == nil {
		r.version, _, _ = strings.Cut(full, " ")
	}
	var installed, available bool
	_ = conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'),
	                               EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgcrypto')`).Scan(&installed, &available)
	switch {
	case installed:
		r.pgcrypto = "installed"
	case available:
		r.pgcrypto = "available"
	}
	var hasNightcap bool
	_ = conn.QueryRow(ctx, "SELECT to_regclass('public.accounts') IS NOT NULL AND to_regclass('public.profiles') IS NOT NULL").Scan(&hasNightcap)
	r.hasNightcap = hasNightcap
	if hasNightcap {
		_ = conn.QueryRow(ctx, "SELECT (SELECT count(*) FROM accounts), (SELECT count(*) FROM profiles)").Scan(&r.households, &r.profiles)
	}
	var tables []string
	if rows, err := conn.Query(ctx, `SELECT table_name FROM information_schema.tables
	                                 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`); err == nil {
		for rows.Next() {
			var t string
			if rows.Scan(&t) == nil {
				tables = append(tables, t)
			}
		}
		rows.Close()
	}
	for _, t := range tables {
		if !nightcapTables[t] {
			r.others++
		}
	}
	if r.pgcrypto == "" {
		r.problem = "This Postgres doesn't have pgcrypto, which Nightcap needs."
		r.advice = "Most hosts have it (Supabase, Neon, the official Postgres image). Ask yours to add it."
		return r
	}
	r.ok = true
	return r
}

// The tables Nightcap makes, so ones that aren't its own can be told apart.
var nightcapTables = map[string]bool{}

func init() {
	for _, t := range strings.Fields(`accounts account_secrets profiles devices library episode_watched watch_events
		interactions ratings not_interested prompts recent_searches recommendations row_stats sent_links titles episodes
		lookups tv_requests admin_sessions play_links wrong_tries invites ai_usage source_failures`) {
		nightcapTables[t] = true
	}
}

// explain turns a connection error into plain words, and what to try.
func explain(err error, host string) (string, string) {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "28P01", "28000":
			return "The database said the user or password is wrong.", "Check the password, and that this user may connect."
		case "3D000":
			return "That database doesn't exist on this server.", "Check the name at the end of the connection string."
		case "53300":
			return "The database has too many connections open.", "Try again in a minute, or use the host's pooler address."
		}
		return "The database said: " + scrub(pg.Message), ""
	}
	msg := err.Error()
	var dns *net.DNSError
	switch {
	case errors.As(err, &dns) || strings.Contains(msg, "no such host"):
		return "Couldn't find the host " + host + ".", "Check the address for a typo, and that this computer is online."
	case strings.Contains(msg, "connection refused"):
		return "Nothing answered at " + host + ".", "Check the host and port, and that Postgres is running there."
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(msg, "timeout") || strings.Contains(msg, "i/o timeout"):
		return "The database didn't answer in time.", "It may be off, asleep, or blocked by a firewall from this computer."
	case strings.Contains(msg, "tls") || strings.Contains(msg, "SSL"):
		return "The secure connection didn't work.", "Try adding ?sslmode=require (or sslmode=disable for a database at home)."
	}
	return "Couldn't connect.", scrub(firstLine(msg))
}

// scrub takes out anything that may be a password from an error's text.
func scrub(s string) string {
	s = userinfo.ReplaceAllString(s, "${1}${2}:•••@")
	return passwordValue.ReplaceAllString(s, "${1}•••")
}

// (A password in an address, and a password= setting: what scrub takes out.)
var (
	userinfo      = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)([^/\s:@]*):[^@\s/]*@`)
	passwordValue = regexp.MustCompile(`(?i)(password=)[^\s&]+`)
)

func firstLine(s string) string {
	l, _, _ := strings.Cut(s, "\n")
	return l
}

// hasHouseholds: Nightcap's households are there (or its tables, and they couldn't be counted):
// their saved keys need the secrets key that locked them.
func (r dbReport) hasHouseholds() bool { return r.hasNightcap && r.households != 0 }

// plainText takes terminal control codes out of text that came from elsewhere (logs, a server's
// answers), so none can move the cursor, set the title or reach the clipboard.
func plainText(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || r >= 0x20 && r != 0x7f && !(r >= 0x80 && r < 0xa0) {
			return r
		}
		return -1
	}, s)
}
