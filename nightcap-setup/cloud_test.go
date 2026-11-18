package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

func cloudSample(ownAIO bool) bundle {
	p := samplePlan("cloudrun", "cloud", false)
	p.db = connPlan{url: "postgresql://postgres.abcd:p%23w@aws-1-ca-central-1.pooler.supabase.com:5432/postgres", where: "pooler"}
	p.keys.ownAIO = ownAIO
	p.cloud = cloudPlan{project: "nightcap-test01", region: "us-east1", newProject: true}
	return makeBundle(p, false)
}

func TestCloudService(t *testing.T) {
	b := cloudSample(true)
	svc := b.cloudService("nightcap", "docker.io/x/nightcap@sha256:aa", "docker.io/viren070/aiostreams@sha256:bb",
		"https://nightcap-123.us-east1.run.app", "postgresql://aiostreams_nightcap.abcd:pw@h:5432/postgres")
	data, _ := json.Marshal(svc)
	j := string(data)
	for _, want := range []string{`"run.googleapis.com/invoker-iam-disabled":"true"`, `"autoscaling.knative.dev/maxScale":"1"`,
		`"name":"server"`, `"containerPort":8080`, `"name":"aiostreams"`, `"value":"http://localhost:3000"`,
		`{"name":"PUBLIC_URL","value":"https://nightcap-123.us-east1.run.app"}`, `{"name":"MODE","value":"cloud"}`,
		`{"name":"TRUSTED_PROXY","value":"1"}`, `"DATABASE_URI"`, `"namespace":"nightcap-test01"`} {
		if !strings.Contains(j, want) {
			t.Errorf("the service hasn't %s", want)
		}
	}
	// Cloud Run gives the port itself, and refuses PORT among the settings.
	if strings.Contains(j, `{"name":"PORT","value":"7171"}`) {
		t.Error("the server is given PORT")
	}
	if j := string(must(json.Marshal(cloudSample(false).cloudService("n", "s", "a", "u", "")))); strings.Contains(j, "aiostreams") {
		t.Error("a sidecar without the stream finder")
	}
}

func must(b []byte, _ error) []byte { return b }

func TestCloudHelpers(t *testing.T) {
	u, err := aioDatabaseURI("postgresql://postgres.abcd:secret@pooler.example.com:5432/postgres?sslmode=require", "aiostreams_home", "pw123")
	if err != nil || u != "postgresql://aiostreams_home.abcd:pw123@pooler.example.com:5432/postgres?sslmode=require" {
		t.Errorf("aioDatabaseURI: %q %v", u, err)
	}
	if u, _ := aioDatabaseURI("postgresql://me:secret@db.example.com/nightcap", "aiostreams_home", "pw"); !strings.HasPrefix(u, "postgresql://aiostreams_home:pw@") {
		t.Errorf("plain user: %q", u)
	}
	for host, want := range map[string]bool{"db.example.com": true, "localhost": false, "127.0.0.1": false, "192.168.1.20": false, "10.0.0.5": false, "db": false, "34.1.2.3": true} {
		if reachableFromGoogle(host) != want {
			t.Errorf("reachableFromGoogle(%q) = %v", host, !want)
		}
	}
	if got := cloudServiceName("2-cabin"); got != "nightcap-2-cabin" {
		t.Errorf("cloudServiceName: %q", got)
	}
	if id := newProjectID(); !projectID.MatchString(id) {
		t.Errorf("newProjectID made %q", id)
	}
	ready, _ := serviceReady(map[string]any{"metadata": map[string]any{"generation": 2.0},
		"status": map[string]any{"observedGeneration": 1.0, "conditions": []any{map[string]any{"type": "Ready", "status": "True"}}}})
	if ready {
		t.Error("an older revision's ready counted")
	}
	_, why := serviceReady(map[string]any{"metadata": map[string]any{"generation": 2.0},
		"status": map[string]any{"observedGeneration": 2.0, "conditions": []any{map[string]any{"type": "Ready", "status": "False", "message": "Image not found"}}}})
	if why != "Image not found" {
		t.Errorf("why: %q", why)
	}
}

// cloudApp is the app on the Google screen, its accounts looked at.
func cloudApp(t *testing.T) tea.Model {
	t.Helper()
	lipgloss.SetColorProfile(termenv.TrueColor)
	lipgloss.SetHasDarkBackground(true)
	var m tea.Model = newApp()
	m, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	for i, tl := range []tool{dockerOK, kubectlOK, gcloudOK} {
		m, _ = m.Update(checked{i, tl})
	}
	m = press(m, "enter", "down", "down", "enter")
	m, _ = m.Update(cloudLoaded{accounts: []gaccount{{email: "me@example.com"}, {email: "work@example.com", expired: true}}})
	return m
}

