#!/bin/sh
# Builds a release: the 5 builds with this version, their checksums (install.sh checks them) and
# install.sh. Publish them all on GitHub as release setup-v$VERSION, titled "Nightcap Server Setup
# $VERSION" (not a pre-release). Every Nightcap release: tag <product>-v<x.y.z>, three-part versions.
#   VERSION=1.0.0 ./release.sh
set -eu
: "${VERSION:?VERSION=1.0.0}"
if ! echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "VERSION has three numbers, e.g. 1.0.0 (no v)." >&2
  exit 1
fi
cd "$(dirname "$0")"
rm -rf release && mkdir release
for t in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do
  os=${t%/*}; arch=${t#*/}; ext=""; [ "$os" = windows ] && ext=.exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION" \
    -o "release/nightcap-setup-$os-$arch$ext" .
done
(cd release && sha256sum nightcap-setup-* > SHA256SUMS)
cp install.sh release/
ls -l release
echo "Publish on GitHub: tag setup-v$VERSION, title \"Nightcap Server Setup $VERSION\", all of release/ (not a pre-release)."
