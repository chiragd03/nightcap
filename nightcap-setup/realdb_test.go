package main

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Against a real Postgres, when PG_TEST_URL names one (a superuser's, on a throwaway server):
// a database made here, its user with a password full of characters that mean something in an
// address. Skipped otherwise.
func TestRealDatabase(t *testing.T) {
	admin := os.Getenv("PG_TEST_URL")
	if admin == "" {
		t.Skip("PG_TEST_URL not set")
	}
	ctx := context.Background()
	c, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	for _, q := range []string{
		"DROP DATABASE IF EXISTS nc_fresh", "DROP DATABASE IF EXISTS nc_old", "DROP ROLE IF EXISTS nc",
		"CREATE ROLE nc LOGIN PASSWORD 'Pa#ss@1/x?'", "CREATE DATABASE nc_fresh OWNER nc", "CREATE DATABASE nc_old OWNER nc",
	} {
		if _, err := c.Exec(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	u, _ := url.Parse(admin)
	host := u.Host
	typed := func(db, pass string) string {
		return "postgresql://nc:" + pass + "@" + host + "/" + db + "?sslmode=disable"
	}

	// An old one: Nightcap's tables with a household in it, and one table that isn't Nightcap's.
	old, err := pgx.Connect(ctx, normalizeURL(typed("nc_old", "Pa#ss@1/x?")))
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		"CREATE TABLE accounts (id int)", "CREATE TABLE profiles (id int)", "CREATE TABLE addon_cache (id int)",
		"INSERT INTO accounts VALUES (1), (2)", "INSERT INTO profiles VALUES (1), (2), (3)",
	} {
		if _, err := old.Exec(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	old.Close(ctx)

	r := checkDatabase(typed("nc_fresh", "Pa#ss@1/x?")) // typed as it is, not encoded
	if !r.ok || r.households != -1 || r.pgcrypto != "available" || r.version == "" {
		t.Errorf("fresh: %+v", r)
	}
	r = checkDatabase(typed("nc_old", "Pa#ss@1/x?"))
	if !r.ok || r.households != 2 || r.profiles != 3 || r.others != 1 {
		t.Errorf("old: %+v", r)
	}
	for name, c := range map[string]struct{ url, want string }{
		"wrong password": {typed("nc_fresh", "nope"), "password is wrong"},
		"no database":    {typed("nc_missing", "Pa#ss@1/x?"), "doesn't exist"},
		"nobody there":   {"postgresql://nc:x@" + strings.Split(host, ":")[0] + ":1/db?sslmode=disable", "Nothing answered"},
		"no such host":   {"postgresql://nc:x@no-such-host.invalid:5432/db", "Couldn't find the host"},
	} {
		r := checkDatabase(c.url)
		if r.ok || !strings.Contains(r.problem, c.want) {
			t.Errorf("%s: %q (%s), want %q", name, r.problem, r.advice, c.want)
		}
		if strings.Contains(r.problem+r.advice, "Pa#ss") {
			t.Errorf("%s: the password is in the message", name)
		}
	}
}
