package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Nightcap on Google Cloud Run: one service, the server and (if wanted) its own AIOStreams beside
// it as a sidecar, reached by the server at localhost and by nothing else. It scales to nothing
// when no one's watching, and to one copy at most (that also caps the cost). Public, with Cloud
// Run's own sign-in check off (the apps do their own: device keys, the admin PIN, the owner key);
// that works under a company's "domain restricted sharing" policy too. Its settings are plain
// values, not Google's Secret Manager (whose free allowance is shared by every project on a
// billing account). Cloud Run has no disk: AIOStreams keeps its setups in the same Postgres, as its
// own user in its own schema, unable to read Nightcap's tables.

// cloudState is what setting up on Google Cloud has made so far: kept on the deployer, so trying
// again from a failed step has it.
type cloudState struct {
	api     runAPI
	number  string // the project's number
	aioDB   string // AIOStreams' database address
	svc     map[string]any
	gen     float64 // the service's generation, as sent
	sent    bool    // the service was sent (by this setup): one by its name is its own
	aioRole string  // AIOStreams' database user, made by this setup
}

// cloudPlan is where in Google Cloud (as which Google account): the project (a new one, made on the last step), its billing
// account, and the region.
type cloudPlan struct {
	account     string
	project     string
	newProject  bool
	billing     string // the billing account's ID, for a new project
	billingName string
	region      string
}

// The AIOStreams Google Cloud runs: the same pinned build, from Docker Hub (Cloud Run can't take ghcr.io's).
const cloudAIOImage = aioImage

// cloudServiceName is the service's name: Cloud Run's names start with a letter, 49 at most.
func cloudServiceName(slug string) string {
	if slug == "" || slug[0] < 'a' || slug[0] > 'z' {
		slug = "nightcap-" + slug
	}
	if len(slug) > 49 {
		slug = strings.TrimRight(slug[:49], "-")
	}
	return slug
}

// cloudPublicURL is the address Cloud Run gives a service, worked out ahead (from the project's
// number), so the server knows it from its first start.
func cloudPublicURL(service, projectNumber, region string) string {
	return fmt.Sprintf("https://%s-%s.%s.run.app", service, projectNumber, region)
}

// aioRole is AIOStreams' own database user (and schema), one for each server.
func aioRole(slug string) string {
	return "aiostreams_" + strings.ReplaceAll(slug, "-", "_")
}

// aioDatabaseURI is the database's address for AIOStreams: the same database, as its own user.
// (Supabase's pooler names a user with the project after a dot, postgres.abcd: the same is kept.)
func aioDatabaseURI(mainURL, role, password string) (string, error) {
	u, err := url.Parse(normalizeURL(mainURL))
	if err != nil || u.User == nil {
		return "", fmt.Errorf("the database's address isn't one AIOStreams can use")
	}
	user := role
	if _, rest, ok := strings.Cut(u.User.Username(), "."); ok {
		user += "." + rest
	}
	u.User = url.UserPassword(user, password)
	return u.String(), nil
}

// freeAIORole is [base], or base_2, base_3… : the first no database user has yet.
func freeAIORole(ctx context.Context, dbURL, base string) (string, error) {
	conn, err := pgx.Connect(ctx, normalizeURL(dbURL))
	if err != nil {
		return "", fmt.Errorf("couldn't reach the database: %s", scrub(err.Error()))
	}
	defer conn.Close(context.Background())
	for i := 1; i < 100; i++ {
		role := base
		if i > 1 {
			role = fmt.Sprintf("%s_%d", base, i)
		}
		var exists bool
		if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", role).Scan(&exists); err != nil {
			return "", fmt.Errorf("couldn't look at the database's users: %s", scrub(err.Error()))
		}
		if !exists {
			return role, nil
		}
	}
	return "", fmt.Errorf("couldn't find a free name for the stream finder's database user")
}

// makeAIODatabase makes (or keeps, with a new password) AIOStreams' own user and schema in the
// database: it can log in, owns its schema and works there, and has no rights on Nightcap's.
func makeAIODatabase(ctx context.Context, mainURL, role, password string) error {
	conn, err := pgx.Connect(ctx, normalizeURL(mainURL))
	if err != nil {
		return fmt.Errorf("couldn't reach the database: %s", scrub(err.Error()))
	}
	defer conn.Close(context.Background())
	id := pgx.Identifier{role}.Sanitize()
	pw := "'" + strings.ReplaceAll(password, "'", "''") + "'"
	var exists bool
	if err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", role).Scan(&exists); err != nil {
		return fmt.Errorf("couldn't look at the database's users: %s", scrub(err.Error()))
	}
	create := "CREATE ROLE " + id + " LOGIN PASSWORD " + pw
	if exists {
		create = "ALTER ROLE " + id + " LOGIN PASSWORD " + pw
	}
	if _, err := conn.Exec(ctx, create); err != nil {
		return fmt.Errorf("your database user can't make another user (%s): use a database you own, or skip the stream finder", scrub(err.Error()))
	}
	// (Supabase's main user isn't a superuser: it has to be in the role to make a schema for it.)
	_, _ = conn.Exec(ctx, "GRANT "+id+" TO CURRENT_USER")
	for _, sql := range []string{
		"CREATE SCHEMA IF NOT EXISTS " + id + " AUTHORIZATION " + id,
		"ALTER ROLE " + id + " SET search_path = " + id,
	} {
		if _, err := conn.Exec(ctx, sql); err != nil {
			return fmt.Errorf("couldn't make AIOStreams' place in the database: %s", scrub(err.Error()))
		}
	}
	return nil
}

