#!/bin/sh
# g2-terminal: install from a private GitHub release via its own bootstrap.

G2_REPO="${DEVTOOLS_G2_REPO:-mojaveai/g2-terminal}"

g2_latest_tag() {
    gh release list -R "$G2_REPO" --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null
}

mod_g2() {
    have gh || { note "gh unavailable"; return "$RC_SKIP"; }
    gh auth status >/dev/null 2>&1 || { note "gh not authenticated"; return "$RC_SKIP"; }

    # Only a linux-x64 asset is published today.
    [ "$(arch)" = "x86_64" ] || { note "no published asset for $(arch)"; return "$RC_SKIP"; }

    _tag=$(g2_latest_tag)
    [ -n "$_tag" ] || { note "no releases visible (check token access to $G2_REPO)"; return "$RC_SKIP"; }

    _cur=''
    have g2 && _cur=$(g2 version 2>/dev/null | tr -d ' \t' | head -1)

    if [ -n "$_cur" ] && [ "v${_cur#v}" = "$_tag" ]; then
        g2_write_env && note "$_tag, env updated" || note "$_tag"
        return "$RC_OK"
    fi

    # Do not disturb a maintainer source checkout that runs g2 from a dev shim.
    if [ -n "$_cur" ] && [ -L "$BIN_DIR/g2" ] || \
       { [ -f "$BIN_DIR/g2" ] && ! grep -q 'g2-terminal standalone launcher' "$BIN_DIR/g2" 2>/dev/null && [ -n "$_cur" ]; }; then
        warn "existing g2 launcher is not the standalone installer's; leaving it in place"
        note "source checkout detected, not replacing"
        g2_write_env
        return "$RC_SKIP"
    fi

    info "installing g2-terminal $_tag"
    if ! G2_RELEASE_REPOSITORY="$G2_REPO" G2_RELEASE_TAG="$_tag" \
        gh release download "$_tag" -R "$G2_REPO" --pattern g2-bootstrap.sh --output - \
        | G2_RELEASE_REPOSITORY="$G2_REPO" G2_RELEASE_TAG="$_tag" bash >/dev/null 2>&1
    then
        err "g2 bootstrap failed"
        note "install failed"
        return 1
    fi

    g2_write_env
    note "$_tag"
    return "$RC_UPDATED"
}

# Bridge configuration, 0600, from vaulted keys. Returns 0 if it wrote anything.
g2_write_env() {
    secret_have ELEVENLABS_API_KEY || return 1
    _dir="$HOME/.config/g2-terminal"
    mkdir -p "$_dir" && chmod 700 "$_dir" || return 1
    _f="$_dir/bridge.env"
    _d0=$(file_digest "$_f")
    {
        echo "ELEVENLABS_API_KEY=$ELEVENLABS_API_KEY"
        secret_have OPENROUTER_API_KEY && echo "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"
    } > "$_f"
    chmod 600 "$_f"
    [ "$(file_digest "$_f")" = "$_d0" ] && return 1
    return 0
}
