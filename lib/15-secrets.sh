#!/bin/sh
# Resolve config/secrets.map (names only, never values) into this process.

SECRETS_MAP="$REPO_DIR/config/secrets.map"

# Set for the rest of the run. Consumers check secret_have NAME before using one,
# so a missing optional secret degrades that step rather than the whole run.
secret_have() {
    eval "_v=\${$1:-}"
    [ -n "$_v" ] && [ "${_v#pass://}" = "$_v" ]
}

mod_secrets() {
    [ "${DEVTOOLS_PASS_READY:-0}" = "1" ] || {
        note "vault unavailable"; return "$RC_SKIP"; }
    [ -f "$SECRETS_MAP" ] || { note "no secrets.map"; return "$RC_SKIP"; }

    _names=$(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$SECRETS_MAP" | cut -d= -f1 | tr -d ' ')
    [ -n "$_names" ] || { note "secrets.map empty"; return "$RC_SKIP"; }

    _dir=$(mktemp -d "${TMPDIR:-/tmp}/devtools-secrets.XXXXXX") || return 1
    chmod 700 "$_dir"
    # shellcheck disable=SC2064
    trap "rm -rf '$_dir'" EXIT INT TERM

    sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$SECRETS_MAP" > "$_dir/refs.env"
    chmod 600 "$_dir/refs.env"

    # pass-cli resolves pass:// references from an --env-file (note: --env-file,
    # not --env). Emit only the names we asked for, shell-quoted, so nothing ever
    # lands on a command line or in ps output.
    _emit='import os,sys,shlex
for n in sys.argv[1:]:
    print("%s=%s" % (n, shlex.quote(os.environ.get(n, ""))))'

    if ! printf 'pass-cli run --env-file %s -- python3 -c %s %s > %s\n' \
            "$(quote "$_dir/refs.env")" "$(quote "$_emit")" "$_names" \
            "$(quote "$_dir/resolved.env")" | pass_session_run
    then
        err "pass-cli could not resolve secrets"
        note "resolution failed"
        return 1
    fi

    chmod 600 "$_dir/resolved.env" 2>/dev/null || true
    # shellcheck disable=SC1091
    . "$_dir/resolved.env"

    _ok=0; _bad=''
    for n in $_names; do
        eval "export $n"
        if secret_have "$n"; then
            _ok=$((_ok + 1))
        else
            # An unresolved pass:// reference is passed through verbatim rather
            # than erroring, so an empty or still-prefixed value means the item
            # is missing from the vault -- not that the vault is broken.
            _bad="$_bad $n"
            eval "unset $n"
        fi
    done

    rm -rf "$_dir"; trap - EXIT INT TERM

    [ -n "$_bad" ] && warn "unresolved (missing from vault?):$_bad"
    note "$_ok resolved${_bad:+, unresolved:$_bad}"
    [ "$_ok" -eq 0 ] && return 1
    return "$RC_OK"
}
