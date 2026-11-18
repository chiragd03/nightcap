package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Nightcap on Kubernetes: what's sent to the cluster (kubernetes.yaml), all named after the
// server and labelled with it, in the namespace chosen. Postgres if it's made alongside (a
// StatefulSet with its own volume; the server waits for it), AIOStreams if wanted, and the server,
// which makes and updates its own tables when it starts.
// The keys go in a Secret, sent from a file only you can read (secret.yaml).
//
// At home the server is on the node's own network (TVs find it by a broadcast), as Nightcap's
// own deploy does, and also on port 30171 of every node.

const nodePort = 30171

type kubePlan struct {
	context, namespace string
	newNamespace       bool
	nodeIP             string // a node's address, where it's reached
}

// q is a YAML string (JSON's quoting is YAML's too).
func q(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func (b bundle) kubeNames() (db, aio, server, secret string) {
	return b.slug + "-db", b.slug + "-aiostreams", b.slug + "-server", b.slug + "-env"
}

// kubeSelector picks this server's parts: its instance label and Nightcap's (a Helm release with
// the same instance name isn't picked).
func kubeSelector(slug string) string {
	return "app.kubernetes.io/instance=" + slug + ",app.kubernetes.io/part-of=nightcap"
}

// kubeObjects are every object the tool makes for a server, by kind and name (taken away by name).
func kubeObjects(slug string) []string {
	return []string{"deployment/" + slug + "-server", "deployment/" + slug + "-aiostreams", "statefulset/" + slug + "-db",
		"service/" + slug + "-server", "service/" + slug + "-aiostreams", "service/" + slug + "-db",
		"secret/" + slug + "-env", "persistentvolumeclaim/" + slug + "-aiostreams-data", "persistentvolumeclaim/data-" + slug + "-db-0"}
}

// kubeEnv is the server's settings on the cluster: the database and AIOStreams by their Service
// names, and (at home) the port it's advertised on, as TVs reach it.
func (b bundle) kubeEnv() [][2]string {
	dbName, _, _, _ := b.kubeNames()
	var env [][2]string
	for _, kv := range b.serverEnv() {
		switch kv[0] {
		case "DATABASE_URL":
			if d := b.plan.db.docker; d != nil {
				kv[1] = d.url(dbName, 5432)
			}
		}
		env = append(env, kv)
	}
	if b.plan.mode == "home" {
		env = append(env, [2]string{"ADVERTISE_PORT", fmt.Sprint(nodePort)})
	}
	return env
}

// kubeSecret is the Secret with the server's settings and keys, and what the others need.
func (b bundle) kubeSecret() string {
	_, _, _, secretName := b.kubeNames()
	k := b.plan.kube
	var s strings.Builder
	fmt.Fprintf(&s, "# The %s server's keys. Made by nightcap-setup: keep it private.\n", b.plan.settings.name)
	fmt.Fprintf(&s, "apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\n  labels:\n    app.kubernetes.io/instance: %s\ntype: Opaque\nstringData:\n",
		secretName, k.namespace, b.slug)
	for _, kv := range b.kubeEnv() {
		fmt.Fprintf(&s, "  %s: %s\n", kv[0], q(kv[1]))
	}
	if d := b.plan.db.docker; d != nil {
		fmt.Fprintf(&s, "  DB_PASSWORD: %s\n", q(d.password))
	}
	if b.plan.keys.ownAIO {
		fmt.Fprintf(&s, "  AIOSTREAMS_SECRET_KEY: %s\n", q(b.aioKey))
		for _, kv := range b.composeEnv() {
			if strings.HasPrefix(kv[0], "AIOSTREAMS_TMDB_") {
				fmt.Fprintf(&s, "  %s: %s\n", kv[0], q(kv[1]))
			}
		}
	}
	return s.String()
}

func (b bundle) kubernetes() string {
	dbSvc, aioName, serverName, secretName := b.kubeNames()
	k := b.plan.kube
	var s strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&s, format+"\n", a...) }
	labels := func(part string) {
		w("  labels:")
		w("    app.kubernetes.io/instance: %s", b.slug)
		w("    app.kubernetes.io/part-of: nightcap")
		w("    app.kubernetes.io/component: %s", part)
	}
	selector := func(indent, part string) {
		w("%smatchLabels:", indent)
		w("%s  app.kubernetes.io/instance: %s", indent, b.slug)
		w("%s  app.kubernetes.io/component: %s", indent, part)
	}
	podLabels := func(part string) {
		w("    metadata:")
		w("      labels:")
		w("        app.kubernetes.io/instance: %s", b.slug)
		w("        app.kubernetes.io/part-of: nightcap")
		w("        app.kubernetes.io/component: %s", part)
	}
	fromSecret := func(indent, name, key string) {
		w("%s- name: %s", indent, name)
		w("%s  valueFrom: {secretKeyRef: {name: %s, key: %s}}", indent, secretName, key)
	}
	w("# Nightcap: %s, on Kubernetes. Made by nightcap-setup.", b.plan.settings.name)
	w("# Its keys are in secret.yaml (kubectl apply -f secret.yaml first).")
	if k.newNamespace {
		w("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: %s", k.namespace)
		w("---")
	}
	if d := b.plan.db.docker; d != nil {
		w("---")
		w("apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: %s\n  namespace: %s", dbSvc, k.namespace)
		labels("db")
		w("spec:\n  serviceName: %s\n  replicas: 1\n  selector:", dbSvc)
		selector("    ", "db")
		w("  template:")
		podLabels("db")
		w("    spec:")
		w("      containers:")
		w("        - name: postgres")
		w("          image: %s", d.image)
		w("          env:")
		w("            - {name: POSTGRES_USER, value: %s}", dbUser)
		w("            - {name: POSTGRES_DB, value: %s}", dbName)
		fromSecret("            ", "POSTGRES_PASSWORD", "DB_PASSWORD")
		w("            - {name: PGDATA, value: /var/lib/postgresql/data/pgdata}")
		w("          ports: [{containerPort: 5432}]")
		w("          readinessProbe: {exec: {command: [pg_isready, -U, %s, -d, %s]}, periodSeconds: 3}", dbUser, dbName)
		w("          volumeMounts: [{name: data, mountPath: /var/lib/postgresql/data}]")
		w("  volumeClaimTemplates:")
		w("    - metadata: {name: data, labels: {app.kubernetes.io/instance: %s}}", b.slug)
		w("      spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 5Gi}}}")
		w("---")
		w("apiVersion: v1\nkind: Service\nmetadata:\n  name: %s\n  namespace: %s", dbSvc, k.namespace)
		labels("db")
		w("spec:")
		w("  selector: {app.kubernetes.io/instance: %s, app.kubernetes.io/component: db}", b.slug)
		w("  ports: [{port: 5432, targetPort: 5432}]")
	}
	if b.plan.keys.ownAIO {
		w("---")
		w("apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: %s-data\n  namespace: %s", aioName, k.namespace)
		labels("aiostreams")
		w("spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 2Gi}}}")
		w("---")
		w("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: %s\n  namespace: %s", aioName, k.namespace)
		labels("aiostreams")
		w("spec:\n  replicas: 1\n  strategy: {type: Recreate}\n  selector:")
		selector("    ", "aiostreams")
		w("  template:")
		podLabels("aiostreams")
		w("    spec:")
		w("      containers:")
		w("        - name: aiostreams")
		w("          image: %s", aioImage)
		w("          env:")
		w("            - {name: PORT, value: \"3000\"}")
		w("            - {name: BASE_URL, value: %s}", q("http://"+aioName+":3000"))
		fromSecret("            ", "SECRET_KEY", "AIOSTREAMS_SECRET_KEY")
		for _, kv := range b.composeEnv() {
			if strings.HasPrefix(kv[0], "AIOSTREAMS_TMDB_") {
				fromSecret("            ", strings.TrimPrefix(kv[0], "AIOSTREAMS_"), kv[0])
			}
		}
		for _, kv := range [][2]string{{"PROVIDE_STREAM_DATA", "true"}, {"REGEX_FILTER_ACCESS", "all"}, {"SEL_SYNC_ACCESS", "all"}, {"MAX_ADDONS", "30"}, {"ANIME_DB_LEVEL_OF_DETAIL", "required"}} {
			w("            - {name: %s, value: %s}", kv[0], q(kv[1]))
		}
		w("          ports: [{containerPort: 3000}]")
		w("          volumeMounts: [{name: data, mountPath: /app/data}]")
		w("      volumes: [{name: data, persistentVolumeClaim: {claimName: %s-data}}]", aioName)
		w("---")
		w("apiVersion: v1\nkind: Service\nmetadata:\n  name: %s\n  namespace: %s", aioName, k.namespace)
		labels("aiostreams")
		w("spec:")
		w("  selector: {app.kubernetes.io/instance: %s, app.kubernetes.io/component: aiostreams}", b.slug)
		w("  ports: [{port: 3000, targetPort: 3000}]")
	}
	w("---")
	w("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: %s\n  namespace: %s", serverName, k.namespace)
	labels("server")
	// (On the node's own network, two can't be on one node at once: the old one goes first.)
	if b.plan.mode == "home" {
		w("spec:\n  replicas: 1\n  strategy: {type: Recreate}\n  selector:")
	} else {
		w("spec:\n  replicas: 1\n  selector:")
	}
	selector("    ", "server")
	w("  template:")
	podLabels("server")
	w("    spec:")
	w("      nodeSelector: {kubernetes.io/arch: amd64}   # the server's only build so far")
	if b.plan.mode == "home" {
		w("      hostNetwork: true   # TVs on the home network find it by a broadcast")
		w("      dnsPolicy: ClusterFirstWithHostNet")
	}
	if b.plan.db.docker != nil {
		w("      initContainers:")
		w("        # Waits for the database. (The server makes and updates its own tables when it starts.)")
		w("        - name: wait-for-db")
		w("          image: %s", dbImage)
		w("          command: [sh, -c, 'until pg_isready -h %s -p 5432 -q; do sleep 2; done']", dbSvc)
	}
	w("      containers:")
	w("        - name: server")
	w("          image: %s", b.image)
	w("          imagePullPolicy: Always")
	w("          envFrom: [{secretRef: {name: %s}}]", secretName)
	w("          env: [{name: PYTHONUNBUFFERED, value: \"1\"}]")
	w("          ports:")
	w("            - {containerPort: %d, name: http}", serverPortN)
	if b.plan.mode == "home" {
		w("            - {containerPort: %d, protocol: UDP, name: discovery}", serverPortN)
	}
	w("          readinessProbe: {httpGet: {path: /ready, port: %d}, periodSeconds: 10}", serverPortN)
	w("          startupProbe: {httpGet: {path: /ready, port: %d}, periodSeconds: 5, failureThreshold: 60}", serverPortN)
	w("          resources: {requests: {cpu: 50m, memory: 128Mi}, limits: {cpu: 500m, memory: 512Mi}}")
	w("---")
	w("apiVersion: v1\nkind: Service\nmetadata:\n  name: %s\n  namespace: %s", serverName, k.namespace)
	labels("server")
	w("spec:")
	w("  type: NodePort")
	w("  selector: {app.kubernetes.io/instance: %s, app.kubernetes.io/component: server}", b.slug)
	w("  ports: [{name: http, port: %d, targetPort: %d, nodePort: %d}]", serverPortN, serverPortN, nodePort)
	return s.String()
}

// kubectl runs kubectl on the chosen cluster, for its output.
func kubectl(ctx context.Context, kubeContext string, args ...string) (string, error) {
	verb := args[0]
	for i, a := range args { // (the command itself, past any "-n namespace")
		if !strings.HasPrefix(a, "-") && (i == 0 || args[i-1] != "-n") {
			verb = a
			break
		}
	}
	if kubeContext != "" {
		args = append([]string{"--context", kubeContext}, args...)
	}
	out, err := exec.CommandContext(ctx, "kubectl", args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("kubectl %s: %s", verb, scrub(firstLine(strings.TrimSpace(string(out)))))
	}
	return string(out), nil
}

func kubectlQuick(kubeContext string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return kubectl(ctx, kubeContext, args...)
}

// nodeAddress is a node's internal address (the first one listed), where a server on the node's
// network or a NodePort is reached.
func nodeAddress(kubeContext string) string {
	out, err := kubectlQuick(kubeContext, "get", "nodes", "-o", `jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}`)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}
