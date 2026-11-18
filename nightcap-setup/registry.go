package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// An image on Docker Hub, by its linux/amd64 build's digest: Google Cloud Run runs one exact
// build, and a tag (latest) can move. (Cloud Run takes Docker Hub's images through Google's own
// mirror; its index with attestations it can't take, so the build itself is what's named.)

func amd64Image(ctx context.Context, ref string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if base, digest, ok := strings.Cut(ref, "@sha256:"); ok {
		// Pinned already: the build itself, its tag (only there to read) left out, as Cloud Run takes it.
		if i := strings.LastIndex(base, ":"); i > strings.LastIndex(base, "/") {
			base = base[:i]
		}
		return base + "@sha256:" + digest, nil
	}
	name := strings.TrimPrefix(ref, "docker.io/")
	if strings.Contains(strings.SplitN(name, "/", 2)[0], ".") {
		return "", fmt.Errorf("Google Cloud Run takes images from Docker Hub, not %s", strings.SplitN(name, "/", 2)[0])
	}
	repo, tag := name, "latest"
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		repo, tag = name[:i], name[i+1:]
	}
	if !strings.Contains(repo, "/") {
		repo = "library/" + repo
	}

	get := func(url, token string, accept ...string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		for _, a := range accept {
			req.Header.Add("Accept", a)
		}
		return http.DefaultClient.Do(req)
	}
	resp, err := get("https://auth.docker.io/token?service=registry.docker.io&scope=repository:"+repo+":pull", "")
	if err != nil {
		return "", fmt.Errorf("Docker Hub didn't answer: %v", err)
	}
	var auth struct{ Token string }
	_ = json.NewDecoder(resp.Body).Decode(&auth)
	resp.Body.Close()

	resp, err = get("https://registry-1.docker.io/v2/"+repo+"/manifests/"+tag, auth.Token,
		"application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.docker.distribution.manifest.v2+json", "application/vnd.oci.image.manifest.v1+json")
	if err != nil {
		return "", fmt.Errorf("Docker Hub didn't answer: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Docker Hub has no %s (%s)", ref, resp.Status)
	}
	var m struct {
		Manifests []struct {
			Digest   string
			Platform struct{ OS, Architecture string }
		}
	}
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return "", err
	}
	base := "docker.io/" + strings.TrimPrefix(repo, "library/")
	if len(m.Manifests) == 0 { // one build, not a list of them
		if d := resp.Header.Get("Docker-Content-Digest"); d != "" {
			return base + "@" + d, nil
		}
		return "", errors.New("Docker Hub didn't say which build " + ref + " is")
	}
	for _, x := range m.Manifests {
		if x.Platform.OS == "linux" && x.Platform.Architecture == "amd64" {
			return base + "@" + x.Digest, nil
		}
	}
	return "", fmt.Errorf("%s has no build for Google's machines (linux/amd64)", ref)
}
