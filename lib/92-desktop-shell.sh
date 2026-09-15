#!/bin/sh
# Desktop PATH and launcher; existing credential stores stay with their apps.
mod_desktop_shell() {
    [ "$(uname -s)" = Darwin ] || { note "macOS only"; return "$RC_SKIP"; }
    ensure_dirs || return 1
    _desktop_rc="$RC_OK"
    if [ -e "$BIN_DIR/dev-tools" ] && [ ! -L "$BIN_DIR/dev-tools" ]; then
        note "dev-tools launcher exists and is not a symlink"; return 1
    fi
    if [ "$(readlink "$BIN_DIR/dev-tools" 2>/dev/null)" != "$REPO_DIR/bin/dev-tools" ]; then
        ln -sfn "$REPO_DIR/bin/dev-tools" "$BIN_DIR/dev-tools" || return 1
        _desktop_rc="$RC_UPDATED"
    fi
    _desktop_brew=$(brew --prefix) || return 1
    for _desktop_rcfile in "$HOME/.zshrc" "$HOME/.bashrc"; do
        _desktop_before=$(file_digest "$_desktop_rcfile")
        managed_block "$_desktop_rcfile" desktop-path <<BLOCK
export PATH=$(quote "$BIN_DIR:$_desktop_brew/bin:$_desktop_brew/sbin"):\$PATH
BLOCK
        [ $? -eq 0 ] || return 1
        [ "$(file_digest "$_desktop_rcfile")" = "$_desktop_before" ] || _desktop_rc="$RC_UPDATED"
    done
    note "dev-tools launcher and desktop PATH"
    return "$_desktop_rc"
}
