#!/bin/sh
# Installs (or updates) Nightcap Server Setup, as the command "nightcap", from its newest release (tagged setup-v…; the repo's other
# releases are the TV apps'), checked against the release's checksums. Run:
#   curl -fsSL https://mynightcap.tv/install.sh | sh
# (Once installed, "nightcap update" updates it.) If its folder isn't on the PATH, the shell's startup
# file gets one line adding it.
# (All of it is in main, run on the last line: a download that stops halfway runs nothing.)
set -eu

# Downloads only over HTTPS (TLS 1.2 or newer). NIGHTCAP_SETUP_BASE, for tests, may be a local folder.
fetch() { curl --proto '=https' --tlsv1.2 -fsSL "$@"; }
get() {
  if [ -n "${NIGHTCAP_SETUP_BASE:-}" ]; then curl -fsSL "$@"; else fetch "$@"; fi
}

main() {
  REPO="${NIGHTCAP_SETUP_REPO:-chiragd03/nightcap}"
  DIR="${NIGHTCAP_SETUP_DIR:-$HOME/.local/bin}"

  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) echo "On Windows, download nightcap-setup-windows-amd64.exe from the newest setup-v... release at https://github.com/$REPO/releases" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) echo "No build for $(uname -m)." >&2; exit 1 ;;
  esac

  file="nightcap-setup-$os-$arch"
  if [ -z "${NIGHTCAP_SETUP_BASE:-}" ]; then
    # The highest setup-v<numbers> release that isn't a draft or pre-release.
    tag="$(fetch "https://api.github.com/repos/$REPO/releases?per_page=100" | tr ',' '\n' | awk '
      /"tag_name":/ { gsub(/.*"tag_name": *"|".*/, ""); t = $0; d = 0 }
      /"draft": *true/ { d = 1 }
      /"prerelease": *false/ && !d && t ~ /^setup-v[0-9]+\.[0-9]+\.[0-9]+$/ { print t }' |
      sed 's/^setup-v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
    [ -n "$tag" ] && tag="setup-v$tag"
    if [ -z "$tag" ]; then
      echo "No release of nightcap-setup found in $REPO." >&2
      exit 1
    fi
  fi
  base="${NIGHTCAP_SETUP_BASE:-https://github.com/$REPO/releases/download/${tag:-}}"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading ${file}..."
  get "$base/$file" -o "$tmp/$file"
  get "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
  want="$(grep " $file\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$file" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)"; fi
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    echo "The download doesn't match the release's checksum: not installed." >&2
    exit 1
  fi

  mkdir -p "$DIR"
  chmod +x "$tmp/$file"
  mv "$tmp/$file" "$DIR/nightcap"
  echo "Installed: $DIR/nightcap ($("$DIR/nightcap" --version))"
  case ":$PATH:" in
    *":$DIR:"*) echo "Run: nightcap" ;;
    *)
      case "${SHELL:-}" in
        */zsh) rc="$HOME/.zshrc" ;;
        */bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
        *) rc="$HOME/.profile" ;;
      esac
      line="export PATH=\"$DIR:\$PATH\""
      if ! grep -qsF "$line" "$rc"; then
        printf '\n# Added by the Nightcap installer\n%s\n' "$line" >> "$rc"
        echo "Added $DIR to your PATH (in $rc)."
      fi
      echo "Open a new terminal window, then run: nightcap" ;;
  esac
}

main "$@"
