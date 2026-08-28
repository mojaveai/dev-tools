#!/bin/sh
# Fetch the Proton Pass bootstrap token from a tailnet-only endpoint.
#
# Being on the tailnet IS the credential here: the server authorises callers by
# Tailscale identity (tailscale whois), so nothing has to be typed or stored on
# the machine beforehand. See server/secrets-server.py.

# A short MagicDNS name, so no tailnet domain has to live in a public repo.
SECRETS_HOST="${DEVTOOLS_SECRETS_HOST:-dev-secrets}"
SECRETS_PORT="${DEVTOOLS_SECRETS_PORT:-8099}"
SECRETS_URL="${DEVTOOLS_SECRETS_URL:-http://${SECRETS_HOST}:${SECRETS_PORT}/bootstrap}"

# In userspace-networking mode the machine has no tailnet interface of its own,
# so its outbound traffic does not route over the tailnet -- it has to go via
# the SOCKS5 proxy. socks5h (rather than socks5) also sends DNS through the
# proxy, which is what makes the MagicDNS name resolve.
ts_curl() {
    if tailscale status --json 2>/dev/null | jq -e '.TUN == false' >/dev/null 2>&1; then
        curl --proxy "socks5h://${DEVTOOLS_TS_SOCKS:-localhost:1055}" "$@"
    else
        curl "$@"
    fi
}

mod_bootstrap_secret() {
    _pat="$STATE_DIR/proton-pass.pat"
    ensure_dirs

    # Supplied directly (env var, or a Termius snippet): nothing to fetch.
    if [ -n "${PROTON_PASS_PERSONAL_ACCESS_TOKEN:-}" ]; then
        note "token supplied by environment"
        return "$RC_OK"
    fi
    if [ -s "$_pat" ]; then
        note "token already present"
        return "$RC_OK"
    fi

    [ "$(ts_state)" = "Running" ] || {
        note "not on the tailnet yet"; return "$RC_SKIP"; }

    _tmp=$(mktemp "${TMPDIR:-/tmp}/bootsec.XXXXXX") || return 1
    chmod 600 "$_tmp"
    # shellcheck disable=SC2064
    trap "rm -f '$_tmp'" EXIT INT TERM

    info "requesting bootstrap token from $SECRETS_URL"
    if ! ts_curl -fsS --max-time 30 --retry 2 -o "$_tmp" "$SECRETS_URL"; then
        rm -f "$_tmp"; trap - EXIT INT TERM
        warn "could not reach $SECRETS_URL over the tailnet"
        warn "  start server/secrets-server.py on a tailnet host named '$SECRETS_HOST',"
        warn "  or set DEVTOOLS_SECRETS_URL, or pass PROTON_PASS_PERSONAL_ACCESS_TOKEN once"
        note "endpoint unreachable"
        return "$RC_SKIP"
    fi

    # The endpoint returns env-file lines so it can carry more later.
    _tok=$(sed -n 's/^PROTON_PASS_PERSONAL_ACCESS_TOKEN=//p' "$_tmp" | head -1 | tr -d '"'\''')
    if [ -z "$_tok" ]; then
        # Tolerate a bare token as the whole body.
        _tok=$(head -1 "$_tmp" | tr -d '\r\n')
    fi
    rm -f "$_tmp"; trap - EXIT INT TERM

    case "$_tok" in
        pst_*::*) : ;;
        *) err "endpoint did not return a Proton Pass token"; note "bad response"; return 1 ;;
    esac

    umask 077
    printf '%s\n' "$_tok" > "$_pat"
    chmod 600 "$_pat"
    PROTON_PASS_PERSONAL_ACCESS_TOKEN="$_tok"
    export PROTON_PASS_PERSONAL_ACCESS_TOKEN

    note "token fetched over the tailnet"
    return "$RC_UPDATED"
}
