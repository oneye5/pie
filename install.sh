#!/usr/bin/env bash
# Bootstrap the pie portable coding-agent configuration on macOS / Linux.
#
# Mirrors the essentials of install.ps1:
#   1. Sets PI_CODING_AGENT_DIR to point at this repo (user shell rc).
#   2. Migrates legacy ~/.pi/agent/auth.json into the repo if missing.
#   3. Verifies node / npm are present.
#   4. Runs `pi update` if the `pi` CLI is available, to restore packages.
#   5. Prints next steps.
#
# This is intentionally simpler than install.ps1 — full feature parity
# (session migration, sessionDir repair, settings.json patching) is tracked in
# TODO.md.
#
# Run once after cloning:
#   chmod +x install.sh
#   ./install.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Setting PI_CODING_AGENT_DIR=$repo_root"
export PI_CODING_AGENT_DIR="$repo_root"

# Persist the env var in the user's shell rc.
persist_env_var() {
  local rc="$1"
  local line="export PI_CODING_AGENT_DIR=\"$repo_root\""
  if [[ -f "$rc" ]] && grep -Fq "PI_CODING_AGENT_DIR=" "$rc"; then
    echo "==> $rc already exports PI_CODING_AGENT_DIR; not modifying"
    return
  fi
  printf '\n# Added by pi-config install.sh\n%s\n' "$line" >> "$rc"
  echo "==> Appended PI_CODING_AGENT_DIR export to $rc"
}

case "${SHELL##*/}" in
  zsh)  persist_env_var "$HOME/.zshrc" ;;
  bash) persist_env_var "$HOME/.bashrc" ;;
  *)    echo "==> Unknown shell ($SHELL); set PI_CODING_AGENT_DIR=$repo_root manually" ;;
esac

# Migrate auth.json from the old default location if missing.
old_auth="$HOME/.pi/agent/auth.json"
new_auth="$repo_root/auth.json"
if [[ -f "$old_auth" && ! -f "$new_auth" ]]; then
  echo "==> Migrating auth.json from $old_auth"
  cp "$old_auth" "$new_auth"
  chmod 600 "$new_auth"
elif [[ -f "$new_auth" ]]; then
  echo "==> auth.json already present in repo — skipping migration"
  # Defence in depth: ensure restrictive perms even if pre-existing.
  chmod 600 "$new_auth" 2>/dev/null || true
else
  echo "==> No existing auth.json found — authenticate pi on first run"
fi

# Tooling checks.
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: $1 is required but not found on PATH. $2" >&2
    exit 1
  fi
}

require_cmd node "Install Node.js 20+ from https://nodejs.org/"
require_cmd npm  "npm ships with Node.js"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 20 )); then
  echo "ERROR: Node.js 20+ required, found $(node -v)" >&2
  exit 1
fi

# Restore pi packages if the cli is available.
if command -v pi >/dev/null 2>&1; then
  echo "==> Running 'pi update' to restore packages from settings.json"
  pi update || echo "WARN: 'pi update' exited non-zero; continue manually if needed"
else
  echo "==> 'pi' CLI not on PATH; skipping package restore"
  echo "    Install with: npm i -g @mariozechner/pi-coding-agent"
fi

# ── Relocate auth.json out of the working tree ─────────────────────────────────
# See docs/internal/SECRET_AND_STORAGE_RELOCATION_PLAN.md Phase 2.
auth_dir_env="${PI_CODING_AGENT_AUTH_DIR:-}"
in_tree_auth="$repo_root/auth.json"

if [[ "$(uname)" == "Darwin" ]]; then
  target_auth_dir="$HOME/Library/Application Support/pie"
else
  target_auth_dir="${XDG_CONFIG_HOME:-$HOME/.config}/pie"
fi
target_auth="$target_auth_dir/auth.json"

if [[ -f "$in_tree_auth" && -z "$auth_dir_env" ]]; then
  echo ""
  echo "==> SECURITY: auth.json is inside the working tree."
  echo "    Target location: $target_auth"
  printf "    Move auth.json to the secure OS user-data directory? [Y/n] "
  read -r move_choice
  if [[ -z "$move_choice" || "$move_choice" =~ ^[Yy] ]]; then
    mkdir -p "$target_auth_dir"
    cp "$in_tree_auth" "$target_auth"

    # Verify the copy
    source_hash="$(shasum -a 256 "$in_tree_auth" | cut -d' ' -f1)"
    dest_hash="$(shasum -a 256 "$target_auth" | cut -d' ' -f1)"
    if [[ "$source_hash" != "$dest_hash" ]]; then
      rm -f "$target_auth"
      echo "WARN: Hash verification failed after copy. auth.json was NOT moved." >&2
    else
      chmod 600 "$target_auth"

      # Remove the in-tree file and leave a breadcrumb
      rm -f "$in_tree_auth"
      printf 'Relocated to: %s\nSee: docs/internal/SECRET_AND_STORAGE_RELOCATION_PLAN.md\n' "$target_auth" \
        > "$repo_root/auth.json.removed"

      # Persist the env var in the shell rc
      export PI_CODING_AGENT_AUTH_DIR="$target_auth_dir"
      persist_auth_env_var() {
        local rc="$1"
        local line="export PI_CODING_AGENT_AUTH_DIR=\"$target_auth_dir\""
        if [[ -f "$rc" ]] && grep -Fq "PI_CODING_AGENT_AUTH_DIR=" "$rc"; then
          return
        fi
        printf '\n# Added by pi-config install.sh (secret relocation)\n%s\n' "$line" >> "$rc"
      }
      case "${SHELL##*/}" in
        zsh)  persist_auth_env_var "$HOME/.zshrc" ;;
        bash) persist_auth_env_var "$HOME/.bashrc" ;;
        *)    echo "==> Unknown shell; set PI_CODING_AGENT_AUTH_DIR=$target_auth_dir manually" ;;
      esac

      echo "==> auth.json moved to '$target_auth' and PI_CODING_AGENT_AUTH_DIR set."
    fi
  else
    echo "WARN: auth.json remains in the working tree. See SECURITY.md for recommended hardening." >&2
  fi
elif [[ -f "$in_tree_auth" && -n "$auth_dir_env" ]]; then
  echo "WARN: auth.json exists in the working tree AND PI_CODING_AGENT_AUTH_DIR is set to '$auth_dir_env'. Consider removing the in-tree copy." >&2
fi

cat <<EOM

==> Done.

Resolved storage paths:
    Auth:     ${PI_CODING_AGENT_AUTH_DIR:-$repo_root}/auth.json
    Sessions: $repo_root/data/outcomes/sessions

Next steps:
  - Open a new shell (or 'source' your shell rc) so environment variables take effect.
  - Read SECURITY.md before sharing this checkout with anyone.
  - To build the pie VS Code extension from source:
      cd extension && npm install && npm run build
  - Cross-platform feature parity with install.ps1 is tracked in
    TODO.md.
EOM
