package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// serverTable is the server's own definition of the table (from its schema.sql).
func serverTable(t *testing.T) string {
	data, err := os.ReadFile(os.Getenv("NIGHTCAP_SCHEMA"))
	if err != nil {
		t.Fatal("NIGHTCAP_SCHEMA: the server's schema.sql")
	}
	m := regexp.MustCompile(`(?s)CREATE TABLE IF NOT EXISTS own_aiostreams \(.*?\);`).FindString(string(data))
	if m == "" {
		t.Fatal("no own_aiostreams in schema.sql")
	}
	return m
}

// Against a real Postgres in Docker: an owner's setup put in through Compose, changed over a direct
// connection, then taken out (back to the server's built-in one).
func TestRealOwnAIO(t *testing.T) {
	if os.Getenv("NIGHTCAP_REAL_AIO") == "" {
		t.Skip("NIGHTCAP_REAL_AIO=1")
	}
	table := serverTable(t)
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(`name: nc-aio-test
services:
  db:
    image: postgres:16-alpine
    environment: {POSTGRES_USER: nightcap, POSTGRES_PASSWORD: pw, POSTGRES_DB: nightcap}
    ports: ["127.0.0.1:55499:5432"]
`), 0o644)
	compose := func(args ...string) (string, error) {
		cmd := exec.Command("docker", append([]string{"compose"}, args...)...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	if out, err := compose("up", "-d"); err != nil {
		t.Fatal(out)
	}
	defer compose("down", "-v")
	for i := 0; i < 60; i++ {
		if _, err := compose("exec", "-T", "db", "pg_isready", "-U", "nightcap", "-d", "nightcap"); err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	time.Sleep(2 * time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Before the server has made its table: said plainly.
	if err := (sqlTarget{composeDir: dir}).run(ctx, templateSQL(sampleTemplate)); err == nil || !strings.Contains(err.Error(), "hasn't made its table") {
		t.Errorf("no table: %v", err)
	}
	if out, err := compose("exec", "-T", "db", "psql", "-U", "nightcap", "-d", "nightcap", "-c", table); err != nil {
		t.Fatal("making the table:", out)
	}
	if err := (sqlTarget{composeDir: dir}).run(ctx, templateSQL(sampleTemplate)); err != nil {
		t.Fatal("through Compose:", err)
	}
	direct := "postgresql://nightcap:pw@127.0.0.1:55499/nightcap?sslmode=disable"
	conn, err := pgx.Connect(ctx, direct)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	count := func() int {
		var n int
		_ = conn.QueryRow(ctx, "SELECT count(*) FROM own_aiostreams").Scan(&n)
		return n
	}
	var same bool
	if err := conn.QueryRow(ctx, "SELECT template = $1::jsonb FROM own_aiostreams", string(sampleTemplate)).Scan(&same); err != nil || !same || count() != 1 {
		t.Errorf("read back: %v %v %d", same, err, count())
	}
	// Changed over a direct connection: still one row.
	if err := (sqlTarget{url: direct}).run(ctx, templateSQL([]byte(`{"services":[]}`))); err != nil || count() != 1 {
		t.Fatalf("direct: %v (%d rows)", err, count())
	}
	// Taken out: the server's built-in setup again.
	if err := (sqlTarget{url: direct}).run(ctx, noTemplateSQL); err != nil || count() != 0 {
		t.Errorf("taken out: %v (%d rows)", err, count())
	}
}

// On a real cluster: an owner's setup put in through kubectl exec on the database's StatefulSet.
func TestRealOwnAIOKube(t *testing.T) {
	ns := os.Getenv("NIGHTCAP_REAL_KUBE_NS")
	if ns == "" {
		t.Skip("NIGHTCAP_REAL_KUBE_NS=<a throwaway namespace>")
	}
	table := serverTable(t)
	kc := func(args ...string) string {
		out, err := exec.Command("kubectl", append([]string{"-n", ns}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("kubectl %v: %s", args, out)
		}
		return string(out)
	}
	cmd := exec.Command("kubectl", "-n", ns, "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(`apiVersion: apps/v1
kind: StatefulSet
metadata: {name: t-db}
spec:
  serviceName: t-db
  selector: {matchLabels: {app: t-db}}
  template:
    metadata: {labels: {app: t-db}}
    spec:
      containers:
      - name: db
        image: postgres:16-alpine
        env: [{name: POSTGRES_USER, value: nightcap}, {name: POSTGRES_PASSWORD, value: pw}, {name: POSTGRES_DB, value: nightcap}]
`)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	kc("rollout", "status", "statefulset/t-db", "--timeout=180s")
	for i := 0; i < 30; i++ {
		if _, err := exec.Command("kubectl", "-n", ns, "exec", "statefulset/t-db", "--", "pg_isready", "-U", "nightcap", "-d", "nightcap").CombinedOutput(); err == nil {
			break
		}
		time.Sleep(2 * time.Second)
	}
	time.Sleep(2 * time.Second)
	kc("exec", "statefulset/t-db", "--", "psql", "-U", "nightcap", "-d", "nightcap", "-c", table)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := (sqlTarget{namespace: ns, statefulset: "t-db"}).run(ctx, templateSQL(sampleTemplate)); err != nil {
		t.Fatal("through kubectl:", err)
	}
	out := kc("exec", "statefulset/t-db", "--", "psql", "-U", "nightcap", "-d", "nightcap", "-tAc",
		"SELECT jsonb_typeof(template) || ' ' || (SELECT count(*) FROM own_aiostreams) FROM own_aiostreams")
	if strings.TrimSpace(out) != "object 1" {
		t.Errorf("read back: %q", out)
	}
}
