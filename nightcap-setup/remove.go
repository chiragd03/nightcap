package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Removing a server for good, after its name is typed: one this computer runs is taken down with
// its containers and volumes (its database too, when it was made alongside), its folder deleted
// (its keys with it), and it's taken off the list. One run elsewhere: its folder here is deleted
// and it's forgotten; the copy running on the other machine isn't touched.

type removed struct {
	err  error
	note string // what was kept, and why
}

// hasOwnDatabase: whether a server's files make its database (its data goes with it).
func hasOwnDatabase(s savedServer) bool {
	if s.Where == "kubernetes" {
		data, err := os.ReadFile(filepath.Join(s.Dir, "kubernetes.yaml"))
		return err == nil && strings.Contains(string(data), "kind: StatefulSet")
	}
	data, err := os.ReadFile(filepath.Join(s.Dir, "docker-compose.yml"))
	return err == nil && strings.Contains(string(data), "\n  db:\n")
}

func removeServer(s savedServer) error {
	_, err := removeServerNoting(s)
	return err
}

// removeServerNoting removes a server, and says what it kept on purpose ("" if nothing). A database
// it keeps loses the owner's household setup put in from here, once it's gone.
func removeServerNoting(s savedServer) (string, error) {
	forget := forgetOwnAIO(s) // (worked out first: its files go with it)
	kept, err := removeServerParts(s)
	if err == nil && forget != nil {
		forget()
	}
	return kept, err
}

func removeServerParts(s savedServer) (string, error) {
	kept := ""
	if s.Where == "cloudrun" {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		// The service first: it stops answering at once (a deleted project's services keep
		// running for a while).
		api, err := newRunAPI(ctx, s.Account, s.Project, s.Region)
		if err != nil {
			return "", err
		}
		for _, p := range s.Plugins { // (its plugins first: their services are its own)
			if p.Service == "" || !ourCloudService(ctx, api, p.Service, s.Slug) {
				continue // (a service by its name that isn't this server's is left alone)
			}
			if _, code, err := api.do(ctx, http.MethodDelete, api.url(p.Service), nil); err != nil && code != http.StatusNotFound {
				return "", err
			}
		}
		if _, code, err := api.do(ctx, http.MethodDelete, api.url(s.Slug), nil); err != nil && code != http.StatusNotFound {
			return "", err
		}
		if s.MadeProject {
			// Its whole project, made for it (Google keeps it 30 days, in case) — only if nothing
			// else is in it and it's surely the one made for it.
			if why := projectNotOnlyItsOwn(ctx, api, s); why != "" {
				kept = "The project " + s.Project + " is kept: " + why + "."
			} else if _, err := gcloud(ctx, "projects", "delete", s.Project, as(s.Account)); err != nil {
				return "", err
			}
		}
	}
	if s.Where == "kubernetes" {
		// Its own objects, by name (never by a label someone else's may carry too).
		objects := kubeObjects(s.Slug)
		for _, p := range s.Plugins { // (its plugins: by their names, as its own parts)
			if p.Service == "" || !ourKubePlugin(s, p.Service) {
				continue // (objects by its name that aren't this server's are left alone)
			}
			objects = append(objects, "deployment/"+p.Service, "service/"+p.Service, "secret/"+p.Service)
		}
		if _, err := kubectlQuick(s.Context, append([]string{"delete", "-n", s.Namespace, "--ignore-not-found", "--wait=false"}, objects...)...); err != nil {
			return "", err
		}
		if s.MadeNamespace {
			if why := namespaceNotEmpty(s); why != "" {
				kept = "The namespace " + s.Namespace + " is kept: " + why + "."
			} else if _, err := kubectlQuick(s.Context, "delete", "namespace", s.Namespace, "--wait=false"); err != nil {
				return "", err
			}
		}
	}

	if s.Where == "docker" {
		if _, err := os.Stat(s.Dir); err == nil {
			if _, err := composeLong(s.Dir, "down", "--volumes", "--remove-orphans"); err != nil {
				return "", err
			}
		} else if _, err := composeLong(os.TempDir(), "-p", s.Slug, "down", "--volumes", "--remove-orphans"); err != nil {
			return "", err // (its folder is gone: taken down by its name)
		}
	}
	if err := os.RemoveAll(s.Dir); err != nil {
		return "", err
	}
	return kept, forgetServer(s.Dir)
}

