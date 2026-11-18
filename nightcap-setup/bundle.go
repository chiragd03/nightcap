package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
)

// The files a server runs from, with Docker Compose, here or on any machine: docker-compose.yml
// (Postgres if it's made alongside, Nightcap's
// own AIOStreams if wanted, and the server), the server's settings and keys (nightcap.env) and
// Compose's (.env), both readable by their owner only, and a README.
//
// At home, the server is on the machine's own network ("host"), as TVs find it by a broadcast on
// the home network; the rest it reaches on 127.0.0.1. Docker Desktop (Mac, Windows) can't do
// that, so there the server's port is published instead, and TVs are given its address.

const (
	serverPortN = 7171
	// AIOStreams v2.37.0, pinned to its build (the digest wins over the tag): the server's built-in
	// household setup was made and tested on it, so it moves only after a new version is tested.
	aioImage = "docker.io/viren070/aiostreams:v2.37.0@sha256:bcfd8580695a50c8f464578a0e25af065f3bd17eac35ed82a733a18342ca9718"
)

// serverImage is the Nightcap server's image: NIGHTCAP_SERVER_IMAGE when set, else the default.
func serverImage() string {
	if img := strings.TrimSpace(os.Getenv("NIGHTCAP_SERVER_IMAGE")); img != "" {
		return img
	}
	return "docker.io/chiragdahiya3/nightcap:latest"
}

type bundle struct {
	slug    string
	plan    plan
	hostNet bool // the server on the machine's own network (at home, where Docker can do it)
	aioPort int  // AIOStreams on 127.0.0.1 (for a server on the host's network)
	aioKey  string
	image   string
}

// makeBundle lays out the files for [p]. [hostNetOK]: whether the machine it runs on can put a
// container on its own network (Linux; not Docker Desktop).
func makeBundle(p plan, hostNetOK bool) bundle {
	b := bundle{slug: slugFor(p.settings.name), plan: p, hostNet: p.mode == "home" && hostNetOK, image: serverImage()}
	b.aioPort = 3000
	if b.hostNet { // (on this computer's own network: one nothing else, the database included, has)
		for b.aioPort < 3100 && (!free(b.aioPort) || p.db.docker != nil && p.db.docker.port == b.aioPort) {
			b.aioPort++
		}
	}
	b.aioKey = hexSecret(32)
	return b
}

// hostNetHere: whether this computer's Docker can put a container on its own network.
func hostNetHere() bool {
	return runtime.GOOS == "linux" && !dockerDesktop()
}

// dockerDesktop: this computer's Docker is Docker Desktop (containers in a VM: its "host" network is
// the VM's, not this computer's). Asked once.
var dockerDesktop = sync.OnceValue(func() bool {
	out, _ := runQuiet("docker", "info", "--format", "{{.OperatingSystem}}")
	return strings.Contains(out, "Docker Desktop")
})

var notSlug = regexp.MustCompile(`[^a-z0-9]+`)

