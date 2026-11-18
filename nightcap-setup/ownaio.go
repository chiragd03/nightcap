package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// A server with Nightcap's own stream finder (AIOStreams) is told its address by a setting,
// OWN_AIOSTREAMS_URL, and starts households from its built-in setup. An owner can give it a setup of
// their own instead (nightcap template): one row in its database (own_aiostreams, the template only),
// read within 5 minutes, without a restart; taking the row out goes back to the built-in one.

// ownAIOAddress is the address the server reaches its own AIOStreams at.
func (b bundle) ownAIOAddress() string {
	switch b.plan.where {
	case "cloudrun":
		return "http://localhost:3000" // (a sidecar)
	case "kubernetes":
		_, aio, _, _ := b.kubeNames()
		return "http://" + aio + ":3000"
	}
	return b.aioURL()
}

// templateSQL puts an owner's [template] in (or changes it), as one statement any Postgres client
// can run.
func templateSQL(template []byte) string {
	tag := "tmpl"
	for strings.Contains(string(template), "$"+tag+"$") {
		tag += "x"
	}
	return fmt.Sprintf("INSERT INTO own_aiostreams (template) VALUES ($%s$%s$%s$::jsonb)\n"+
		"ON CONFLICT (one) DO UPDATE SET template = EXCLUDED.template, updated_at = now();\n", tag, template, tag)
}

// noTemplateSQL takes an owner's template out: the server's built-in one is used again.
const noTemplateSQL = "DELETE FROM own_aiostreams;"

// checkTemplate is whether [data] is a setup: a JSON object.
func checkTemplate(data []byte) error {
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil || len(v) == 0 {
		return errors.New("that isn't a household setup (an AIOStreams export: a JSON object)")
	}
	return nil
}

// sqlTarget is how a server's database is reached from here: directly, or (a database the tool made,
// reached only next to it) through Docker Compose or kubectl.
type sqlTarget struct {
	url                    string // reached directly
	composeDir             string // the "db" service of the Compose project in this folder
	kubeContext, namespace string // with statefulset: the cluster's database pod
	statefulset            string
}

// run runs [sql] on the database.
func (t sqlTarget) run(ctx context.Context, sql string) error {
	err := t.runOnce(ctx, sql)
	if err != nil && ctx.Err() != nil {
		return fmt.Errorf("the database didn't answer in time: %w", err)
	}
	if err != nil && strings.Contains(err.Error(), "own_aiostreams") && strings.Contains(err.Error(), "does not exist") {
		return errors.New("the server hasn't made its table for an owner's setup: is it running, and the newest version?")
	}
	return err
}

func (t sqlTarget) runOnce(ctx context.Context, sql string) error {
	psql := []string{"psql", "-U", dbUser, "-d", dbName, "-v", "ON_ERROR_STOP=1", "-q"}
	var cmd *exec.Cmd
	switch {
	case t.composeDir != "":
		cmd = exec.CommandContext(ctx, "docker", append([]string{"compose", "exec", "-T", "db"}, psql...)...)
		cmd.Dir = t.composeDir
	case t.statefulset != "":
		args := []string{"-n", t.namespace, "exec", "-i", "statefulset/" + t.statefulset, "--"}
		if t.kubeContext != "" {
			args = append([]string{"--context", t.kubeContext}, args...)
		}
		cmd = exec.CommandContext(ctx, "kubectl", append(args, psql...)...)
	default:
		conn, err := pgx.Connect(ctx, normalizeURL(t.url))
		if err != nil {
			return fmt.Errorf("couldn't reach the database: %s", scrub(err.Error()))
		}
		defer conn.Close(context.Background())
		if _, err := conn.Exec(ctx, sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			return errors.New(scrub(err.Error()))
		}
		return nil
	}
	cmd.Stdin = strings.NewReader(sql)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		// (psql's own line, not a warning of docker's or kubectl's before it)
		msg := firstLine(strings.TrimSpace(out.String()))
		for _, l := range strings.Split(out.String(), "\n") {
			if strings.Contains(l, "ERROR:") || strings.Contains(l, "FATAL:") {
				msg = strings.TrimSpace(l)
				break
			}
		}
		if msg == "" {
			msg = err.Error()
		}
		return errors.New(scrub(msg))
	}
	return nil
}

