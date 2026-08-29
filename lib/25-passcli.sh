#!/bin/sh
# Proton Pass CLI: install, then leave this machine holding a SCOPED session.
#
# Privilege de-escalation. A human login is full-vault, which is more than a dev
# box should keep. So the full session is used only long enough to mint a scoped,
# expiring, per-machine token -- then it is logged out and the token is used
# instead. What persists on disk is only ever the scoped credential.
#
#   pass-cli login                 human approves a link      (full vault)
#   pass-cli pat create            mint dev-<host>, expiring
#   pass-cli pat access grant      scope it to named vaults, viewer
#   pass-cli logout                full session destroyed
#   pass-cli login --pat           re-auth, scoped             (persists)
#
# Per-machine means one box can be revoked without touching the others, and
# `pass-cli pat list` shows which machine each token belongs to.

PASS_CLI_INSTALL_URL='https://proton.me/download/pass-cli/install.sh'
PAT_FILE="$STATE_DIR/proton-pass.pat"
PAT_ID_FILE="$STATE_DIR/proton-pass.pat.id"
# Pinned rather than left to the default, so the escalation and the scoped phase
# demonstrably operate on the same store -- and so it can be wiped between them.
PROTON_PASS_SESSION_DIR="${PROTON_PASS_SESSION_DIR:-$STATE_DIR/proton-pass-session}"
export PROTON_PASS_SESSION_DIR

# Vaults the scoped token may read. Space-separated.
PAT_VAULTS="${DEVTOOLS_PAT_VAULTS:-codex}"
PAT_EXPIRATION="${DEVTOOLS_PAT_EXPIRATION:-3m}"
PAT_NAME="${DEVTOOLS_PAT_NAME:-dev-$(hostname 2>/dev/null | cut -d. -f1)}"
PASS_LOGIN_TIMEOUT="${DEVTOOLS_PASS_LOGIN_TIMEOUT:-600}"

# pass-cli keeps its database key in the *kernel keyring*. A key minted by one
# login belongs to that login's session keyring and is gone in any later shell --
# surfacing as NoStorageAccess(KeyRevoked), which looks like a bad credential and
# is not. With a token we exploit that: each access runs in a fresh session
# keyring, finds no key, force-logs-out and re-authenticates, so nothing
# persists. The escalation dance below instead needs one session to survive
# across several processes, so it runs on a file-backed key.
pass_mode() {
    if [ -n "${PROTON_PASS_PERSONAL_ACCESS_TOKEN:-}" ]; then echo pat; else echo interactive; fi
}

# `keyctl` being installed is not the same as it working. Container runtimes
# commonly deny the keyring syscalls (Docker's default seccomp profile does), and
# `keyctl session -` then fails with "Operation not permitted" -- which surfaces
# as an authentication failure and looks like a bad credential. Probe once.
keyctl_usable() {
    case "${_DEVTOOLS_KEYCTL_OK:-}" in
        yes) return 0 ;;
        no)  return 1 ;;
    esac
    if have keyctl && keyctl session - /bin/true >/dev/null 2>&1; then
        _DEVTOOLS_KEYCTL_OK=yes
    else
        _DEVTOOLS_KEYCTL_OK=no
        have keyctl && warn "the kernel keyring is unavailable here (containerised?); using a file-backed key"
    fi
    [ "$_DEVTOOLS_KEYCTL_OK" = yes ]
}

pass_session_run() {
    _snippet=$(cat)
    if [ "$(pass_mode)" = pat ] && keyctl_usable; then
        keyctl session - /bin/sh -c "pass-cli info >/dev/null 2>&1 || pass-cli login >/dev/null 2>&1 || exit 90; $_snippet"
    else
        PROTON_PASS_KEY_PROVIDER="${PROTON_PASS_KEY_PROVIDER:-fs}" \
            /bin/sh -c "pass-cli info >/dev/null 2>&1 || exit 90; $_snippet"
    fi
}

pass_authenticated() { echo 'exit 0' | pass_session_run >/dev/null 2>&1; }

