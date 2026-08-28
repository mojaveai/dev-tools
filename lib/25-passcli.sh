#!/bin/sh
# Proton Pass CLI: install, then unlock the vault.
#
# Two ways in, in order of preference:
#   1. A scoped personal access token, if one was supplied. Fully unattended.
#   2. Interactive login, which prints a URL you approve in a browser. This is
#      the normal path on a new machine and needs nothing carried to it.
#
# The vault is the secrets server; Proton runs it. Nothing is self-hosted.

PASS_CLI_INSTALL_URL='https://proton.me/download/pass-cli/install.sh'
PAT_FILE="$STATE_DIR/proton-pass.pat"
# Generous: enough time to unlock a phone, open the link and approve.
PASS_LOGIN_TIMEOUT="${DEVTOOLS_PASS_LOGIN_TIMEOUT:-300}"

# pass-cli keeps its database key in the *kernel keyring*. A key minted by one
# login belongs to that login's session keyring and is simply gone in any later
# shell -- surfacing as NoStorageAccess(KeyRevoked), which looks exactly like a
# bad credential and is not.
#
# With a PAT we sidestep it: run each access in a fresh session keyring, where
# pass-cli finds no key, force-logs-out, and re-authenticates from the token.
# An interactive login cannot do that -- there is no token to replay, and a
# fresh keyring would throw away the session you just approved. So an
# interactive session is kept on a file-backed key, which persists across runs:
# you approve once per machine rather than once per run. The trade-off is that
# the key sits beside the data it encrypts.
pass_mode() {
    if [ -n "${PROTON_PASS_PERSONAL_ACCESS_TOKEN:-}" ]; then echo pat; else echo interactive; fi
}

# Run a shell snippet (on stdin) with an authenticated pass-cli in scope.
# Authentication and use must happen in the same process, hence one snippet.
pass_session_run() {
    _snippet=$(cat)
    if [ "$(pass_mode)" = pat ] && have keyctl; then
        keyctl session - /bin/sh -c "pass-cli info >/dev/null 2>&1 || pass-cli login >/dev/null 2>&1 || exit 90; $_snippet"
    else
        PROTON_PASS_KEY_PROVIDER="${PROTON_PASS_KEY_PROVIDER:-fs}" \
            /bin/sh -c "pass-cli info >/dev/null 2>&1 || exit 90; $_snippet"
    fi
}

passcli_install_or_update() {
    if have pass-cli; then
        PROTON_PASS_NO_UPDATE_CHECK=1 pass-cli update -y >/dev/null 2>&1 || true
        return 0
    fi
    info "installing pass-cli"
    _tmp=$(mktemp "${TMPDIR:-/tmp}/passcli.XXXXXX") || return 1
    download "$PASS_CLI_INSTALL_URL" "$_tmp" || { rm -f "$_tmp"; return 1; }
    sh "$_tmp" >/dev/null 2>&1 || { rm -f "$_tmp"; return 1; }
    rm -f "$_tmp"
    have pass-cli
}

# Already-valid session? Nothing to do.
pass_authenticated() {
    echo 'exit 0' | pass_session_run 2>/dev/null
}

# Print the approval URL and wait. pass-cli emits the link on stdout and blocks
# until the browser side completes.
pass_login_interactive() {
    printf '\n'
    printf '%s  Proton Pass needs you to approve this machine.%s\n' "$C_BLD" "$C_RESET"
    printf '  Open the link it prints below and sign in; provisioning continues automatically.\n'
    printf '  Waiting up to %ss.\n\n' "$PASS_LOGIN_TIMEOUT"

    PROTON_PASS_KEY_PROVIDER="${PROTON_PASS_KEY_PROVIDER:-fs}" \
        timeout "$PASS_LOGIN_TIMEOUT" pass-cli login
    _rc=$?
    printf '\n'
    [ "$_rc" -eq 124 ] && { err "timed out waiting for Proton Pass approval"; return 1; }
    return "$_rc"
}

mod_passcli() {
    _before=''
    have pass-cli && _before=$(pass-cli --version 2>/dev/null || echo '')

    passcli_install_or_update || { err "pass-cli install failed"; return 1; }
    have pass-cli || { err "pass-cli not on PATH after install"; return 1; }
    _after=$(pass-cli --version 2>/dev/null || echo '')

    # A token supplied by the environment wins, and persists for later runs.
    if [ -n "${PROTON_PASS_PERSONAL_ACCESS_TOKEN:-}" ]; then
        umask 077
        printf '%s\n' "$PROTON_PASS_PERSONAL_ACCESS_TOKEN" > "$PAT_FILE"
        chmod 600 "$PAT_FILE"
    elif [ -s "$PAT_FILE" ]; then
        PROTON_PASS_PERSONAL_ACCESS_TOKEN=$(cat "$PAT_FILE")
        export PROTON_PASS_PERSONAL_ACCESS_TOKEN
    fi

    if pass_authenticated; then
        DEVTOOLS_PASS_READY=1; export DEVTOOLS_PASS_READY
        note "vault unlocked ($(pass_mode))${_after:+, $_after}"
        [ "$_before" = "$_after" ] && return "$RC_OK"
        return "$RC_UPDATED"
    fi

    if [ "$(pass_mode)" = pat ]; then
        err "the supplied Proton Pass token was rejected"
        note "token rejected or expired"
        return 1
    fi

    if [ "${DEVTOOLS_NONINTERACTIVE:-0}" = "1" ] || ! ( true < /dev/tty ) 2>/dev/null; then
        warn "vault locked; run again interactively, or set PROTON_PASS_PERSONAL_ACCESS_TOKEN"
        note "needs an interactive login"
        return "$RC_SKIP"
    fi

    pass_login_interactive || { note "login not completed"; return 1; }
    pass_authenticated || { err "still not authenticated after login"; note "login failed"; return 1; }

    DEVTOOLS_PASS_READY=1; export DEVTOOLS_PASS_READY
    note "vault unlocked (interactive)${_after:+, $_after}"
    return "$RC_UPDATED"
}