// savedTarget is where a saved server with Nightcap's own stream finder keeps its database (from
// the files it was set up with).
func savedTarget(s savedServer) (sqlTarget, error) {
	if s.OwnAIO == "" {
		return sqlTarget{}, errors.New("it was set up without Nightcap's own stream finder")
	}
	dbURL, err := savedDBURL(s)
	if err != nil {
		return sqlTarget{}, err
	}
	u, err := url.Parse(normalizeURL(dbURL))
	if err != nil {
		return sqlTarget{}, errors.New("its files don't say where its database is")
	}
	host := u.Hostname()
	switch {
	case s.Where == "kubernetes" && host == s.Slug+"-db":
		return sqlTarget{kubeContext: s.Context, namespace: s.Namespace, statefulset: host}, nil
	case s.Where == "docker" && host == "db":
		return sqlTarget{composeDir: s.Dir}, nil
	}
	return sqlTarget{url: dbURL}, nil
}

// savedDBURL is a saved server's database address, from the files it was set up with.
func savedDBURL(s savedServer) (string, error) {
	file := "nightcap.env"
	if s.Where == "kubernetes" {
		file = "secret.yaml"
	}
	data, err := os.ReadFile(filepath.Join(s.Dir, file))
	if err != nil {
		return "", fmt.Errorf("its files aren't in %s any more", tildePath(s.Dir))
	}
	for _, l := range strings.Split(string(data), "\n") {
		l = strings.TrimSpace(l)
		if v, ok := strings.CutPrefix(l, "DATABASE_URL: "); ok && file == "secret.yaml" {
			var out string
			if json.Unmarshal([]byte(v), &out) == nil { // (written as JSON strings: & is \u0026)
				return out, nil
			}
			return unquoteEnv(v), nil
		}
		if v, ok := strings.CutPrefix(l, "DATABASE_URL="); ok {
			return unquoteEnv(v), nil
		}
	}
	return "", errors.New("its files don't say where its database is")
}

// unquoteEnv undoes quoteEnv (and a YAML string's quotes).
func unquoteEnv(v string) string {
	v = strings.TrimSpace(v)
	switch {
	case len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'':
		return v[1 : len(v)-1]
	case len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"':
		return strings.NewReplacer(`\\`, `\`, `\"`, `"`, "$$", "$").Replace(v[1 : len(v)-1])
	}
	return v
}

// putTemplate gives a saved server's households [template] to start from, or (none) the server's
// built-in one again.
func putTemplate(s savedServer, template []byte) error {
	if s.Where == "files" {
		return errors.New("it's on another machine: change it there")
	}
	sql := noTemplateSQL
	if template != nil {
		if err := checkTemplate(template); err != nil {
			return err
		}
		sql = templateSQL(template)
	}
	t, err := savedTarget(s)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	return t.run(ctx, sql)
}

// templateCommand is "nightcap template <server> [file]": a saved server's households start from the
// file's setup; with no file, from the server's built-in one again.
func templateCommand(args []string) error {
	if len(args) < 1 || len(args) > 2 {
		return errors.New(`usage: nightcap template "<server name>" [setup.json]   (no file: back to the server's built-in setup)`)
	}
	list, err := loadServers()
	if err != nil {
		return err
	}
	var file []byte
	if len(args) == 2 {
		if file, err = os.ReadFile(args[1]); err != nil {
			return err
		}
	}
	var found []savedServer
	for _, s := range list {
		if strings.EqualFold(s.Name, args[0]) || s.Slug == args[0] {
			found = append(found, s)
		}
	}
	switch len(found) {
	case 0:
		return fmt.Errorf("no server called %q here", args[0])
	case 1:
	default:
		return fmt.Errorf("%d servers are called %q: give its short name (%s or %s)", len(found), args[0], found[0].Slug, found[1].Slug)
	}
	if err := putTemplate(found[0], file); err != nil {
		return err
	}
	found[0].OwnTemplate = file != nil
	if err := saveServer(found[0]); err != nil {
		return err
	}
	if file == nil {
		fmt.Println("Done. " + found[0].Name + " uses its built-in setup again within 5 minutes.")
	} else {
		fmt.Println("Done. " + found[0].Name + " uses this setup within 5 minutes.")
	}
	return nil
}

// forgetOwnAIO is how to take an owner's setup out of a database that outlives the server (one given
// by its address), so a server set up on it later starts from its own built-in one: only one put in
// from here, and only if no other server here uses that database. nil when there's nothing to do.
func forgetOwnAIO(s savedServer) func() {
	if !s.OwnTemplate {
		return nil // (none put in from here: one there is someone else's)
	}
	t, err := savedTarget(s)
	if err != nil || t.url == "" {
		return nil // (none; or a database made with it, removed with it)
	}
	list, _ := loadServers()
	for _, other := range list {
		if other.Dir == s.Dir {
			continue
		}
		if u, err := savedDBURL(other); err == nil && dbIdentity(u) == dbIdentity(t.url) {
			return nil // (another server of these uses it: its setup stays)
		}
	}
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = t.runOnce(ctx, noTemplateSQL)
	}
}