# Same check, but reports what pass-cli actually said. Used on the failure path,
# where a silent 'did not authenticate' is close to undiagnosable.
pass_auth_diagnose() {
    _dlog=$(mktemp "${TMPDIR:-/tmp}/passauth.XXXXXX") || return 1
    if [ "$(pass_mode)" = pat ] && keyctl_usable; then
        keyctl session - /bin/sh -c 'pass-cli info || pass-cli login' >"$_dlog" 2>&1
    else
        PROTON_PASS_KEY_PROVIDER="${PROTON_PASS_KEY_PROVIDER:-fs}" \
            /bin/sh -c 'pass-cli info || pass-cli login' >"$_dlog" 2>&1
    fi
    err "pass-cli reported:"
    sed -e 's/\x1b\[[0-9;]*m//g' -e "s/pst_[A-Za-z0-9_-]*::[A-Za-z0-9_-]*/pst_<redacted>/g" \
        "$_dlog" | tail -10 | sed 's/^/      /' >&2
    rm -f "$_dlog"
}

passcli_install_or_update() {
    if have pass-cli; then
        PROTON_PASS_NO_UPDATE_CHECK=1 pass-cli update -y >/dev/null 2>&1 || true
        return 0
    fi
    info "installing pass-cli"
    # Proton's installer is #!/bin/bash and uses bash-only syntax, so it must not
    # be run with sh -- which is dash on Debian and Ubuntu and dies on line 80.
    # It also requires jq, which mod_base installs.
    have bash || { err "pass-cli's installer requires bash, which is not installed"; return 1; }
    have jq   || { err "pass-cli's installer requires jq, which is not installed"; return 1; }

    _tmp=$(mktemp "${TMPDIR:-/tmp}/passcli.XXXXXX") || return 1
    download "$PASS_CLI_INSTALL_URL" "$_tmp" || { rm -f "$_tmp"; return 1; }
    run_installer bash "$_tmp" || { rm -f "$_tmp"; return 1; }
    rm -f "$_tmp"

    have pass-cli || { err "pass-cli installed but is not on PATH"; return 1; }
    return 0
}

pass_login_interactive() {
    printf '\n'
    printf '%s  Proton Pass needs you to approve this machine.%s\n' "$C_BLD" "$C_RESET"
    printf '  Open the link it prints below and sign in. This full-vault session is\n'
    printf '  used only to mint a scoped token, then dropped.\n\n'
    PROTON_PASS_KEY_PROVIDER=fs timeout "$PASS_LOGIN_TIMEOUT" pass-cli login
    _rc=$?
    printf '\n'
    [ "$_rc" -eq 124 ] && { err "timed out waiting for Proton Pass approval"; return 1; }
    return "$_rc"
}

# Mint + scope, capturing the token without ever printing it. Field names are
# read defensively: the token is whatever matches the pst_<token>::<key> shape,
# so a schema change does not silently produce an empty credential.
pass_mint_scoped_token() {
    _json=$(PROTON_PASS_KEY_PROVIDER=fs pass-cli pat create \
        --name "$PAT_NAME" --expiration "$PAT_EXPIRATION" --output json 2>/dev/null) || return 1

    _parsed=$(printf '%s' "$_json" | python3 -c '
import json, re, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
tok = pid = ""
def walk(o):
    global tok, pid
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, str):
                if re.match(r"^pst_[^:]+::.+$", v):
                    tok = v
                elif "id" in k.lower() and not pid and len(v) > 8:
                    pid = v
            else:
                walk(v)
    elif isinstance(o, list):
        for v in o:
            walk(v)
walk(d)
if not tok:
    sys.exit(2)
print(tok); print(pid)
') || _parsed=''

    MINTED_TOKEN=$(printf '%s' "$_parsed" | sed -n 1p)
    MINTED_ID=$(printf '%s' "$_parsed" | sed -n 2p)

    # Fall back to the plain-text form, which prints the token as a ready-made
    # assignment, in case --output json is unavailable or reshaped.
    if [ -z "$MINTED_TOKEN" ]; then
        MINTED_TOKEN=$(printf '%s' "$_json" | grep -oE 'pst_[A-Za-z0-9_-]+::[A-Za-z0-9_-]+' | head -1)
    fi
    [ -n "$MINTED_TOKEN" ] || return 1
    # Shape only -- a truncated or malformed capture is the failure mode that
    # would otherwise look like a rejected credential.
    case "$MINTED_TOKEN" in
        pst_*::*) dbg "minted token: ${#MINTED_TOKEN} chars, well-formed" ;;
        *) err "minted token is malformed (${#MINTED_TOKEN} chars)"; return 1 ;;
    esac

    _granted=0
    for _v in $PAT_VAULTS; do
        if PROTON_PASS_KEY_PROVIDER=fs pass-cli pat access grant \
            --personal-access-token-name "$PAT_NAME" \
            --vault-name "$_v" --role viewer >/dev/null 2>&1
        then
            _granted=$((_granted + 1))
        else
            warn "could not grant the new token access to vault '$_v'"
        fi
    done
    # A token with no grants reads nothing; better to fail loudly than to drop
    # to a credential that cannot do its job.
    [ "$_granted" -gt 0 ] || { err "the minted token was granted no vault access"; return 1; }
    note_granted=$_granted
    return 0
}

