#!/usr/bin/env bash
# Valkyrie installer for macOS
#
#   curl -fsSL https://tryvalkyrie.vercel.app/install.sh | bash
#
# Downloads the latest release from GitHub, checks its SHA-256 against the
# release's SHA256SUMS.txt, and installs Valkyrie.app into /Applications.
# Files downloaded with curl aren't quarantined, so macOS doesn't block the
# (not yet Apple-signed) app on first launch.
set -euo pipefail

REPO="anmol110923/valkyrie"
DEST="${VALKYRIE_INSTALL_DIR:-/Applications}"
MNT=""
TMP=""

say() { printf '\033[1;35m%s\033[0m %s\n' "$1" "$2"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }
cleanup() {
  if [[ -n "$MNT" ]]; then hdiutil detach "$MNT" -quiet 2>/dev/null || true; fi
  if [[ -n "$TMP" ]]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT

[[ "$(uname -s)" == "Darwin" ]] || fail "This installer is for macOS. On Windows run: irm https://tryvalkyrie.vercel.app/install.ps1 | iex"

ARCH="x64"
if [[ "$(uname -m)" == "arm64" || "$(sysctl -in sysctl.proc_translated 2>/dev/null)" == "1" ]]; then ARCH="arm64"; fi

say "→" "Finding the latest Valkyrie release…"
JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest")" || fail "Couldn't reach GitHub. Check your internet connection."
TAG="$(printf '%s' "$JSON" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
[[ -n "$TAG" ]] || fail "Couldn't find the latest release."
VERSION="${TAG#v}"
FILE="Valkyrie-$VERSION-mac-$ARCH.dmg"
BASE="https://github.com/$REPO/releases/download/$TAG"

TMP="$(mktemp -d)"
say "↓" "Downloading $FILE"
curl -fL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE" || fail "Download failed."

say "→" "Verifying checksum…"
curl -fsSL "$BASE/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt" || fail "Couldn't download SHA256SUMS.txt for $TAG."
EXPECTED="$(awk -v f="$FILE" '$2 == f || $2 == "*"f { print $1 }' "$TMP/SHA256SUMS.txt")"
ACTUAL="$(shasum -a 256 "$TMP/$FILE" | awk '{ print $1 }')"
[[ -n "$EXPECTED" && "$EXPECTED" == "$ACTUAL" ]] || fail "Checksum mismatch. The download may be corrupted; nothing was installed."
say "✓" "Checksum OK"

MNT="$TMP/mount"
mkdir -p "$MNT"
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MNT" "$TMP/$FILE" || fail "Couldn't open the disk image."
[[ -d "$MNT/Valkyrie.app" ]] || fail "Valkyrie.app not found in the disk image."

if [[ -z "${VALKYRIE_INSTALL_DIR:-}" ]] && pgrep -xq Valkyrie; then
  say "→" "Quitting the running Valkyrie…"
  osascript -e 'tell application "Valkyrie" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq Valkyrie || break; sleep 1; done
fi

SUDO=""
if [[ ! -w "$DEST" ]] || { [[ -e "$DEST/Valkyrie.app" ]] && [[ ! -w "$DEST/Valkyrie.app" ]]; }; then
  say "→" "Administrator password needed to install into $DEST"
  SUDO="sudo"
fi

say "→" "Installing into $DEST…"
$SUDO rm -rf "$DEST/Valkyrie.app"
$SUDO ditto "$MNT/Valkyrie.app" "$DEST/Valkyrie.app"
$SUDO xattr -dr com.apple.quarantine "$DEST/Valkyrie.app" 2>/dev/null || true

say "✓" "Valkyrie $VERSION installed."
if [[ -z "${VALKYRIE_INSTALL_DIR:-}" ]]; then
  open "$DEST/Valkyrie.app"
  say " " "Tip: make it your default browser in Settings (⌘,)."
fi
