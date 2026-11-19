package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// This tool's version (set when a release is built: see release.sh) and where it's published: the
// repo's setup-v… releases (its tv-v… ones are the TV app's).
var (
	version     = "dev"
	releaseRepo = "chiragd03/nightcap"
)

const releasePrefix = "setup-v"

// versionLabel is this version as shown: "v1.0.0", or "dev" for a build that isn't a release.
func versionLabel() string {
	if version == "dev" {
		return "dev"
	}
	return "v" + version
}

// release is a newer version of this tool, published on GitHub.
type release struct{ version, page string }

// how is how to update to it: the install command (it gets the newest), or on Windows its page.
func (r release) how() string {
	if runtime.GOOS == "windows" {
		return "Download it from " + r.page
	}
	return "To update, run:  nightcap update"
}

// selfUpdate replaces this program with the newest release's build for this computer, checked
// against the release's checksums ("nightcap update").
func selfUpdate() error {
	if runtime.GOOS == "windows" {
		return fmt.Errorf("on Windows, download it from https://github.com/%s/releases", releaseRepo)
	}
	if version == "dev" {
		return fmt.Errorf("this is a development build, not a release: install it with install.sh")
	}
	r, err := newestRelease(30 * time.Second)
	if err != nil {
		return err
	}
	if r == nil {
		fmt.Println("Nightcap Server Setup", version, "is the newest.")
		return nil
	}
	file := "nightcap-setup-" + runtime.GOOS + "-" + runtime.GOARCH
	base := "https://github.com/" + releaseRepo + "/releases/download/" + releasePrefix + r.version + "/"
	fmt.Printf("Downloading %s %s…\n", file, r.version)
	bin, err := fetch(base+file, 200<<20)
	if err != nil {
		return err
	}
	sums, err := fetch(base+"SHA256SUMS", 1<<20)
	if err != nil {
		return err
	}
	got := sha256.Sum256(bin)
	if !strings.Contains(string(sums), hex.EncodeToString(got[:])+"  "+file+"\n") {
		return fmt.Errorf("the download doesn't match the release's checksum: not updated")
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if self, err = filepath.EvalSymlinks(self); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(self), ".nightcap-setup-*")
	if err != nil {
		return fmt.Errorf("can't write next to %s: %w", self, err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(bin); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), self); err != nil {
		return err
	}
	fmt.Println("Updated to", r.version+".")
	return nil
}

func fetch(url string, limit int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

// checkForUpdate asks GitHub, once at the start, for this tool's newest release (nothing else is
// sent; NIGHTCAP_NO_UPDATE_CHECK=1 turns it off). Nothing comes back unless it's newer, and it's
// quiet when GitHub can't be asked. A build that isn't a release (version "dev") doesn't ask.
func checkForUpdate() tea.Msg {
	if version == "dev" || os.Getenv("NIGHTCAP_NO_UPDATE_CHECK") != "" {
		return nil
	}
	r, err := newestRelease(5 * time.Second)
	if err != nil || r == nil {
		return nil
	}
	return *r
}

// newestRelease is this tool's newest release on GitHub (a setup-v… one, not a draft or
// pre-release) when it's newer than this one; nil when not.
func newestRelease(wait time.Duration) (*release, error) {
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+releaseRepo+"/releases?per_page=100", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "nightcap-setup/"+version)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("couldn't reach GitHub: %w", err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests:
		return nil, fmt.Errorf("GitHub says to wait a while (it limits asks to 60 an hour)")
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("GitHub answered %s", resp.Status)
	}
	var list []struct {
		Tag        string `json:"tag_name"`
		Page       string `json:"html_url"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&list); err != nil {
		return nil, fmt.Errorf("couldn't read GitHub's answer: %w", err)
	}
	var newest *release
	for _, r := range list {
		v, ok := strings.CutPrefix(r.Tag, releasePrefix)
		if !ok || r.Draft || r.Prerelease || !releaseVersion.MatchString(v) {
			continue
		}
		if newerVersion(v, version) && (newest == nil || newerVersion(v, newest.version)) {
			newest = &release{v, plainText(r.Page)}
		}
	}
	return newest, nil
}

// releaseVersion is a release's version: three numbers ("1.2.0"), as every Nightcap release has.
var releaseVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

// newerVersion is whether version [a] ("v1.10.0") comes after [b] ("1.9").
func newerVersion(a, b string) bool {
	pa, pb := strings.Split(strings.TrimPrefix(a, "v"), "."), strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}
