#!/bin/sh
# Codex CLI: standalone install, keymap merge, interactive login.

mod_codex() {
    _rc="$RC_OK"
    _before=''
    have codex && _before=$(codex --version 2>/dev/null | awk '{print $NF}')

    if have codex; then
        codex update >/dev/null 2>&1 || true
    else
        info "installing codex"
        _tmp=$(mktemp "${TMPDIR:-/tmp}/codex.XXXXXX") || return 1
        download 'https://chatgpt.com/codex/install.sh' "$_tmp" || { rm -f "$_tmp"; return 1; }
        sh "$_tmp" >/dev/null 2>&1 || { rm -f "$_tmp"; err "codex install failed"; return 1; }
        rm -f "$_tmp"
    fi
    have codex || { err "codex not on PATH after install"; return 1; }

    _after=$(codex --version 2>/dev/null | awk '{print $NF}')
    [ "$_before" = "$_after" ] || _rc="$RC_UPDATED"

    mkdir -p "$HOME/.codex"
    # Merge rather than overwrite: on a Coder workspace this file is rewritten
    # from a template on every start and carries model routing we must not lose.
    toml_merge "$HOME/.codex/config.toml" < "$REPO_DIR/config/codex/keymap.toml"
    [ $? -eq 10 ] && _rc="$RC_UPDATED"

    if codex login status >/dev/null 2>&1; then
        note "logged in, $_after"
        return "$_rc"
    fi

    # ChatGPT-plan login has no non-interactive path; --with-api-key exists but
    # would bill API rates instead of the subscription.
    if [ "${DEVTOOLS_NONINTERACTIVE:-0}" != "1" ] && ( true < /dev/tty ) 2>/dev/null; then
        info "codex needs a one-time login for this machine"
        codex login </dev/tty >/dev/tty 2>&1 || warn "codex login did not complete"
        if codex login status >/dev/null 2>&1; then
            note "logged in, $_after"
            return "$RC_UPDATED"
        fi
    fi

    warn "codex is not logged in -- run 'codex login' on this machine"
    note "$_after, NOT logged in"
    return "$RC_SKIP"
}
