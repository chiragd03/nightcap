package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The servers this tool has set up, kept in ~/.nightcap-setup/servers.json (readable by its
// owner only) so they can be managed later: what each is called, where it runs, its address and
// its folder. No keys: they stay in each server's own files.

type savedServer struct {
	Name    string    `json:"name"`
	Status  string    `json:"status,omitempty"` // settingUp while its setup hasn't finished
	Slug    string    `json:"slug"`
	Where   string    `json:"where"` // docker, files (later: kubernetes, cloudrun)
	Mode    string    `json:"mode"`
	Dir     string    `json:"dir"`
	Address string    `json:"address,omitempty"`
	Image   string    `json:"image"`
	Created time.Time `json:"created"`
	// On Kubernetes: the cluster (kubectl's context) and namespace, and the name its parts go by.
	Context       string `json:"context,omitempty"`
	Namespace     string `json:"namespace,omitempty"`
	MadeNamespace bool   `json:"madeNamespace,omitempty"` // made for it (removed with it, if nothing else is in it)
	// On Google Cloud: the Google account it was made as, its project and region (its service
	// goes by its slug).
	Account     string `json:"account,omitempty"`
	Project     string `json:"project,omitempty"`
	Region      string `json:"region,omitempty"`
	MadeProject bool   `json:"madeProject,omitempty"` // made for it (deleted with it)
	// With Nightcap's own stream finder: the address the server reaches it at.
	OwnAIO string `json:"ownAIO,omitempty"`
	// An owner's household setup was put in its database from here (nightcap template).
	OwnTemplate bool `json:"ownTemplate,omitempty"`
}

// setupHome is this tool's own folder: NIGHTCAP_SETUP_HOME when set (tests), else ~/.nightcap-setup.
func setupHome() string {
	if h := os.Getenv("NIGHTCAP_SETUP_HOME"); h != "" {
		return h
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".nightcap-setup")
}

func serversFile() string { return filepath.Join(setupHome(), "servers.json") }

// loadServers is the saved list, newest first (none yet: an empty one).
func loadServers() ([]savedServer, error) {
	data, err := os.ReadFile(serversFile())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var file struct {
		Servers []savedServer `json:"servers"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("%s isn't readable: %w", tildePath(serversFile()), err)
	}
	sort.SliceStable(file.Servers, func(i, j int) bool { return file.Servers[i].Created.After(file.Servers[j].Created) })
	return file.Servers, nil
}

// saveServer adds [s] to the list (one already there with its folder is replaced), written to a
// new file then moved into place, so a crash can't leave half a list.
// settingUp marks a server whose setup made something but didn't finish: Manage can remove it.
const settingUp = "setting up"

func saveServer(s savedServer) error {
	list, err := loadServers()
	if err != nil {
		return err
	}
	kept := []savedServer{s}
	for _, o := range list {
		if o.Dir != s.Dir {
			kept = append(kept, o)
		}
	}
	if err := os.MkdirAll(setupHome(), 0o700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(struct {
		Servers []savedServer `json:"servers"`
	}{kept}, "", "  ")
	return writeList(append(data, '\n'))
}

// uniqueSlug is [slug], or slug-2, slug-3… when a server here already has that name: its folder
// exists, it's in the list, or (for one run here) Docker has a project by that name.
func uniqueSlug(slug string, dirFor func(string) string, taken map[string]bool) string {
	for n := 1; ; n++ {
		s := slug
		if n > 1 {
			s = fmt.Sprintf("%s-%d", slug, n)
		}
		if _, err := os.Stat(dirFor(s)); err == nil || taken[s] {
			continue
		}
		return s
	}
}

// takenSlugs: the names in the saved list, and Docker Compose projects on this computer.
func takenSlugs(docker bool) map[string]bool {
	taken := map[string]bool{}
	if list, err := loadServers(); err == nil {
		for _, s := range list {
			taken[s.Slug] = true
		}
	}
	if docker {
		if out, err := runQuiet("docker", "compose", "ls", "-a", "--format", "json"); err == nil {
			var projects []struct{ Name string }
			if json.Unmarshal([]byte(out), &projects) == nil {
				for _, p := range projects {
					taken[p.Name] = true
				}
			}
		}
		// (A volume left behind keeps its old database password: its name isn't reused.)
		if out, err := runQuiet("docker", "volume", "ls", "--format", `{{.Label "com.docker.compose.project"}}`); err == nil {
			for _, p := range strings.Fields(out) {
				taken[p] = true
			}
		}
	}
	return taken
}

// writeList writes the list whole, through a temp file of its own, so a reader never sees half of it.
func writeList(data []byte) error {
	f, err := os.CreateTemp(setupHome(), "servers-*.json")
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(f.Name())
		return err
	}
	f.Close()
	_ = os.Chmod(f.Name(), 0o600)
	return os.Rename(f.Name(), serversFile())
}
