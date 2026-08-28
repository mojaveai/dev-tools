#!/bin/sh
# Claude Code: native install, settings, keybindings, long-lived OAuth token.

mod_claude() {
    _rc="$RC_OK"
    _before=''
    have claude && _before=$(claude --version 2>/dev/null | awk '{print $1}')

    if have claude; then
        claude update >/dev/null 2>&1 || true
    else
        # The native installer needs no Node at all. The npm package ships the
        # same binary but drags in a Node runtime.
        info "installing claude code"
        _tmp=$(mktemp "${TMPDIR:-/tmp}/claude.XXXXXX") || return 1
        download 'https://claude.ai/install.sh' "$_tmp" || { rm -f "$_tmp"; return 1; }
        bash "$_tmp" >/dev/null 2>&1 || { rm -f "$_tmp"; err "claude install failed"; return 1; }
        rm -f "$_tmp"
    fi
    have claude || { err "claude not on PATH after install"; return 1; }

    _after=$(claude --version 2>/dev/null | awk '{print $1}')
    [ "$_before" = "$_after" ] || _rc="$RC_UPDATED"

    mkdir -p "$HOME/.claude"

    # Merge, never overwrite: the user's own settings live in this file too.
    json_merge "$HOME/.claude/settings.json" < "$REPO_DIR/config/claude/settings.json"
    [ $? -eq 10 ] && _rc="$RC_UPDATED"

    # Keybindings are a separate file with no settings.json equivalent.
    _kb="$HOME/.claude/keybindings.json"
    _d0=$(file_digest "$_kb")
    cp "$REPO_DIR/config/claude/keybindings.json" "$_kb"
    chmod 600 "$_kb"
    [ "$(file_digest "$_kb")" = "$_d0" ] || _rc="$RC_UPDATED"

    # Only the two flags that suppress first-run onboarding. machineID, userID
    # and oauthAccount are machine-scoped and must regenerate here.
    printf '{"hasCompletedOnboarding":true,"installMethod":"native"}\n' \
        | json_merge "$HOME/.claude.json"
    [ $? -eq 10 ] && _rc="$RC_UPDATED"

    if secret_have CLAUDE_CODE_OAUTH_TOKEN; then
        # Written to a 0600 env file sourced by the shell rather than into
        # settings.json, which stays publish-safe and diffable.
        note "configured, $_after, token provisioned"
    else
        warn "CLAUDE_CODE_OAUTH_TOKEN unavailable -- run 'claude setup-token' once and vault it"
        note "configured, $_after, NOT logged in"
    fi
    return "$_rc"
}
