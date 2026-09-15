#!/bin/sh
# Apply the provisioned keymaps without installing tools or accessing credentials.
set -u
REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
. "$REPO_DIR/lib/common.sh"

case "${1:-all}" in
    codex|claude|all) keymap_target=${1:-all} ;;
    *) printf 'Usage: dev-tools keymap [codex|claude|all]\n' >&2; exit 1 ;;
esac
[ "$#" -le 1 ] || { printf 'Usage: dev-tools keymap [codex|claude|all]\n' >&2; exit 1; }

if [ "$keymap_target" != claude ]; then
    # A desktop may already use Keychain for sign-in. Only headless hosts need
    # the file credential store; applying a keymap must preserve desktop auth.
    if [ "$(uname -s)" = Darwin ]; then
        sed '/^cli_auth_credentials_store =/d' "$REPO_DIR/config/codex/keymap.toml" \
            | toml_merge "${CODEX_HOME:-$HOME/.codex}/config.toml"
    else
        toml_merge "${CODEX_HOME:-$HOME/.codex}/config.toml" < "$REPO_DIR/config/codex/keymap.toml"
    fi
    case $? in 0|10) : ;; *) exit 1 ;; esac
    printf 'Codex mobile keymap applied. Restart Codex to use it.\n'
fi
if [ "$keymap_target" != codex ]; then
    mkdir -p "$HOME/.claude" || exit 1
    cp "$REPO_DIR/config/claude/keybindings.json" "$HOME/.claude/keybindings.json" || exit 1
    chmod 600 "$HOME/.claude/keybindings.json" || exit 1
    printf 'Claude Code keymap applied (Enter: newline, Tab: submit).\n'
fi
