#!/bin/sh
# Native CUA routing is independent of the optional Linux viewer packages.
mod_native_browser() {
    have python3 || { note "Python >=3.11 required for native browser routing"; return 1; }
    ensure_dirs || return 1
    if [ -e "$BIN_DIR/dev-tools" ] && [ ! -L "$BIN_DIR/dev-tools" ]; then
        note "$BIN_DIR/dev-tools is not a managed symlink; refusing to overwrite"; return 1
    fi
    _native_changed=0
    if [ "$(readlink "$BIN_DIR/dev-tools" 2>/dev/null || true)" != "$REPO_DIR/bin/dev-tools" ]; then
        ln -sfn "$REPO_DIR/bin/dev-tools" "$BIN_DIR/dev-tools" || return 1
        _native_changed=1
    fi
    if [ -n "${DEVTOOLS_NATIVE_BROWSER_SOCKET:-}" ]; then
        python3 "$REPO_DIR/native_browser/configure.py" "$REPO_DIR" --socket "$DEVTOOLS_NATIVE_BROWSER_SOCKET"
    else
        python3 "$REPO_DIR/native_browser/configure.py" "$REPO_DIR"
    fi
    case $? in 0) : ;; 10) _native_changed=1 ;; *) note "native browser migration failed; see diagnostic"; return 1 ;; esac
    note "cua_repl routing configured; requires desktop native runtime; reconnect MCP to load"
    [ "$_native_changed" = 1 ] && return "$RC_UPDATED"
    return "$RC_OK"
}