func TestCloudScreen(t *testing.T) {
	m := cloudApp(t)
	v := snap(t, m, "cloud-account")
	for _, want := range []string{"Which Google account?", "me@example.com", "work@example.com", "Signed out. Enter signs in again.", "Sign in with another account"} {
		if !strings.Contains(v, want) {
			t.Errorf("accounts: doesn't show %q", want)
		}
	}
	// A signed-out account, or another: Enter signs in (gcloud's own sign-in, run from here).
	for _, downs := range [][]string{{"down"}, {"down", "down"}} {
		c := press(cloudApp(t), downs...).(app).cloud
		if cmd := c.enter(); cmd == nil || c.busy != "" {
			t.Errorf("%v: Enter doesn't sign in", downs)
		}
	}

	// One billing account: chosen without a question, on to the region (the nearest marked).
	m = press(m, "enter")
	if a := m.(app); a.cloud.busy == "" || a.cloud.account != "me@example.com" {
		t.Fatal("Enter didn't look at the account's billing")
	}
	m1, _ := m.Update(cloudBilling{account: "me@example.com", billing: []billingAccount{{"0A1B2C-000000-000000", "My billing"}}})
	if v := snap(t, m1, "cloud-region"); m1.(app).cloud.stage != pickRegion || !strings.Contains(v, "Where should it run?") || !strings.Contains(v, "Recommended") || !strings.Contains(v, "Somewhere else…") {
		t.Error("one billing account: not on to the region")
	}
	// The region, then the new project's name (its own question, filled in, changeable).
	m1 = press(m1, "enter")
	v1 := snap(t, m1, "cloud-project")
	if a := m1.(app); a.cloud.stage != pickProject || !strings.Contains(v1, "Name your Google project") || !strings.Contains(v1, "nightcap-") {
		t.Fatal("no question for the project's name")
	}
	for range 20 {
		m1, _ = m1.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	}
	m1 = press(m1, "Bad_Name", "enter")
	if v := snap(t, m1, "cloud-project-bad"); !strings.Contains(v, "small letters") || m1.(app).cloud.busy != "" {
		t.Error("a bad name went on")
	}
	for range 8 {
		m1, _ = m1.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	}
	m1 = press(m1, "home-cinema", "enter")
	if m1.(app).cloud.busy == "" {
		t.Fatal("a good name wasn't checked")
	}
	m1, _ = m1.Update(cloudProject{id: "home-cinema", err: "A project with this name was deleted recently: Google keeps the name for 30 days. Pick another."})
	if v := snap(t, m1, "cloud-project-taken"); !strings.Contains(v, "deleted recently") {
		t.Error("a name deleted recently isn't said")
	}
	m1, cmd := m1.Update(cloudProject{id: "home-cinema"})
	m1, _ = m1.Update(cmd())
	if a := m1.(app); a.screen != connScreen || !a.plan.cloud.newProject || a.plan.cloud.project != "home-cinema" || a.plan.cloud.billing != "0A1B2C-000000-000000" || a.plan.cloud.account != "me@example.com" {
		t.Fatalf("screen %d, cloud %+v", a.screen, a.plan.cloud)
	}
	if v := snap(t, m1, "conn-cloudrun"); !strings.Contains(v, "Free options: Neon (neon.com), Supabase (supabase.com).") {
		t.Error("the free options aren't named")
	}

	// None: Google's billing page, then check again.
	m2, _ := press(cloudApp(t), "enter").Update(cloudBilling{account: "me@example.com"})
	if v := snap(t, m2, "cloud-no-billing"); !strings.Contains(v, "Add billing to me@example.com") || !strings.Contains(v, "Open Google's billing page") || !strings.Contains(v, "check again") {
		t.Error("no billing: doesn't say how to add it")
	}
	m2 = press(m2, "down", "enter")
	if a := m2.(app); a.cloud.busy == "" {
		t.Error("check again didn't look again")
	}

	// Several: one is picked; Esc goes back a question at a time.
	m3, _ := press(cloudApp(t), "enter").Update(cloudBilling{account: "me@example.com", billing: []billingAccount{{"A", "Personal"}, {"B", "Work"}}})
	m3 = press(m3, "down", "enter")
	if a := m3.(app); a.cloud.stage != pickRegion || a.cloud.bill.id != "B" {
		t.Errorf("several: stage %d, billing %+v", a.cloud.stage, a.cloud.bill)
	}
	m3 = press(m3, "esc")
	if a := m3.(app); a.screen != cloudScreenID || a.cloud.stage != pickBilling {
		t.Error("Esc on the region didn't go back to billing")
	}
	m3 = press(m3, "esc", "esc")
	if a := m3.(app); a.screen != whereScreen {
		t.Errorf("Esc didn't go back to Where: screen %d, stage %d", a.screen, a.cloud.stage)
	}

	// An answer for an account no longer chosen is let go.
	m4 := press(cloudApp(t), "enter")
	m4, _ = m4.Update(cloudBilling{account: "someone@else.com", billing: []billingAccount{{"X", "Old"}}})
	if m4.(app).cloud.busy == "" {
		t.Error("another account's billing was taken")
	}
}

// Docker Hub, for real (NIGHTCAP_NET=1): each image's linux/amd64 build.
func TestAmd64ImageLive(t *testing.T) {
	if os.Getenv("NIGHTCAP_NET") == "" {
		t.Skip("set NIGHTCAP_NET=1 to ask Docker Hub")
	}
	for _, ref := range []string{"docker.io/chiragdahiya3/nightcap:latest", cloudAIOImage} {
		got, err := amd64Image(context.Background(), ref)
		t.Logf("%s → %s %v", ref, got, err)
		if err != nil || !strings.Contains(got, "@sha256:") {
			t.Errorf("%s: %q %v", ref, got, err)
		}
	}
	if _, err := amd64Image(context.Background(), "ghcr.io/viren070/aiostreams:v2.37.0"); err == nil {
		t.Error("ghcr.io taken")
	}
}
