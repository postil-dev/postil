#!/bin/sh
# Postil CLI installer. Downloads a prebuilt, checksum-verified release binary.
#
#   curl -fsSL https://postil.dev/install.sh | sh
#   curl -fsSL https://postil.dev/install.sh | sh -s -- --version v0.1.2 --bin-dir ~/.local/bin
#
# Verification: the archive's SHA-256 is checked against the published checksum
# (transit integrity), and when cosign is installed the Sigstore keyless
# signature is verified too (proves the artifact came from this project's
# release workflow). With cosign present, a missing signature aborts the
# install unless POSTIL_SKIP_SIG=1 is set. No build toolchain required.
# Inspect this script before piping it to a shell.

set -eu

REPO="postil-dev/postil-cli"
VERSION="${POSTIL_VERSION:-latest}"
# Default to a no-sudo user path; override with POSTIL_INSTALL_DIR or --bin-dir.
BIN_DIR="${POSTIL_INSTALL_DIR:-$HOME/.local/bin}"

while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --bin-dir) BIN_DIR="$2"; shift 2 ;;
        -h|--help)
            echo "usage: install.sh [--version <tag>] [--bin-dir <path>]"
            exit 0 ;;
        *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
    esac
done

err() { echo "install.sh: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

FROM_SOURCE="build from source with: cargo install --git https://github.com/${REPO}"

# Resolve the platform target triple.
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
    Linux)  os_part="unknown-linux-gnu" ;;
    Darwin) os_part="apple-darwin" ;;
    *) err "unsupported OS: $os ($FROM_SOURCE)" ;;
esac
case "$arch" in
    x86_64|amd64)  arch_part="x86_64" ;;
    aarch64|arm64) arch_part="aarch64" ;;
    *) err "unsupported architecture: $arch ($FROM_SOURCE)" ;;
esac
# The prebuilt Linux binaries link glibc; a musl libc (Alpine) cannot run them.
if [ "$os" = "Linux" ] && ldd --version 2>&1 | grep -qi musl; then
    err "musl libc detected (Alpine?); no musl prebuilt yet ($FROM_SOURCE)"
fi
target="${arch_part}-${os_part}"

# Pick a downloader early (needed to resolve "latest").
if command -v curl >/dev/null 2>&1; then
    dl() { curl -fsSL "$1" -o "$2"; }
    fetch() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
    dl() { wget -qO "$2" "$1"; }
    fetch() { wget -qO - "$1"; }
else
    err "need curl or wget"
fi

# Resolve "latest" to a concrete, reproducible tag via the API and pin it, so two
# installs minutes apart cannot silently get different binaries.
if [ "$VERSION" = "latest" ]; then
    VERSION="$(fetch "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name"' | head -n1 | sed 's/.*"tag_name"[^"]*"\([^"]*\)".*/\1/')"
    [ -n "$VERSION" ] || err "could not resolve the latest release tag; pass --version <tag>"
    echo "Resolved latest release: ${VERSION}"
fi
base="https://github.com/${REPO}/releases/download/${VERSION}"

archive="postil-${target}.tar.gz"
url="${base}/${archive}"
sum_url="${url}.sha256"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading ${archive} ..."
dl "$url" "$tmp/$archive" || err "download failed: $url"
dl "$sum_url" "$tmp/$archive.sha256" || err "checksum download failed: $sum_url"

# Verify the archive checksum against the published value.
expected="$(awk '{print $1}' "$tmp/$archive.sha256" | head -n1)"
[ -n "$expected" ] || err "empty checksum file: $sum_url"

if have sha256sum; then
    actual="$(sha256sum "$tmp/$archive" | awk '{print $1}')"
elif have shasum; then
    actual="$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')"
else
    err "need sha256sum or shasum to verify the download"
fi

[ "$actual" = "$expected" ] || err "checksum mismatch: expected $expected, got $actual"
echo "Checksum verified."

# If cosign is installed, additionally verify the Sigstore keyless signature.
# This is the real supply-chain control (proves the artifact came from this
# project's release workflow, not just that it matches a same-source checksum).
# A missing signature is then a hard failure: an attacker who can swap the
# archive can also swap the same-source checksum and strip the signature files.
# Releases are signed by the tag-triggered release workflow only.
if have cosign && [ "${POSTIL_SKIP_SIG:-0}" != "1" ]; then
    dl "${url}.sig" "$tmp/$archive.sig" 2>/dev/null \
        || err "signature not found for ${VERSION}; set POSTIL_SKIP_SIG=1 to install on checksum only"
    dl "${url}.pem" "$tmp/$archive.pem" 2>/dev/null \
        || err "signing certificate not found for ${VERSION}; set POSTIL_SKIP_SIG=1 to install on checksum only"
    if cosign verify-blob "$tmp/$archive" \
        --signature "$tmp/$archive.sig" \
        --certificate "$tmp/$archive.pem" \
        --certificate-identity-regexp "https://github.com/${REPO}/\.github/workflows/release\.yml@refs/tags/.*" \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com \
        >/dev/null 2>&1; then
        echo "Signature verified (Sigstore keyless)."
    else
        err "signature verification failed; refusing to install"
    fi
else
    echo "Note: install cosign to additionally verify the Sigstore signature."
fi

tar -xzf "$tmp/$archive" -C "$tmp"
[ -f "$tmp/postil" ] || err "archive did not contain the postil binary"
chmod +x "$tmp/postil"

# Install, falling back to sudo only if the target dir is not writable.
if [ -w "$BIN_DIR" ] || mkdir -p "$BIN_DIR" 2>/dev/null && [ -w "$BIN_DIR" ]; then
    mv "$tmp/postil" "$BIN_DIR/postil"
elif have sudo; then
    echo "Elevating to install into ${BIN_DIR} ..."
    sudo mkdir -p "$BIN_DIR"
    sudo mv "$tmp/postil" "$BIN_DIR/postil"
else
    err "cannot write to ${BIN_DIR}; re-run with --bin-dir <writable path>"
fi

echo "Installed postil to ${BIN_DIR}/postil"
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "Add ${BIN_DIR} to your PATH to run 'postil' directly." ;;
esac
"${BIN_DIR}/postil" --version || true
echo "Next:"
echo "  export MODEL_API_KEY=..."
echo "  export POSTIL_API_KEY=\"\$MODEL_API_KEY\""
echo "  postil doctor"
