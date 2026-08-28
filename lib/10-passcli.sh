#!/bin/sh
# Proton Pass CLI: install, then authenticate with a scoped PAT.
# This runs first because every other secret comes out of the vault.

PASS_CLI_INSTALL_URL='https://proton.me/download/pass-cli/install.sh'
PAT_FILE="$STATE_DIR/proton-pass.pat"

# pass-cli keeps its database key in the *kernel keyring*. A key minted by one
# login belongs to that login's session keyring and is simply gone in any later
# shell -- surfacing as NoStorageAccess(KeyRevoked), which looks exactly like a
# bad credential and is not. Running inside a fresh session keyring makes
# pass-cli find no key, force-log-out, and cleanly re-establish from the PAT.
# Without keyctl we fall back to a file-backed key, which is a real downgrade:
# it puts the key beside the data it encrypts.
pass_keyring_mode() {
    if have keyctl; then echo keyctl; else echo fs; fi
}

# Run a shell snippet (on stdin) with an authenticated pass-cli in scope.
# Authentication and use must happen in the same process, hence one snippet.
pass_session_run() {
    _snippet=$(cat)
    _pre='pass-cli info >/dev/null 2>&1 || pass-cli login >/dev/null 2>&1 || exit 90;'
    if [ "$(pass_keyring_mode)" = keyctl ]; then
        keyctl session - /bin/sh -c "$_pre $_snippet"
    else
        PROTON_PASS_KEY_PROVIDER=fs /bin/sh -c "$_pre $_snippet"
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

mod_passcli() {
    _before=''
    have pass-cli && _before=$(pass-cli --version 2>/dev/null || echo '')

    passcli_install_or_update || { err "pass-cli install failed"; return 1; }
    have pass-cli || { err "pass-cli not on PATH after install"; return 1; }

    # The PAT reaches the machine out-of-band once, then persists 0600 so every
    # later convergence run needs no environment variable at all.
    if [ -n "${PROTON_PASS_PERSONAL_ACCESS_TOKEN:-}" ]; then
        umask 077
        printf '%s\n' "$PROTON_PASS_PERSONAL_ACCESS_TOKEN" > "$PAT_FILE"
        chmod 600 "$PAT_FILE"
    elif [ -f "$PAT_FILE" ]; then
        PROTON_PASS_PERSONAL_ACCESS_TOKEN=$(cat "$PAT_FILE")
        export PROTON_PASS_PERSONAL_ACCESS_TOKEN
    else
        warn "no Proton Pass PAT: set PROTON_PASS_PERSONAL_ACCESS_TOKEN once, or place it at $PAT_FILE"
        note "no PAT -- every secret-backed step will be skipped"
        return "$RC_SKIP"
    fi

    if [ "$(pass_keyring_mode)" = fs ]; then
        warn "keyctl absent: falling back to PROTON_PASS_KEY_PROVIDER=fs, which stores the"
        warn "  database key beside the encrypted data (install 'keyutils' to avoid this)"
    fi

    if ! echo 'exit 0' | pass_session_run; then
        err "pass-cli could not authenticate with the PAT"
        note "PAT rejected or expired"
        return 1
    fi

    DEVTOOLS_PASS_READY=1
    export DEVTOOLS_PASS_READY

    _after=$(pass-cli --version 2>/dev/null || echo '')
    note "authenticated${_after:+, $_after}"
    [ "$_before" = "$_after" ] && return "$RC_OK"
    return "$RC_UPDATED"
}
