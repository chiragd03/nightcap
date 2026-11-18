package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A database with households asks for their server's secrets key (filled in from a server on the
// list with the same database); a key that works goes on to Keys, and is the one the server gets.
func TestSecretsKeyScreen(t *testing.T) {
	m := toKeysScreenWith(t, dbReport{ok: true, version: "16", pgcrypto: "installed", hasNightcap: true, households: 2, profiles: 5})
	a := m.(app)
	if a.screen != secretsKeyScreenID {
		t.Fatalf("on screen %d, not asked for the secrets key", a.screen)
	}
	if v := snap(t, m, "secrets-key"); !strings.Contains(v, "This database already has households") {
		t.Error("doesn't say why it asks")
	}
	m = press(m, "the-old-key", "enter")
	m, _ = m.Update(secretsChecked{key: "the-old-key", why: "That key doesn't open its saved keys. Check it's that server's SECRETS_KEY."})
	if v := snap(t, m, "secrets-key-wrong", "the-old-key"); m.(app).screen != secretsKeyScreenID || !strings.Contains(v, "doesn't open") {
		t.Error("a wrong key went on")
	}
	m, _ = m.Update(secretsChecked{key: "the-old-key", ok: true})
	if a := m.(app); a.screen != keysScreenID || a.keys.secrets != "the-old-key" {
		t.Errorf("a key that works: screen %d, secrets %q", a.screen, a.keys.secrets)
	}
	// An empty Nightcap database (no households) isn't asked about.
	if a := toKeysScreenWith(t, dbReport{ok: true, version: "16", pgcrypto: "installed", hasNightcap: true, households: 0}).(app); a.screen != keysScreenID {
		t.Error("an empty database asked for a key")
	}
}

func TestKnownSecretsKey(t *testing.T) {
	t.Setenv("NIGHTCAP_SETUP_HOME", t.TempDir())
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "nightcap.env"), []byte("DATABASE_URL='postgresql://u:p@db.example.com:5432/nightcap'\nSECRETS_KEY=kept-key\n"), 0o600)
	_ = saveServer(savedServer{Name: "Old", Slug: "old", Where: "docker", Dir: dir, Created: time.Now()})
	if k := knownSecretsKey("postgresql://other:pw@DB.example.com:5432/nightcap?sslmode=require"); k != "kept-key" {
		t.Errorf("same database, other user: %q", k)
	}
	if k := knownSecretsKey("postgresql://u:p@elsewhere.com/nightcap"); k != "" {
		t.Errorf("another database: %q", k)
	}
}
