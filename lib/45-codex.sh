#!/bin/sh
# Codex CLI: install, merge preferences, and verify the intended ChatGPT account.

codex_account_check() {
    if [ -n "${DEVTOOLS_CODEX_EXPECTED_EMAIL:-}" ]; then
        python3 "$REPO_DIR/auth/codex_account.py"
        return $?
    fi
    [ "${DEVTOOLS_PASS_READY:-0}" = 1 ] || return 4
    _identity_refs="${DEVTOOLS_CODEX_IDENTITY_REFS:-$REPO_DIR/config/codex/identity.refs}"
    [ -f "$_identity_refs" ] || return 4
    # Resolved identities exist only in this child. Never import credentials into
    # the parent provisioner, shell profile, or persistent configuration.
    printf 'pass-cli run --env-file %s -- python3 %s\n' \
        "$(quote "$_identity_refs")" "$(quote "$REPO_DIR/auth/codex_account.py")" \
        | pass_session_run
}

codex_auth_result() {
    case "$1" in
        0) note "configured ChatGPT account verified, $_after"; return "$_rc" ;;
        2) warn "Codex needs login to the configured ChatGPT account; run 'codex login --device-auth' then rerun" ;;
        3) warn "Codex account mismatch (or wrong login method); current credentials preserved. Intentionally switch accounts with 'codex login --device-auth', then rerun" ;;
        *) warn "Cannot verify the configured Codex account. Check codex/ChatGPT email in Proton Pass, or set DEVTOOLS_CODEX_EXPECTED_EMAIL. Also check 'codex app-server' is supported" ;;
    esac
    note "$_after, account NOT verified"
    return 1
}

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
        run_installer sh "$_tmp" || { rm -f "$_tmp"; note "install failed"; return 1; }
        rm -f "$_tmp"
    fi
    have codex || { err "codex not on PATH after install"; return 1; }

    _after=$(codex --version 2>/dev/null | awk '{print $NF}')
    [ "$_before" = "$_after" ] || _rc="$RC_UPDATED"

    _codex_dir="${CODEX_HOME:-$HOME/.codex}"
    mkdir -p "$_codex_dir"
    # Merge rather than overwrite: on a Coder workspace this file is rewritten
    # from a template on every start and carries model routing we must not lose.
    toml_merge "$_codex_dir/config.toml" < "$REPO_DIR/config/codex/keymap.toml"
    [ $? -eq 10 ] && _rc="$RC_UPDATED"

    codex_account_check
    _account_result=$?
    # Only an absent login can start onboarding. A different/unknown account is
    # never logged out or replaced implicitly, and a matching account is reused.
    if [ "$_account_result" -eq 2 ] && [ "${DEVTOOLS_NONINTERACTIVE:-0}" != 1 ] && ( true < /dev/tty ) 2>/dev/null; then
        info "Codex needs a one-time login to the configured ChatGPT account"
        codex login --device-auth </dev/tty >/dev/tty 2>&1 || warn "Codex login did not complete"
        codex_account_check
        _account_result=$?
        [ "$_account_result" -ne 0 ] || _rc="$RC_UPDATED"
    fi
    codex_auth_result "$_account_result"
}
