package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func kubeSample(mode string, db bool) bundle {
	p := samplePlan("kubernetes", mode, db)
	p.kube = kubePlan{context: "k3s-home", namespace: "nightcap", newNamespace: true, nodeIP: "192.168.1.20"}
	b := makeBundle(p, false)
	b.slug = "nightcap-test"
	return b
}

func TestKubernetesHome(t *testing.T) {
	b := kubeSample("home", true)
	y := b.kubernetes()
	for _, want := range []string{
		"kind: Namespace", "name: nightcap-test-db", "kind: StatefulSet", "volumeClaimTemplates", "name: nightcap-test-aiostreams",
		"name: nightcap-test-server", "hostNetwork: true", "dnsPolicy: ClusterFirstWithHostNet", "strategy: {type: Recreate}",
		"initContainers:", "name: wait-for-db", "pg_isready -h nightcap-test-db", "nodePort: 30171",
		"protocol: UDP", "app.kubernetes.io/instance: nightcap-test",
		// Postgres makes the database the connection strings name (not one named after its Service).
		"{name: POSTGRES_DB, value: nightcap}", "pg_isready, -U, nightcap, -d, nightcap",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("kubernetes.yaml hasn't %q", want)
		}
	}
	sec := b.kubeSecret()
	for _, want := range []string{"kind: Secret", "name: nightcap-test-env", `MODE: "home"`, `ADVERTISE_PORT: "30171"`,
		`DATABASE_URL: "postgresql://nightcap:dbpass123456@nightcap-test-db:5432/nightcap?sslmode=disable"`,
		`SERVER_NAME: "Nightcap at Home"`, "DB_PASSWORD"} {
		if !strings.Contains(sec, want) {
			t.Errorf("secret.yaml hasn't %q:\n%s", want, sec)
		}
	}
	if !strings.Contains(sec, `OWN_AIOSTREAMS_URL: "http://nightcap-test-aiostreams:3000"`) || strings.Contains(sec, "  AIOSTREAMS_URL") {
		t.Errorf("stream finder: %q", b.ownAIOAddress())
	}
	for _, secret := range []string{"tmdbkey0123456789", "secretsecretsecretsecret", "dbpass123456", "AAAA-BBBB-CCCC-DDDD", b.aioKey} {
		if strings.Contains(y, secret) {
			t.Error("a key is in kubernetes.yaml")
		}
	}
	if strings.Contains(sec, "PUBLIC_URL") {
		t.Error("a home server is given PUBLIC_URL")
	}
}

func TestKubernetesAnywhereOwnDatabase(t *testing.T) {
	b := kubeSample("cloud", false)
	b.plan.kube.newNamespace = false
	y, sec := b.kubernetes(), b.kubeSecret()
	// (AIOStreams is always replaced, not rolled: its volume is one copy's at a time; the server, only at home.)
	if n := strings.Count(y, "strategy: {type: Recreate}"); n != 1 {
		t.Errorf("Recreate %d times, want 1 (AIOStreams only)", n)
	}
	// (A database it was given: nothing to wait for; the server makes its own tables.)
	for _, not := range []string{"kind: Namespace", "kind: StatefulSet", "hostNetwork", "imagePullSecrets", "initContainers"} {
		if strings.Contains(y, not) {
			t.Errorf("kubernetes.yaml has %q", not)
		}
	}
	if !strings.Contains(sec, `PUBLIC_URL: "https://tv.example.com"`) || strings.Contains(sec, "ADVERTISE_PORT") ||
		!strings.Contains(sec, `DATABASE_URL: "postgresql://u:p%23w@db.example.com:5432/nightcap"`) {
		t.Errorf("secret.yaml:\n%s", sec)
	}
}

func TestClusterScreen(t *testing.T) {
	var m tea.Model = newApp()
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	for i, tl := range []tool{dockerOK, kubectlOK, gcloudNone} {
		m, _ = m.Update(checked{i, tl})
	}
	m = press(m, "enter", "down", "enter") // Welcome, Kubernetes (at home)
	if m.(app).screen != clusterScreenID {
		t.Fatal("not on the Cluster screen")
	}
	v := snap(t, m, "cluster")
	if !strings.Contains(v, "Which namespace?") || !strings.Contains(v, "k3s-home") || strings.Contains(v, "Pull secret") {
		t.Error("the Cluster screen doesn't ask just the namespace, in which cluster")
	}
	m, _ = m.Update(clusterChecked{errs: map[int]string{namespaceField: "You may not make deployments in nightcap."}})
	if m.(app).screen != clusterScreenID || !strings.Contains(snap(t, m, "cluster-bad"), "You may not make deployments") {
		t.Error("a namespace it can't use didn't stop it")
	}
	m, _ = m.Update(clusterChecked{plan: kubePlan{context: "k3s-home", namespace: "nightcap", newNamespace: true, nodeIP: "192.168.1.20"}, errs: map[int]string{}})
	a := m.(app)
	if a.screen != databaseScreen || a.plan.kube.nodeIP != "192.168.1.20" {
		t.Fatalf("after a good check: screen %d, %+v", a.screen, a.plan.kube)
	}
	if v := snap(t, m, "database-k8s"); !strings.Contains(v, "in your cluster") {
		t.Error("Postgres in Kubernetes isn't offered")
	}
}

// Remove takes away by name: every object the manifests make is among the names it uses.
func TestKubeObjectsMatchManifests(t *testing.T) {
	b := kubeSample("home", true)
	made := map[string]bool{}
	kind := ""
	for _, l := range strings.Split(b.kubernetes()+"\n"+b.kubeSecret(), "\n") {
		if k, ok := strings.CutPrefix(l, "kind: "); ok {
			kind = strings.ToLower(k)
		}
		if n, ok := strings.CutPrefix(l, "  name: "); ok && kind != "namespace" {
			made[kind+"/"+n] = true
		}
	}
	made["persistentvolumeclaim/data-"+b.slug+"-db-0"] = true // (the StatefulSet's volume claim)
	names := map[string]bool{}
	for _, o := range kubeObjects(b.slug) {
		names[o] = true
	}
	for m := range made {
		if !names[m] {
			t.Errorf("made but not removed by name: %s", m)
		}
	}
	if !strings.Contains(kubeSelector("x"), "app.kubernetes.io/part-of=nightcap") {
		t.Error("the selector isn't Nightcap's own")
	}
	for ns, ok := range map[string]bool{"nightcap": true, "my-ns-2": true, "-A": false, "a b": false, "UPPER": false, "x#y": false, "": false} {
		if namespaceName.MatchString(ns) != ok {
			t.Errorf("namespace %q: %v", ns, !ok)
		}
	}
}
