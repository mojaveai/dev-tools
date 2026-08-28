#!/bin/sh
# Tailscale: install, join the tailnet, enable Tailscale SSH.
#
# This is the root of trust. On a fresh machine there is no secret yet, so the
# join is interactive: tailscale prints a login URL, you approve it from a
# browser you are already signed into, and the tailnet then vouches for this
# machine when it asks for everything else.

TS_TAGS="${DEVTOOLS_TS_TAGS:-tag:dev}"
TS_HOSTNAME="${DEVTOOLS_TS_HOSTNAME:-$(hostname 2>/dev/null | cut -d. -f1)}"
# Long enough to unlock a phone, open the link and approve.
TS_AUTH_TIMEOUT="${DEVTOOLS_TS_AUTH_TIMEOUT:-300s}"

ts_state() {
    tailscale status --json 2>/dev/null | jq -r '.BackendState // "NoState"' 2>/dev/null || echo Unknown
}

ts_ssh_enabled() {
    tailscale debug prefs 2>/dev/null | jq -e '.RunSSH == true' >/dev/null 2>&1
}

ts_install() {
    have tailscale && return 0
    can_privileged || return 2
    info "installing tailscale"
    _tmp=$(mktemp "${TMPDIR:-/tmp}/ts.XXXXXX") || return 1
    download 'https://tailscale.com/install.sh' "$_tmp" || { rm -f "$_tmp"; return 1; }
    run_privileged sh "$_tmp" >/dev/null 2>&1 || { rm -f "$_tmp"; return 1; }
    rm -f "$_tmp"
    have tailscale
}

# No systemd (containers, Coder pods) means no unit to start tailscaled for us.
# Userspace networking needs no TUN device; inbound Tailscale SSH still works,
# outbound traffic has to go via the SOCKS5/HTTP proxies.
ts_ensure_daemon() {
    pgrep -x tailscaled >/dev/null 2>&1 && return 0
    if has_systemd && can_privileged; then
        run_privileged systemctl enable --now tailscaled >/dev/null 2>&1 && return 0
    fi
    can_privileged || return 1
    info "starting tailscaled in userspace-networking mode (no systemd)"
    _sd="${DEVTOOLS_TS_STATEDIR:-/var/lib/tailscale}"
    run_privileged mkdir -p "$_sd" 2>/dev/null || _sd="$HOME/.local/state/tailscale"
    mkdir -p "$_sd" 2>/dev/null || true
    run_privileged sh -c "nohup tailscaled \
        --state=$(quote "$_sd/tailscaled.state") \
        --statedir=$(quote "$_sd") \
        --tun=userspace-networking \
        --socks5-server=localhost:1055 \
        --outbound-http-proxy-listen=localhost:1056 \
        >/var/log/tailscaled.log 2>&1 &" || return 1
    _n=0
    while [ "$_n" -lt 20 ]; do
        pgrep -x tailscaled >/dev/null 2>&1 && return 0
        _n=$((_n + 1)); sleep 1
    done
    return 1
}

# Non-interactive join, when an OAuth client secret is already available.
ts_up_with_secret() {
    _kf=$(mktemp "${TMPDIR:-/tmp}/tskey.XXXXXX") || return 1
    chmod 600 "$_kf"
    printf '%s?ephemeral=false&preauthorized=true\n' "$TS_OAUTH_SECRET" > "$_kf"
    # --auth-key=file: keeps the secret out of ps output.
    run_privileged tailscale up \
        --auth-key="file:$_kf" \
        --advertise-tags="$TS_TAGS" \
        --hostname="$TS_HOSTNAME" \
        --ssh --accept-routes --timeout=90s
    _rc=$?
    rm -f "$_kf"
    return $_rc
}

# Interactive join: prints a URL to approve. This is the normal path on a new
# machine, and the one that works from a phone -- the URL is tappable in a
# mobile SSH client, unlike a QR code you would have to scan with the same
# device you are reading it on.
ts_up_interactive() {
    printf '\n'
    printf '%s  Tailscale needs you to approve this machine.%s\n' "$C_BLD" "$C_RESET"
    printf '  Open the link below and approve; provisioning continues automatically.\n'
    printf '  Waiting up to %s.\n\n' "$TS_AUTH_TIMEOUT"

    # Tags require a tagOwners entry granting your user the right to apply them.
    # If that is missing the join fails, so fall back to a user-owned node.
    if run_privileged tailscale up \
        --advertise-tags="$TS_TAGS" \
        --hostname="$TS_HOSTNAME" \
        --ssh --accept-routes --timeout="$TS_AUTH_TIMEOUT"
    then
        return 0
    fi

    warn "join with $TS_TAGS failed; retrying without tags (check tagOwners in your ACL)"
    run_privileged tailscale up \
        --hostname="$TS_HOSTNAME" \
        --ssh --accept-routes --timeout="$TS_AUTH_TIMEOUT"
}

mod_tailscale() {
    _rc="$RC_OK"
    ts_install
    case $? in
        0) : ;;
        2) note "tailscale absent and no root/sudo"; return "$RC_SKIP" ;;
        *) err "tailscale install failed"; return 1 ;;
    esac

    ts_ensure_daemon || { note "tailscaled not running"; return 1; }

    _state=$(ts_state)
    if [ "$_state" = "NeedsMachineAuth" ]; then
        # Re-running `up` will not clear this; someone has to approve the node.
        warn "node registered but awaiting admin approval in the Tailscale console"
        note "NeedsMachineAuth -- approve the device, then re-run"
        return "$RC_SKIP"
    fi

    if [ "$_state" != "Running" ]; then
        if secret_have TS_OAUTH_SECRET; then
            ts_up_with_secret || { err "tailscale up failed"; return 1; }
        elif [ "${DEVTOOLS_NONINTERACTIVE:-0}" != "1" ]; then
            ts_up_interactive || { err "tailscale login was not completed"; return 1; }
        else
            note "not joined; needs either TS_OAUTH_SECRET or an interactive run"
            return "$RC_SKIP"
        fi
        _rc="$RC_UPDATED"
    elif ! ts_ssh_enabled; then
        # Converge SSH on an already-joined node without bouncing the connection.
        info "enabling Tailscale SSH"
        run_privileged tailscale set --ssh || { err "tailscale set --ssh failed"; return 1; }
        _rc="$RC_UPDATED"
    fi

    _state=$(ts_state)
    [ "$_state" = "Running" ] || { note "backend state: $_state"; return 1; }
    ts_ssh_enabled || warn "Tailscale SSH still reports disabled"

    _ip=$(tailscale ip -4 2>/dev/null | head -1)
    note "Running${_ip:+ @ $_ip}, SSH on"
    return "$_rc"
}
