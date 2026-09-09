#!/bin/sh
# Native, shareable browser sessions. Pilot is opt-in until both acceptance
# environments pass; already-installed hosts continue to converge on reruns.

# Browser sessions publish and remove their own Serve routes as the Linux user.
# Configure this once instead of requiring sudo on every lifecycle operation.
browser_serve_operator() {
    have tailscale || return 0
    [ "$(ts_state)" = Running ] || return 0
    _browser_user=$(id -un)
    _browser_prefs=$(tailscale debug prefs 2>/dev/null) || {
        can_privileged || { note "Serve setup requires sudo to inspect Tailscale operator"; return 1; }
        _browser_prefs=$(run_privileged tailscale debug prefs) || return 1
    }
    _browser_operator=$(printf '%s' "$_browser_prefs" | jq -r '.OperatorUser // ""') || return 1
    [ "$_browser_operator" != "$_browser_user" ] || return 0
    if [ -n "$_browser_operator" ]; then
        note "Tailscale operator belongs to another user; ask the host owner to designate $_browser_user"; return 1
    fi
    can_privileged || { note "Serve setup requires sudo; rerun interactively to configure the browser user"; return 1; }
    run_privileged tailscale set --operator="$_browser_user" || return 1
    _browser_changed=1
}

mod_browser() {
    _browser_config=${DEVTOOLS_BROWSER_CONFIG:-$HOME/.config/dev-tools/browser.json}
    if [ "${DEVTOOLS_BROWSER_ENABLED:-0}" != 1 ] && [ ! -f "$_browser_config" ]; then
        note "pilot: enable with --with-browser (no changes made)"
        return "$RC_SKIP"
    fi
    if [ "$(uname -s)" != Linux ]; then
        note "native browser requires Linux"
        return "$RC_SKIP"
    fi
    _browser_os=$( . /etc/os-release; printf '%s' "$ID" )
    case "$_browser_os:$(arch)" in
        ubuntu:x86_64|ubuntu:aarch64|debian:x86_64|debian:aarch64) : ;;
        *) note "unsupported native browser platform: $_browser_os/$(arch)"; return "$RC_SKIP" ;;
    esac
    # Stay unprivileged for Chromium, but acquire sudo once for native packages,
    # the AppArmor exception and Serve operator setup when needed.
    if ! can_privileged && have sudo && [ "${DEVTOOLS_NONINTERACTIVE:-0}" != 1 ] && ( true < /dev/tty ) 2>/dev/null; then
        info "browser provisioning may need sudo for host setup"
        sudo -v </dev/tty || { note "browser host setup needs sudo"; return 1; }
    fi
    _browser_changed=0
    _browser_missing=''
    for _browser_pkg in tigervnc-standalone-server openbox novnc websockify xauth; do
        dpkg-query -W -f='${Status}' "$_browser_pkg" 2>/dev/null | grep -q '^install ok installed$' || \
            _browser_missing="$_browser_missing $_browser_pkg"
    done
    # NodeSource and standalone Node distributions include npm without a Debian
    # npm package. Installing that package would conflict with a healthy runtime.
    have node || _browser_missing="$_browser_missing nodejs"
    have npm || _browser_missing="$_browser_missing npm"
    if [ -n "$_browser_missing" ]; then
        can_privileged || { note "missing packages:$_browser_missing; root/sudo required"; return "$RC_SKIP"; }
        pkg_refresh_once
        # shellcheck disable=SC2086
        run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y $_browser_missing || {
            note "native desktop package installation incomplete; rerun to resume"; return 1;
        }
        _browser_changed=1
    fi
    node -e 'if (Number(process.versions.node.split(".")[0]) < 18) process.exit(1)' || {
        note "Node >=18 required; upgrade the host Node runtime"; return 1;
    }
    _browser_runtime=${DEVTOOLS_BROWSER_RUNTIME:-$HOME/.local/share/dev-tools-browser/runtime}
    mkdir -p "$_browser_runtime" || return 1
    _browser_want=$(sha256sum "$REPO_DIR/config/browser/package-lock.json" | cut -d ' ' -f 1)
    _browser_have=$(cat "$_browser_runtime/.complete" 2>/dev/null || true)
    if [ "$_browser_want" != "$_browser_have" ] || [ ! -f "$_browser_runtime/node_modules/@playwright/mcp/cli.js" ] || [ ! -f "$_browser_runtime/node_modules/mcp-remote/dist/proxy.js" ] || ! (cd "$_browser_runtime" && npm ls --all --omit=dev --silent >/dev/null 2>&1); then
        cp "$REPO_DIR/config/browser/package.json" "$REPO_DIR/config/browser/package-lock.json" "$_browser_runtime/" || return 1
        (cd "$_browser_runtime" && npm ci --no-audit --no-fund) || {
            note "npm runtime incomplete; rerun to resume"; return 1;
        }
        # Stamp only after all runtime setup, including browser deps, succeeds.
        rm -f "$_browser_runtime/.complete"
        _browser_changed=1
    fi
    _browser_chromium=$(cd "$_browser_runtime" && node -e 'process.stdout.write(require("playwright").chromium.executablePath())') || return 1
    if [ ! -x "$_browser_chromium" ]; then
        (cd "$_browser_runtime" && node node_modules/playwright/cli.js install chromium) || {
            note "Chromium download incomplete; rerun to resume"; return 1;
        }
        _browser_changed=1
    fi
    if [ "$_browser_want" != "$_browser_have" ] || ldd "$_browser_chromium" 2>/dev/null | grep -q 'not found'; then
        can_privileged || { note "Chromium system dependencies require root/sudo"; return "$RC_SKIP"; }
        run_privileged "$(command -v node)" "$_browser_runtime/node_modules/playwright/cli.js" install-deps chromium || {
            note "Chromium system dependencies incomplete; rerun to resume"; return 1;
        }
        _browser_changed=1
    fi
    python3 "$REPO_DIR/browser/sandbox.py" repair "$_browser_chromium"
    case $? in
        0) : ;;
        10) _browser_changed=1 ;;
        *) note "Chromium sandbox unavailable; see diagnostic above, then rerun"; return 1 ;;
    esac
    printf '%s\n' "$_browser_want" > "$_browser_runtime/.complete"
    browser_serve_operator || return 1
    ensure_dirs
    if [ -e "$BIN_DIR/dev-tools" ] && [ ! -L "$BIN_DIR/dev-tools" ]; then
        note "$BIN_DIR/dev-tools exists and is not a managed symlink; refusing to overwrite"; return 1
    fi
    if [ "$(readlink "$BIN_DIR/dev-tools" 2>/dev/null || true)" != "$REPO_DIR/bin/dev-tools" ]; then
        ln -sfn "$REPO_DIR/bin/dev-tools" "$BIN_DIR/dev-tools" || return 1
        _browser_changed=1
    fi
    _browser_patches=$(python3 "$REPO_DIR/browser/configure.py" "$REPO_DIR" "$_browser_runtime" "$BIN_DIR/dev-tools") || {
        note "browser configuration failed"; return 1;
    }
    [ "$(printf '%s' "$_browser_patches" | jq -r '.changed')" = true ] && _browser_changed=1
    printf '%s' "$_browser_patches" | jq -r '.codex' | toml_merge "${DEVTOOLS_CODEX_CONFIG:-${CODEX_HOME:-$HOME/.codex}/config.toml}"
    case $? in 0) : ;; 10) _browser_changed=1 ;; *) note "Codex browser configuration failed"; return 1 ;; esac
    printf '%s' "$_browser_patches" | jq '.claude' | json_merge "${DEVTOOLS_CLAUDE_CONFIG:-$HOME/.claude.json}"
    case $? in 0) : ;; 10) _browser_changed=1 ;; *) note "Claude browser configuration failed"; return 1 ;; esac
    # Upgrade the viewer endpoint for existing desktops without restarting
    # Chromium or disturbing profiles/tabs. New sessions use the new viewer.
    python3 "$REPO_DIR/browser/upgrade_viewer.py" || {
        note "browser installed; running viewer upgrade incomplete, rerun to retry"; return 1;
    }
    note "local browser ready; dev-tools browser doctor reports viewer readiness; restart agent to load MCP"
    [ "$_browser_changed" = 1 ] && return "$RC_UPDATED"
    return "$RC_OK"
}
