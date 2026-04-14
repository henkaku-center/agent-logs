#!/usr/bin/env bash
# agent-logs installer for macOS / Linux / WSL
# Usage: curl -fsSL https://agent-logs.chibatech.dev/install.sh | bash
set -euo pipefail

REPO="henkaku-center/agent-logs"
INSTALL_DIR="${HOME}/.local/bin"
BINARY="${INSTALL_DIR}/agent-logs"

info()  { printf '\033[1;34m→\033[0m %s\n' "$1"; }
ok()    { printf '\033[1;32m✓\033[0m %b\n' "$1"; }
err()   { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# ── Detect platform ──
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Linux)   PLATFORM="linux" ;;
  Darwin)  PLATFORM="darwin" ;;
  *)       err "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  x86_64|amd64)   ARCH="x64" ;;
  arm64|aarch64)   ARCH="arm64" ;;
  *)               err "Unsupported architecture: $ARCH" ;;
esac

# macOS: detect Rosetta and prefer native arm64
if [ "$PLATFORM" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  if sysctl -n sysctl.proc_translated 2>/dev/null | grep -q 1; then
    ARCH="arm64"
    info "Rosetta detected — using native arm64 binary"
  fi
fi

TARGET="${PLATFORM}-${ARCH}"
info "Detected platform: ${TARGET}"

# ── Resolve latest release ──
info "Fetching latest release..."
RELEASE_URL="https://api.github.com/repos/${REPO}/releases/latest"

if command -v curl >/dev/null 2>&1; then
  RELEASE_JSON=$(curl -fsSL "$RELEASE_URL") || err "Failed to fetch release info"
elif command -v wget >/dev/null 2>&1; then
  RELEASE_JSON=$(wget -qO- "$RELEASE_URL") || err "Failed to fetch release info"
else
  err "curl or wget is required"
fi

# Extract download URL and tag (works with or without jq)
if command -v jq >/dev/null 2>&1; then
  TAG=$(echo "$RELEASE_JSON" | jq -r '.tag_name')
  DOWNLOAD_URL=$(echo "$RELEASE_JSON" | jq -r ".assets[] | select(.name == \"agent-logs-${TARGET}\") | .browser_download_url")
  CHECKSUMS_URL=$(echo "$RELEASE_JSON" | jq -r '.assets[] | select(.name == "checksums.txt") | .browser_download_url')
else
  TAG=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*: *"//;s/".*//')
  DOWNLOAD_URL=$(echo "$RELEASE_JSON" | grep "browser_download_url.*agent-logs-${TARGET}\"" | head -1 | sed 's/.*"browser_download_url": *"//;s/".*//')
  CHECKSUMS_URL=$(echo "$RELEASE_JSON" | grep 'browser_download_url.*checksums.txt"' | head -1 | sed 's/.*"browser_download_url": *"//;s/".*//')
fi

[ -n "$DOWNLOAD_URL" ] || err "No binary found for ${TARGET} in release ${TAG}. Check https://github.com/${REPO}/releases"
info "Downloading agent-logs ${TAG} for ${TARGET}..."

# ── Download binary ──
mkdir -p "$INSTALL_DIR"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "${WORK}/agent-logs"
  [ -n "$CHECKSUMS_URL" ] && curl -fsSL "$CHECKSUMS_URL" -o "${WORK}/checksums.txt"
else
  wget -qO "${WORK}/agent-logs" "$DOWNLOAD_URL"
  [ -n "$CHECKSUMS_URL" ] && wget -qO "${WORK}/checksums.txt" "$CHECKSUMS_URL"
fi

# ── Verify checksum ──
if [ -f "${WORK}/checksums.txt" ]; then
  EXPECTED=$(grep "agent-logs-${TARGET}" "${WORK}/checksums.txt" | awk '{print $1}')
  if [ -n "$EXPECTED" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL=$(sha256sum "${WORK}/agent-logs" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL=$(shasum -a 256 "${WORK}/agent-logs" | awk '{print $1}')
    else
      ACTUAL=""
    fi
    if [ -n "$ACTUAL" ]; then
      [ "$ACTUAL" = "$EXPECTED" ] || err "Checksum mismatch! Expected ${EXPECTED}, got ${ACTUAL}"
      ok "Checksum verified"
    fi
  fi
fi

# ── Install ──
mv "${WORK}/agent-logs" "$BINARY"
chmod +x "$BINARY"
ok "Installed to ${BINARY}"

# ── Check PATH ──
if ! echo "$PATH" | tr ':' '\n' | grep -q "^${INSTALL_DIR}$"; then
  printf '\n'
  info "${INSTALL_DIR} is not in your PATH. Add it:"
  printf '\n'
  printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc\n' "$INSTALL_DIR"
  printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc  # if using zsh\n' "$INSTALL_DIR"
  printf '\n'
fi

# ── Install claude wrapper as shell function ──
WRAPPER_LINE='claude() { command -v agent-logs &>/dev/null && { agent-logs consent-dialog || return 0; }; command claude "$@"; }'
MARKER="# agent-logs wrapper"

case "$(basename "${SHELL:-bash}")" in
  zsh)  RC="$HOME/.zshrc" ;;
  *)    RC="$HOME/.bashrc" ;;
esac

# Remove old wrapper line if present, then add current one
if [ -f "$RC" ]; then
  sed -i.bak "/$MARKER/d" "$RC" 2>/dev/null || true
  rm -f "${RC}.bak"
fi
printf '%s %s\n' "$WRAPPER_LINE" "$MARKER" >> "$RC"
ok "Wrapper installed in ${RC}"

printf '\n\033[1;32m✓\033[0m Installation complete. Open a new terminal, then run:\n\n'
printf '  \033[38;2;227;137;62mclaude\033[0m\n\n'
printf '  Or reload your current shell:\n\n  \033[1msource %s\033[0m\n\n' "$RC"
