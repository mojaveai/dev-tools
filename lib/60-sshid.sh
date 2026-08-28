#!/bin/sh
# Publish SSH ID public keys into authorized_keys as a managed block.

SSHID_HANDLE="${DEVTOOLS_SSHID_HANDLE:-manbir}"

mod_sshid() {
    _ak="$HOME/.ssh/authorized_keys"
    install -d -m 700 "$HOME/.ssh" || return 1
    [ -f "$_ak" ] || { : > "$_ak"; }
    chmod 600 "$_ak"

    _tmp=$(mktemp "${TMPDIR:-/tmp}/sshid.XXXXXX") || return 1
    # shellcheck disable=SC2064
    trap "rm -f '$_tmp'" EXIT INT TERM

    if ! download "https://sshid.io/$SSHID_HANDLE" "$_tmp"; then
        err "could not fetch https://sshid.io/$SSHID_HANDLE"
        note "fetch failed"
        return 1
    fi

    # Without this guard a CDN error page or a typo'd handle would be appended
    # into authorized_keys verbatim.
    if ! grep -qE '^(ssh-|ecdsa-|sk-)' "$_tmp"; then
        err "sshid.io returned no recognisable public keys; refusing to write"
        note "no keys in response"
        return 1
    fi

    _count=$(grep -cE '^(ssh-|ecdsa-|sk-)' "$_tmp")
    _d0=$(file_digest "$_ak")

    # A managed block, not an append: keys removed upstream disappear here too,
    # while any keys added by other means are left untouched.
    grep -E '^(ssh-|ecdsa-|sk-)' "$_tmp" | managed_block "$_ak" "sshid-$SSHID_HANDLE"
    chmod 600 "$_ak"
    rm -f "$_tmp"; trap - EXIT INT TERM

    _total=$(grep -cE '^(ssh-|ecdsa-|sk-)' "$_ak" 2>/dev/null || echo 0)
    note "$_count key(s) from @$SSHID_HANDLE ($_total total in authorized_keys)"
    [ "$(file_digest "$_ak")" = "$_d0" ] && return "$RC_OK"
    return "$RC_UPDATED"
}
