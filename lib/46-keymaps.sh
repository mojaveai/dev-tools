#!/bin/sh
# Configuration-only setup also works on desktops with existing CLI sign-ins.
mod_keymaps() {
    _km_before="$(file_digest "${CODEX_HOME:-$HOME/.codex}/config.toml") $(file_digest "$HOME/.claude/keybindings.json")"
    sh "$REPO_DIR/config/apply-keymaps.sh" || { note "keymap application failed"; return 1; }
    _km_after="$(file_digest "${CODEX_HOME:-$HOME/.codex}/config.toml") $(file_digest "$HOME/.claude/keybindings.json")"
    note "mobile keymaps; restart Codex when ready"
    [ "$_km_before" = "$_km_after" ] && return "$RC_OK"
    return "$RC_UPDATED"
}
