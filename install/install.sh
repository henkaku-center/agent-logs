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
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if ! git clone --depth 1 "https://github.com/${REPO}.git" "$WORK/agent-logs" 2>/dev/null; then
  err "Failed to clone repository. Check your internet connection and GitHub access."
fi

# Install dependencies
cd "$WORK/agent-logs/cli"
info "Installing dependencies..."
npm install --production --silent 2>/dev/null || err "npm install failed"

# Copy CLI to install directory
CLI_DIR="${CONFIG_DIR}/cli"
rm -rf "$CLI_DIR"
cp -r "$WORK/agent-logs/cli" "$CLI_DIR"

# Create launcher script with the correct path baked in
cat > "${INSTALL_DIR}/agent-logs" <<EOF
#!/usr/bin/env node
import("${CLI_DIR}/index.js");
EOF
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

# ── Install claude wrapper ──
# Resolve the real claude binary (follows symlinks to actual executable)
CLAUDE_PATH=$(command -v claude 2>/dev/null || true)

if [ -n "$CLAUDE_PATH" ]; then
  REAL_CLAUDE=$(readlink -f "$CLAUDE_PATH")

  VERSIONS_DIR=$(dirname "$REAL_CLAUDE")

  # Only wrap if it's a real executable and not already our wrapper
  if [ -x "$REAL_CLAUDE" ] && ! grep -q "agent-logs" "$REAL_CLAUDE" 2>/dev/null; then
    cat > "${INSTALL_DIR}/claude" <<WRAPPER
#!/usr/bin/env bash
# agent-logs wrapper — shows consent dialog before Claude starts
# Resolve latest Claude binary at runtime (survives auto-updates)
CLAUDE_BIN="\$(ls -t "${VERSIONS_DIR}"/* 2>/dev/null | head -1)"
if [ -z "\$CLAUDE_BIN" ] || [ ! -x "\$CLAUDE_BIN" ]; then
  echo "Error: Claude binary not found in ${VERSIONS_DIR}" >&2
  exit 1
fi
agent-logs consent-dialog
exec "\$CLAUDE_BIN" "\$@"
WRAPPER
    chmod +x "${INSTALL_DIR}/claude"
    ok "Claude wrapper installed (${REAL_CLAUDE})"
  else
    info "Claude wrapper already installed — skipping."
  fi
else
  info "Claude binary not found — skipping wrapper install."
  info "After installing Claude Code, re-run this installer to add the consent dialog."
fi

# ── Next step ──
printf '\n'
info "Run 'agent-logs login' to authenticate and register Claude Code hooks."
printf '\n'
ok "Installation complete."