# Full session -> scoped session. Never leaves the full one lying around.
pass_escalate_then_drop() {
    pass_login_interactive || return 1

    info "minting a scoped token for this machine ($PAT_NAME, expires in $PAT_EXPIRATION)"
    if ! pass_mint_scoped_token; then
        err "could not mint a scoped token"
        warn "logging out of the full-vault session anyway"
        PROTON_PASS_KEY_PROVIDER=fs pass-cli logout --force >/dev/null 2>&1 || true
        return 1
    fi

    info "dropping the full-vault session"
    PROTON_PASS_KEY_PROVIDER=fs pass-cli logout --force >/dev/null 2>&1 || \
        warn "logout reported an error; the session may still be active remotely"

    # The interactive phase encrypted the local database with a file-backed key.
    # The scoped phase runs in a fresh kernel keyring, where that key does not
    # exist, so pass-cli would meet a database it cannot decrypt and refuse to
    # re-authenticate. Clearing the store makes the scoped login start clean --
    # and also leaves nothing behind from the full-vault session.
    rm -rf "$PROTON_PASS_SESSION_DIR"

    umask 077
    printf '%s\n' "$MINTED_TOKEN" > "$PAT_FILE"; chmod 600 "$PAT_FILE"
    [ -n "$MINTED_ID" ] && { printf '%s\n' "$MINTED_ID" > "$PAT_ID_FILE"; chmod 600 "$PAT_ID_FILE"; }

    PROTON_PASS_PERSONAL_ACCESS_TOKEN="$MINTED_TOKEN"
    export PROTON_PASS_PERSONAL_ACCESS_TOKEN
    MINTED_TOKEN=''

    if ! pass_authenticated; then
        err "the scoped token did not authenticate"
        pass_auth_diagnose
        warn "the token exists in your account as '$PAT_NAME'; delete it with:"
        warn "  pass-cli pat delete --personal-access-token-name '$PAT_NAME'"
        return 1
    fi
    return 0
}

mod_passcli() {
    _before=''
    have pass-cli && _before=$(pass-cli --version 2>/dev/null || echo '')

    passcli_install_or_update || { note "install failed"; return 1; }
    have pass-cli || { err "pass-cli not on PATH after install"; return 1; }
    _after=$(pass-cli --version 2>/dev/null || echo '')

    # An environment-supplied token wins and persists (unattended provisioning).
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
        note "scoped session active${_after:+, $_after}"
        [ "$_before" = "$_after" ] && return "$RC_OK"
        return "$RC_UPDATED"
    fi

    _had_token=0
    [ -n "${PROTON_PASS_PERSONAL_ACCESS_TOKEN:-}" ] && _had_token=1

    if [ "${DEVTOOLS_NONINTERACTIVE:-0}" = "1" ] || ! ( true < /dev/tty ) 2>/dev/null; then
        if [ "$_had_token" = 1 ]; then
            err "the stored token was rejected (expired?) and this run cannot prompt"
            note "token expired; re-run interactively to rotate"
            return 1
        fi
        warn "vault locked; run again interactively, or set PROTON_PASS_PERSONAL_ACCESS_TOKEN"
        note "needs an interactive login"
        return "$RC_SKIP"
    fi

    # An expired token is the normal end of its life: escalate once, mint a
    # fresh one, drop back down. That makes rotation automatic.
    [ "$_had_token" = 1 ] && info "stored token is no longer valid; rotating it"
    unset PROTON_PASS_PERSONAL_ACCESS_TOKEN

    pass_escalate_then_drop || { note "could not establish a scoped session"; return 1; }

    DEVTOOLS_PASS_READY=1; export DEVTOOLS_PASS_READY
    note "scoped to ${note_granted:-?} vault(s), expires in $PAT_EXPIRATION"
    return "$RC_UPDATED"
}
