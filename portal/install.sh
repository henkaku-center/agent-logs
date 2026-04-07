#!/usr/bin/env bash
# agent-logs installer for macOS / Linux
# Usage: curl -fsSL https://agent-logs.chibatech.dev/install.sh | bash
set -euo pipefail

REPO="henkaku-center/agent-logs"
INSTALL_DIR="${HOME}/.local/bin"
CONFIG_DIR="${HOME}/.config/agent-logs"

info()  { printf '\033[1;34m→\033[0m %s\n' "$1"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
err()   { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# ── Check prerequisites ──
command -v node >/dev/null 2>&1 || err "Node.js is required. Install it from https://nodejs.org"
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_VERSION" -ge 18 ] || err "Node.js 18+ required (found v${NODE_VERSION})"

command -v git >/dev/null 2>&1 || err "Git is required."

# ── Create directories ──
mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"

# ── Download CLI ──
info "Downloading agent-logs CLI..."
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

git clone --depth 1 "https://github.com/${REPO}.git" "$TMPDIR/agent-logs" 2>/dev/null

# Install dependencies
cd "$TMPDIR/agent-logs/cli"
npm install --production --silent 2>/dev/null

# Copy CLI to install directory
CLI_DIR="${CONFIG_DIR}/cli"
rm -rf "$CLI_DIR"
cp -r "$TMPDIR/agent-logs/cli" "$CLI_DIR"

# Create launcher script
cat > "${INSTALL_DIR}/agent-logs" << 'LAUNCHER'
#!/usr/bin/env node
import("PLACEHOLDER/index.js");
LAUNCHER
sed -i "s|PLACEHOLDER|${CLI_DIR}|" "${INSTALL_DIR}/agent-logs"
chmod +x "${INSTALL_DIR}/agent-logs"

ok "CLI installed to ${INSTALL_DIR}/agent-logs"

# ── Check PATH ──
if ! echo "$PATH" | tr ':' '\n' | grep -q "^${INSTALL_DIR}$"; then
  printf '\n'
  info "${INSTALL_DIR} is not in your PATH. Add it:"
  printf '\n'
  printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc\n' "$INSTALL_DIR"
  printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc  # if using zsh\n' "$INSTALL_DIR"
  printf '\n'
fi

# ── Login ──
printf '\n'
info "Run 'agent-logs login' to authenticate and register Claude Code hooks."
printf '\n'
ok "Installation complete."