// slugFor is a name for files and Docker ("Nightcap at home": nightcap-at-home).
func slugFor(name string) string {
	s := strings.Trim(notSlug.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(s) > 40 { // (room for a -2, and for names made from it: <slug>-aiostreams-data…)
		s = strings.TrimRight(s[:40], "-")
	}
	if s == "" {
		return "nightcap"
	}
	return s
}

// databaseURL is the database's address for the server. (The server makes and updates its own
// tables when it starts.)
func (b bundle) databaseURL() string {
	d := b.plan.db.docker
	if d == nil {
		return b.plan.db.url
	}
	if b.hostNet {
		return d.url("127.0.0.1", d.port)
	}
	return d.url("db", 5432)
}

func (b bundle) aioURL() string {
	if b.hostNet {
		return fmt.Sprintf("http://127.0.0.1:%d", b.aioPort)
	}
	return "http://aiostreams:3000"
}

// serverEnv is the server's settings, in order. At home there's no PUBLIC_URL: a home server
// refuses to start with one (it's reached by whatever address the TV found it at).
func (b bundle) serverEnv() [][2]string {
	p := b.plan
	dbURL := b.databaseURL()
	env := [][2]string{
		{"MODE", p.mode}, {"SERVER_NAME", p.settings.name}, {"DEFAULT_COUNTRY", p.settings.country}, {"TZ", p.settings.timezone},
		{"PORT", fmt.Sprint(serverPortN)},
		{"DATABASE_URL", dbURL}, {"TMDB_API_KEY", p.keys.tmdb},
		{"SECRETS_KEY", p.keys.secretsKey}, {"OWNER_KEY", p.keys.ownerKey},
	}
	if p.keys.ownAIO {
		env = append(env, [2]string{"OWN_AIOSTREAMS_URL", b.ownAIOAddress()})
	}
	if p.mode == "cloud" && p.settings.address != "" {
		env = append(env, [2]string{"PUBLIC_URL", p.settings.address})
	}
	return env
}

// composeEnv is what docker-compose.yml takes from .env.
func (b bundle) composeEnv() [][2]string {
	var env [][2]string
	if d := b.plan.db.docker; d != nil {
		env = append(env, [2]string{"DB_PASSWORD", d.password})
	}
	if b.plan.keys.ownAIO {
		env = append(env, [2]string{"AIOSTREAMS_SECRET_KEY", b.aioKey})
		tmdb := "TMDB_API_KEY"
		if strings.HasPrefix(b.plan.keys.tmdb, "eyJ") {
			tmdb = "TMDB_ACCESS_TOKEN"
		}
		env = append(env, [2]string{"AIOSTREAMS_" + tmdb, b.plan.keys.tmdb})
	}
	return env
}

func envFile(title string, env [][2]string) string {
	var s strings.Builder
	s.WriteString("# " + title + "\n# Made by nightcap-setup. It holds keys: keep it private.\n")
	for _, kv := range env {
		s.WriteString(kv[0] + "=" + quoteEnv(kv[1]) + "\n")
	}
	return s.String()
}

// quoteEnv quotes a value for an env file as Docker Compose reads them: in single quotes, taken
// as it is (no variables, no escapes); one with a single quote in it, in double quotes.
func quoteEnv(v string) string {
	if v != "" && !strings.ContainsAny(v, " #\"'$\\`") {
		return v
	}
	if !strings.Contains(v, "'") {
		return "'" + v + "'"
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "$", "$$")
	return `"` + r.Replace(v) + `"`
}

func (b bundle) compose() string {
	var s strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	d := b.plan.db.docker
	w("# Nightcap: %s. Made by nightcap-setup.", b.plan.settings.name)
	w("# Start it: docker compose up -d     Stop it: docker compose down     Logs: docker compose logs -f server")
	w("name: %s", b.slug)
	w("")
	w("services:")
	if d != nil {
		w("  db:")
		w("    image: %s", d.image)
		w("    restart: unless-stopped")
		w("    environment:")
		w("      POSTGRES_USER: %s", dbUser)
		w("      POSTGRES_PASSWORD: ${DB_PASSWORD}")
		w("      POSTGRES_DB: %s", dbName)
		w("    volumes:")
		w("      - db-data:/var/lib/postgresql/data")
		w("    ports:")
		w("      - \"127.0.0.1:%d:5432\"   # this machine only", d.port)
		w("    healthcheck:")
		w("      test: [\"CMD-SHELL\", \"pg_isready -U %s -d %s\"]", dbUser, dbName)
		w("      interval: 2s")
		w("      retries: 30")
		w("")
	}
	if b.plan.keys.ownAIO {
		w("  aiostreams:")
		w("    image: %s", aioImage)
		w("    restart: unless-stopped")
		w("    environment:")
		w("      PORT: \"3000\"")
		w("      BASE_URL: %s", b.aioURL())
		w("      SECRET_KEY: ${AIOSTREAMS_SECRET_KEY}")
		for _, kv := range b.composeEnv() {
			if strings.HasPrefix(kv[0], "AIOSTREAMS_TMDB_") {
				w("      %s: ${%s}", strings.TrimPrefix(kv[0], "AIOSTREAMS_"), kv[0])
			}
		}
		w("      PROVIDE_STREAM_DATA: \"true\"")
		w("      REGEX_FILTER_ACCESS: all")
		w("      SEL_SYNC_ACCESS: all")
		w("      MAX_ADDONS: \"30\"")
		w("      ANIME_DB_LEVEL_OF_DETAIL: required")
		w("    volumes:")
		w("      - aiostreams-data:/app/data")
		if b.hostNet {
			w("    ports:")
			w("      - \"127.0.0.1:%d:3000\"   # for the server, on this machine", b.aioPort)
		}
		w("")
	}
	w("  server:")
	w("    image: %s", b.image)
	w("    platform: linux/amd64   # its only build so far: ARM machines (Apple Silicon, a Pi) run it translated")
	w("    restart: unless-stopped")
	w("    env_file: nightcap.env")
	if b.hostNet {
		w("    network_mode: host   # TVs on the home network find it by a broadcast")
	} else {
		w("    ports:")
		w("      - \"%d:%d\"", serverPortN, serverPortN)
	}
	if d != nil || b.plan.keys.ownAIO {
		w("    depends_on:")
	}
	if d != nil {
		w("      db:")
		w("        condition: service_healthy")
	}
	if b.plan.keys.ownAIO {
		w("      aiostreams:")
		w("        condition: service_started")
	}
	if d != nil || b.plan.keys.ownAIO {
		w("")
		w("volumes:")
		if d != nil {
			w("  db-data:")
		}
		if b.plan.keys.ownAIO {
			w("  aiostreams-data:")
		}
	}
	return s.String()
}

func (b bundle) readme() string {
	p := b.plan
	var s strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	w("# %s", p.settings.name)
	w("")
	w("A Nightcap server, made by nightcap-setup. Everything it needs is in this folder.")
	w("")
	w("## Run it")
	w("")
	w("On any machine with Docker (Linux, a VM, a NAS, Portainer…): copy this folder there, then")
	w("")
	w("    docker compose up -d")
	w("")
	w("The server sets up its database's tables itself when it starts, on port %d.", serverPortN)
	w("")
	w("    docker compose logs -f server    # what it's doing")
	w("    docker compose pull && docker compose up -d    # a newer version")
	w("    docker compose down              # stop it (the data stays)")
	w("")
	w("## Keys")
	w("")
	w("`nightcap.env` and `.env` hold the server's keys: keep them private (only you can read them).")
	w("The owner key (`OWNER_KEY`) signs in to the owner page, `/app/server`. Keep the secrets key")
	w("(`SECRETS_KEY`): without it, households' saved sources can't be read.")
	if p.mode == "home" {
		w("")
		w("## TVs")
		w("")
		if b.hostNet {
			w("On Linux, Android TVs on the same network find the server by themselves; Samsung and LG type")
			w("its address once, http://<this machine>:%d. Elsewhere (Docker Desktop on a Mac or Windows)", serverPortN)
			w("give every TV that address.")
		} else {
			w("Give the TVs its address, http://<this machine>:%d (Docker Desktop can't let them find it).", serverPortN)
		}
	} else {
		w("")
		w("## Address")
		w("")
		w("It answers on port %d; put it behind https at %s (Caddy, nginx, Cloudflare Tunnel…).", serverPortN, p.settings.address)
	}
	return s.String()
}

// write puts the files in [dir] (made if needed), the ones with keys readable by their owner only.
func (b bundle) write(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	type file struct {
		name, body string
		mode       os.FileMode
	}
	files := []file{
		{"docker-compose.yml", b.compose(), 0o644},
		{"nightcap.env", envFile("The Nightcap server's settings and keys.", b.serverEnv()), 0o600},
		{".env", envFile("What docker-compose.yml takes in (passwords and keys).", b.composeEnv()), 0o600},
		{"README.md", b.readme(), 0o644},
	}
	if b.plan.where == "kubernetes" {
		files = []file{
			{"kubernetes.yaml", b.kubernetes(), 0o644},
			{"secret.yaml", b.kubeSecret(), 0o600},
			{"README.md", b.kubeReadme(), 0o644},
		}
	}
	for _, f := range files {
		path := filepath.Join(dir, f.name)
		if err := os.WriteFile(path, []byte(f.body), f.mode); err != nil {
			return err
		}
		if err := os.Chmod(path, f.mode); err != nil { // (an existing file keeps its mode otherwise)
			return err
		}
	}
	return nil
}

func hexSecret(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (b bundle) kubeReadme() string {
	k := b.plan.kube
	_, _, server, _ := b.kubeNames()
	var s strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	w("# %s", b.plan.settings.name)
	w("")
	w("A Nightcap server on Kubernetes, made by nightcap-setup: everything is named %s-…, in the", b.slug)
	w("%s namespace, labelled app.kubernetes.io/instance=%s.", k.namespace, b.slug)
	w("")
	w("    kubectl apply -f secret.yaml -f kubernetes.yaml        # start it (or bring it up to date)")
	w("    kubectl -n %s logs -f deploy/%s                       # what it's doing", k.namespace, server)
	w("    kubectl -n %s rollout restart deploy/%s               # the newest version", k.namespace, server)
	w("")
	w("`secret.yaml` holds its keys: keep it private. The owner key (OWNER_KEY) signs in to")
	w("/app/server. It's reached on port %d of every node.", nodePort)
	return s.String()
}
