package main

import (
	"fmt"
	"regexp"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// The cluster, for Kubernetes: kubectl's current one, and one question, the namespace (made if
// it isn't there). Checked on Enter: that this user may make what's needed there. (Nightcap's
// images are public: no pull secret.)

type clusterScreen struct {
	form     form
	context  string
	node     string
	checking bool
	spin     string // the spinner's frame (drawn by the app)
	err      string
}

const namespaceField = 0

type clusterChecked struct {
	plan kubePlan
	errs map[int]string
	err  string
}

func newClusterScreen(tools []*tool) clusterScreen {
	c := clusterScreen{}
	if t := tools[1]; t != nil {
		c.context = strings.TrimPrefix(t.detail, "cluster: ")
	}
	c.form.fields = []*field{newText("Namespace", "", "nightcap", "type a namespace", false)}
	c.form.fields[namespaceField].status = "Made if it's new."
	c.form.fields[namespaceField].input.Focus()
	c.form.fields[namespaceField].input.CursorEnd()
	return c
}

func (c *clusterScreen) check() tea.Cmd {
	if c.checking {
		return nil
	}
	c.checking, c.err = true, ""
	for _, f := range c.form.fields {
		f.status, f.statusKind = "", 0
	}
	ctx, ns := c.context, c.form.fields[namespaceField].value()
	return func() tea.Msg { return checkCluster(ctx, ns) }
}

// namespaceName is a namespace's form (DNS-1123 label), so nothing else reaches kubectl or the files.
var namespaceName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)

// canI asks kubectl auth can-i, taking its answer alone (it can print a warning before it).
func canI(kubeContext string, args ...string) bool {
	out, _ := kubectlQuick(kubeContext, append([]string{"auth", "can-i"}, args...)...)
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return strings.TrimSpace(lines[len(lines)-1]) == "yes"
}

func checkCluster(kubeContext, ns string) clusterChecked {
	r := clusterChecked{plan: kubePlan{context: kubeContext, namespace: ns}, errs: map[int]string{}}
	if ns == "" {
		r.errs[namespaceField] = "Give it a namespace."
		return r
	}
	if !namespaceName.MatchString(ns) {
		r.errs[namespaceField] = "Small letters, digits and dashes (63 at most), starting and ending with a letter or digit."
		return r
	}
	if _, err := kubectlQuick(kubeContext, "get", "nodes", "-o", "name"); err != nil {
		r.err = "The cluster didn't answer: " + err.Error()
		return r
	}
	r.plan.nodeIP = nodeAddress(kubeContext)
	if out, err := kubectlQuick(kubeContext, "get", "services", "-A", "-o", `jsonpath={range .items[*]}{range .spec.ports[*]}{.nodePort} {end}{end}`); err == nil {
		for _, p := range strings.Fields(out) {
			if p == fmt.Sprint(nodePort) {
				r.err = fmt.Sprintf("Port %d is already used in this cluster (another Nightcap?). One per cluster: remove it first.", nodePort)
				return r
			}
		}
	}
	_, err := kubectlQuick(kubeContext, "get", "namespace", ns)
	switch {
	case err == nil:
	case strings.Contains(err.Error(), "NotFound") || strings.Contains(err.Error(), "not found"):
		r.plan.newNamespace = true
	case strings.Contains(err.Error(), "Forbidden") || strings.Contains(err.Error(), "forbidden"):
		// (May not look at namespaces: taken as one that's there. Never made, so never removed.)
	default:
		r.err = "Couldn't check the namespace (" + err.Error() + "). Press Enter to try again."
		return r
	}
	if r.plan.newNamespace {
		if !canI(kubeContext, "create", "namespaces") {
			r.errs[namespaceField] = "There's no " + ns + " here, and you may not make namespaces: give one that's there."
		}
	}
	if !r.plan.newNamespace {
		if !canI(kubeContext, "create", "deployments", "-n", ns) {
			r.errs[namespaceField] = "You may not make deployments in " + ns + "."
		}
	}
	return r
}

// checked takes a check's answer; it says whether all's well.
func (c *clusterScreen) checked(m clusterChecked) bool {
	c.checking = false
	c.err = m.err
	for i, why := range m.errs {
		c.form.fields[i].status, c.form.fields[i].statusKind = why, -1
	}
	if m.err != "" || len(m.errs) > 0 {
		return false
	}
	c.node = m.plan.nodeIP
	if m.plan.newNamespace {
		c.form.fields[namespaceField].status, c.form.fields[namespaceField].statusKind = "new: made when it's set up", 0
	}
	return true
}

func (c clusterScreen) View(width int) string {
	var b strings.Builder
	b.WriteString(heading("Which namespace?", "In "+c.context+", kubectl's current cluster. Nightcap's parts go there."))
	b.WriteString(c.form.fields[namespaceField].alone(width) + "\n\n")
	switch {
	case c.checking:
		b.WriteString("  " + c.spin + " " + plain.Render("Checking the cluster…") + "\n\n" + muted.Render("  A cluster can take a minute."))
	case c.err != "":
		b.WriteString(note(width, bad.Render("✗ "), c.err))
	}
	return b.String()
}

func (c clusterScreen) keys() []key {
	return []key{{"enter", "check and continue"}, {"esc", "back"}, {"ctrl+c", "quit"}}
}