// reachableFromGoogle says whether Google's machines could reach a database at [host]: not one on
// this computer or a home network.
func reachableFromGoogle(host string) bool {
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".local") || !strings.Contains(host, ".") && net.ParseIP(host) == nil {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		_, cgnat, _ := net.ParseCIDR("100.64.0.0/10") // (Tailscale, carrier-grade NAT)
		return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || cgnat.Contains(ip))
	}
	return true
}

// withTLS adds sslmode=require to a database address that doesn't say (Google's machines reach it
// over the internet).
func withTLS(raw string) string {
	u, err := url.Parse(normalizeURL(raw))
	if err != nil || u.Query().Get("sslmode") != "" {
		return raw
	}
	q := u.Query()
	q.Set("sslmode", "require")
	u.RawQuery = q.Encode()
	return u.String()
}

// cloudService is the service as Cloud Run's API takes it. [server] and [aio] are the images, by
// digest; [aioDB], AIOStreams' database address.
func (b bundle) cloudService(service, server, aio, publicURL, aioDB string) map[string]any {
	env := func(kv ...[2]string) []any {
		var out []any
		for _, x := range kv {
			out = append(out, map[string]any{"name": x[0], "value": x[1]})
		}
		return out
	}
	var serverEnv [][2]string
	for _, kv := range b.serverEnv() {
		switch kv[0] {
		case "PORT", "PUBLIC_URL": // (Cloud Run gives the port; the address is below)
			continue
		case "DATABASE_URL":
			kv[1] = withTLS(kv[1])
		}
		serverEnv = append(serverEnv, kv)
	}
	serverEnv = append(serverEnv, [2]string{"TRUSTED_PROXY", "1"}, [2]string{"PUBLIC_URL", publicURL})
	containers := []any{map[string]any{
		"name":      "server",
		"image":     server,
		"ports":     []any{map[string]any{"containerPort": 8080}},
		"resources": map[string]any{"limits": map[string]any{"cpu": "1", "memory": "768Mi"}},
		"env":       env(serverEnv...),
	}}
	if b.plan.keys.ownAIO {
		aioEnv := [][2]string{{"PORT", "3000"}, {"BASE_URL", "http://localhost:3000"},
			{"PROVIDE_STREAM_DATA", "true"}, {"REGEX_FILTER_ACCESS", "all"}, {"SEL_SYNC_ACCESS", "all"},
			{"MAX_ADDONS", "30"}, {"ANIME_DB_LEVEL_OF_DETAIL", "required"},
			{"SECRET_KEY", b.aioKey}, {"DATABASE_URI", aioDB}}
		for _, kv := range b.composeEnv() {
			if strings.HasPrefix(kv[0], "AIOSTREAMS_TMDB_") {
				aioEnv = append(aioEnv, [2]string{strings.TrimPrefix(kv[0], "AIOSTREAMS_"), kv[1]})
			}
		}
		containers = append(containers, map[string]any{
			"name":      "aiostreams",
			"image":     aio,
			"resources": map[string]any{"limits": map[string]any{"cpu": "0.5", "memory": "768Mi"}},
			"env":       env(aioEnv...),
		})
	}
	return map[string]any{
		"apiVersion": "serving.knative.dev/v1",
		"kind":       "Service",
		"metadata": map[string]any{
			"name":      service,
			"namespace": b.plan.cloud.project,
			"labels":    map[string]any{"made-by": "nightcap-setup"},
			"annotations": map[string]any{
				"run.googleapis.com/launch-stage": "GA",
				// Public: the apps sign in their own way (see the top of this file).
				"run.googleapis.com/invoker-iam-disabled": "true",
			},
		},
		"spec": map[string]any{
			"template": map[string]any{
				"metadata": map[string]any{"annotations": map[string]any{
					// At most one copy (it caps the cost too), none when no one's watching.
					"autoscaling.knative.dev/maxScale": "1",
					"autoscaling.knative.dev/minScale": "0",
					// More CPU while starting, so a first request after a quiet spell is quick.
					"run.googleapis.com/startup-cpu-boost": "true",
				}},
				"spec": map[string]any{
					"containerConcurrency": 80,
					"timeoutSeconds":       600, // (a Home refresh can take a couple of minutes)
					"containers":           containers,
				},
			},
		},
	}
}

func (b bundle) cloudReadme(service string) string {
	c := b.plan.cloud
	var s strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	w("# %s", b.plan.settings.name)
	w("")
	w("A Nightcap server on Google Cloud Run, made by nightcap-setup.")
	w("")
	w("- Project: %s, region %s (%s), service %s.", c.project, c.region, regionName(c.region), service)
	w("- Its settings and keys are in service.json and nightcap.env here: keep them private.")
	w("- It scales to nothing when no one's watching, and to one copy at most.")
	w("")
	w("Manage it with the nightcap command (Manage your servers), or in Google's console:")
	w("https://console.cloud.google.com/run/detail/%s/%s?project=%s", c.region, service, c.project)
	return s.String()
}

func jsonIndent(v any) string {
	data, _ := json.MarshalIndent(v, "", "  ")
	return string(data) + "\n"
}
