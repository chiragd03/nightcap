package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"time"
)

// Postgres in Docker, made for Nightcap by its Compose files (bundle.go): the "db" service, its
// data in the "db-data" volume (kept if the container is removed), reachable from the machine it
// runs on at 127.0.0.1 only. Planned here: a port nobody on this computer uses, and a password.

type dockerDB struct {
	name, volume, image string
	port                int
	password            string
}

const (
	dbImage     = "postgres:16-alpine"
	dbUser      = "nightcap"
	dbName      = "nightcap"
	firstDBPort = 55432
)

// planDockerDB picks the port ([here]: one free on this computer; else the usual one, for files
// run elsewhere) and makes a password. Nothing is made.
func planDockerDB(here bool) (dockerDB, error) {
	d := dockerDB{name: "db", volume: "db-data", image: dbImage, port: firstDBPort, password: newSecret(32)}
	if !here {
		return d, nil
	}
	for p := firstDBPort; p < firstDBPort+100; p++ {
		if free(p) {
			d.port = p
			return d, nil
		}
	}
	return dockerDB{}, errors.New("no free port for the database between 55432 and 55531")
}

func (d dockerDB) hostURL() string { return d.url("127.0.0.1", d.port) }

func (d dockerDB) url(host string, port int) string {
	return fmt.Sprintf("postgresql://%s@%s:%d/%s?sslmode=disable", url.UserPassword(dbUser, d.password).String(), host, port, dbName)
}

// waitReady waits until the database at [url] answers and passes the check (a new one takes a
// few seconds to start, longer the first time its image is pulled).
func (d dockerDB) waitReady(ctx context.Context, url string) error {
	for {
		r := checkDatabase(url)
		if r.ok {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("the database didn't start: %s", r.problem)
		case <-time.After(time.Second):
		}
	}
}

func free(port int) bool {
	for _, host := range []string{"127.0.0.1", "0.0.0.0"} {
		l, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
		if err != nil {
			return false
		}
		l.Close()
	}
	return true
}

// newSecret makes a random password of letters and digits (nothing that needs encoding anywhere).
func newSecret(n int) string {
	const letters = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, n)
	for i := range b {
		v, _ := rand.Int(rand.Reader, big.NewInt(int64(len(letters))))
		b[i] = letters[v.Int64()]
	}
	return string(b)
}
