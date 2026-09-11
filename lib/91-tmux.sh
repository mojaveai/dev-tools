#!/bin/sh
# Mouse wheel scrollback, without requiring the user to enter copy mode first.

mod_tmux() {
    have tmux || { note "tmux unavailable"; return "$RC_SKIP"; }
    _tmux_config="${DEVTOOLS_TMUX_CONFIG:-}"
    if [ -z "$_tmux_config" ]; then
        _tmux_config="$HOME/.tmux.conf"
        _tmux_xdg="${XDG_CONFIG_HOME:-$HOME/.config}/tmux/tmux.conf"
        if [ ! -e "$_tmux_config" ] && [ -f "$_tmux_xdg" ]; then
            _tmux_config="$_tmux_xdg"
        fi
    fi
    mkdir -p "$(dirname "$_tmux_config")" || return 1
    _tmux_before=$(file_digest "$_tmux_config")
    managed_block "$_tmux_config" "tmux-mouse" <<'BLOCK'
# Scroll up to enter history automatically; scroll down to the bottom to exit.
set -g mouse on
BLOCK
    [ $? -eq 0 ] || return 1
    _tmux_rc="$RC_OK"
    [ "$(file_digest "$_tmux_config")" = "$_tmux_before" ] || _tmux_rc="$RC_UPDATED"

    # Update the current/default server without reloading unrelated user config
    # or starting a tmux server when none is running.
    _tmux_mouse=$(tmux show-options -gv mouse 2>/dev/null) || _tmux_mouse=''
    if [ -n "$_tmux_mouse" ] && [ "$_tmux_mouse" != on ]; then
        tmux set-option -g mouse on || { note "could not enable mouse in running tmux"; return 1; }
        _tmux_rc="$RC_UPDATED"
    fi
    note "mouse wheel scrollback enabled"
    return "$_tmux_rc"
}