// forgetServer takes the server in [dir] off the saved list.
func forgetServer(dir string) error {
	data, err := os.ReadFile(serversFile())
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var file struct {
		Servers []savedServer `json:"servers"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return err
	}
	kept := file.Servers[:0]
	for _, s := range file.Servers {
		if s.Dir != dir {
			kept = append(kept, s)
		}
	}
	out, _ := json.MarshalIndent(struct {
		Servers []savedServer `json:"servers"`
	}{kept}, "", "  ")
	return writeList(append(out, '\n'))
}

type removeScreen struct {
	s        savedServer
	input    textinput.Model
	spin     spinner.Model
	working  bool
	mismatch bool // Enter on a name that isn't its own
	err      error
	after    choices // once it failed: try again, forget it anyway, go back
	ownDB    bool
}

func newRemoveScreen(s savedServer) removeScreen {
	in := textinput.New()
	in.Prompt = ""
	in.CharLimit = 100
	in.Placeholder = "type " + s.Name
	in.Focus()
	return removeScreen{s: s, input: in, ownDB: hasOwnDatabase(s), spin: spinner.New(spinner.WithSpinner(spinner.MiniDot), spinner.WithStyle(accent))}
}

func (r removeScreen) matches() bool { return strings.TrimSpace(r.input.Value()) == r.s.Name }

func (r *removeScreen) start() tea.Cmd {
	if r.working {
		return nil
	}
	if !r.matches() {
		r.mismatch = true
		return nil
	}
	r.working, r.err = true, nil
	s := r.s
	return tea.Batch(r.spin.Tick, func() tea.Msg {
		n, err := removeServerNoting(s)
		return removed{err, n}
	})
}

func (r removeScreen) View(width int) string {
	var b strings.Builder
	b.WriteString(bad.Bold(true).Render("Remove "+r.s.Name+"?") + "\n" + muted.Render("This can't be undone.") + "\n\n")
	gone := func(what, detail string) {
		b.WriteString("  " + bad.Render("✗") + "  " + plain.Render(what) + "\n")
		if detail != "" {
			b.WriteString(note(width, "     ", detail) + "\n")
		}
	}
	switch r.s.Where {
	case "cloudrun":
		gone("The server", "on Google Cloud Run")
		if r.s.MadeProject {
			gone("Its project", r.s.Project+", made for it: Google deletes it after 30 days")
		}
	case "kubernetes":
		gone("The server", "its parts on the cluster")
		if r.s.MadeNamespace {
			gone("Its namespace", r.s.Namespace+", if nothing else is in it")
		}
	case "docker":
		gone("The server", "its containers")
	}
	if r.ownDB {
		gone("Its database", "every household, profile and watch history")
	}
	gone("Its files and keys", tildePath(r.s.Dir))
	b.WriteString("\n")
	switch {
	case r.s.Where == "files":
		b.WriteString(note(width, accent.Render("⚠ "), "The copy on the other machine keeps running. Stop it there.") + "\n\n")
	case r.s.Where == "cloudrun":
		b.WriteString(note(width, good.Render("✓ "), "Its database is yours, so it stays (with the stream finder's user in it, "+aioRole(r.s.Slug)+").") + "\n\n")
	case !r.ownDB:
		b.WriteString(note(width, good.Render("✓ "), "Its database is yours, so it stays.") + "\n\n")
	}
	b.WriteString(bold.Render("Type its name to confirm") + "\n")
	box := r.input.View()
	if r.input.Value() == "" {
		box = muted.Render("type " + r.s.Name)
	}
	b.WriteString(lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(red).Padding(0, 1).
		Width(min(width-2, 64)).Render(box) + "\n\n")
	switch {
	case r.working:
		b.WriteString("  " + r.spin.View() + " " + plain.Render("Removing "+r.s.Name+"…"))
	case r.err != nil:
		b.WriteString(note(width, bad.Render("✗ "), r.err.Error()) + "\n\n" + r.after.view(width))
	case r.matches():
		b.WriteString(bad.Render("  Enter removes it."))
	case r.mismatch:
		b.WriteString(note(width, bad.Render("  ✗ "), "Type its name exactly: "+r.s.Name))
	}
	return b.String()
}

func (r removeScreen) keys() []key {
	if r.err != nil {
		return []key{{"↑↓", "choose"}, {"enter", "select"}}
	}
	if r.matches() {
		return []key{{"enter", "remove for good"}, {"esc", "cancel"}}
	}
	return []key{{"esc", "cancel"}}
}

// projectNotOnlyItsOwn says why a project the tool made for [s] must stay ("" if it can go): another
// service in it, another saved server in it, or not plainly the one made for it (an entry saved
// before that was checked).
func projectNotOnlyItsOwn(ctx context.Context, api runAPI, s savedServer) string {
	list, _, err := api.do(ctx, http.MethodGet, api.url(""), nil)
	if err != nil {
		return "couldn't see what else is in it"
	}
	items, _ := list["items"].([]any)
	for _, it := range items {
		name := atString(it.(map[string]any), "metadata", "name")
		if slices.ContainsFunc(s.Plugins, func(p savedPlugin) bool { return p.Service == name }) {
			continue // (its own plugin's, still being deleted)
		}
		if name != "" && name != s.Slug {
			return "it has another service, " + name
		}
	}
	if others, _ := loadServers(); true {
		for _, o := range others {
			if o.Dir != s.Dir && o.Where == "cloudrun" && o.Project == s.Project {
				return "another server, " + o.Name + ", is in it"
			}
		}
	}
	out, err := gcloud(ctx, "projects", "describe", s.Project, "--format=value(name,createTime)", as(s.Account))
	if err != nil {
		return "couldn't check it"
	}
	name, created, _ := strings.Cut(out, "\t")
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(created))
	if name != "Nightcap" || err != nil || t.After(s.Created.Add(time.Minute)) || s.Created.Sub(t) > 24*time.Hour {
		return "it doesn't look like the one made for it"
	}
	return ""
}

// namespaceNotEmpty says why a namespace made for [s] must stay ("" if it can go): not marked as
// made for it (an entry saved before that was), or something else in it once its own parts are gone.
func namespaceNotEmpty(s savedServer) string {
	ann, err := kubectlQuick(s.Context, "get", "namespace", s.Namespace, "-o", `jsonpath={.metadata.annotations.nightcap-setup/made-for}`)
	if err != nil || strings.TrimSpace(ann) != s.Slug {
		return "it isn't marked as made for it"
	}
	// (Its own parts take a moment to go.)
	for try := 0; try < 15; try++ {
		out, err := kubectlQuick(s.Context, "get", "all,pvc,secret,configmap,ingress,job,cronjob", "-n", s.Namespace, "-o", "name")
		if err != nil {
			return "couldn't see what's in it"
		}
		var left []string
		for _, l := range strings.Fields(out) {
			if l == "configmap/kube-root-ca.crt" || strings.HasPrefix(l, "secret/default-token-") {
				continue // (Kubernetes' own, in every namespace)
			}
			left = append(left, l)
		}
		if len(left) == 0 {
			return ""
		}
		mine := true
		for _, l := range left {
			if !strings.Contains(l, s.Slug) {
				mine = false
			}
		}
		if !mine {
			return "it has other things in it"
		}
		time.Sleep(2 * time.Second)
	}
	return "its own parts are still going"
}

// failed takes Remove's failure: what now.
func (r *removeScreen) failed(err error) {
	r.working, r.err = false, err
	r.after = choices{opts: []option{
		{value: "again", title: "Try again"},
		{value: "forget", title: "Forget it anyway", desc: "Off the list. Whatever is left of it stays where it is."},
		{value: "back", title: "Go back"},
	}}
}
