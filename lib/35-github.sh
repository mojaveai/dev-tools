#!/bin/sh
# GitHub CLI: portable tarball install, token auth, git credential helper.

GH_MIN='2.60.0'

gh_latest_tag() {
    curl -fsSL --retry 2 --connect-timeout 10 \
        https://api.github.com/repos/cli/cli/releases/latest 2>/dev/null \
        | jq -r '.tag_name // empty' 2>/dev/null
}

gh_install() {
    # The distro package lags badly (Ubuntu ships 2.46 here); the release tarball
    # is current, needs no root, and works on any glibc Linux.
    _tag=$(gh_latest_tag)
    [ -n "$_tag" ] || { err "could not determine latest gh release"; return 1; }
    _ver=${_tag#v}
    case "$(arch)" in
        x86_64)  _a=amd64 ;;
        aarch64) _a=arm64 ;;
        *)       err "unsupported arch for gh: $(arch)"; return 2 ;;
    esac
    _d=$(mktemp -d "${TMPDIR:-/tmp}/gh.XXXXXX") || return 1
    # shellcheck disable=SC2064
    trap "rm -rf '$_d'" EXIT INT TERM
    info "installing gh $_ver"
    download "https://github.com/cli/cli/releases/download/${_tag}/gh_${_ver}_linux_${_a}.tar.gz" \
        "$_d/gh.tgz" || { rm -rf "$_d"; return 1; }
    tar -xzf "$_d/gh.tgz" -C "$_d" || { rm -rf "$_d"; return 1; }
    install -Dm755 "$_d/gh_${_ver}_linux_${_a}/bin/gh" "$BIN_DIR/gh" || { rm -rf "$_d"; return 1; }
    rm -rf "$_d"; trap - EXIT INT TERM
    return 0
}

mod_github() {
    _rc="$RC_OK"
    _cur=''
    have gh && _cur=$(gh --version 2>/dev/null | head -1 | awk '{print $3}')

    _need_install=0
    if [ -z "$_cur" ]; then
        _need_install=1
    else
        # Upgrade only a version older than our floor; leave newer ones alone.
        _low=$(printf '%s\n%s\n' "$_cur" "$GH_MIN" | sort -V | head -1)
        [ "$_low" = "$_cur" ] && [ "$_cur" != "$GH_MIN" ] && _need_install=1
    fi

    if [ "$_need_install" = 1 ]; then
        gh_install
        case $? in
            0) _rc="$RC_UPDATED" ;;
            2) [ -z "$_cur" ] && { note "unsupported arch"; return "$RC_SKIP"; } ;;
            *) [ -z "$_cur" ] && { err "gh install failed"; return 1; }
               warn "gh upgrade failed, keeping $_cur" ;;
        esac
    fi

    have gh || { err "gh not on PATH"; return 1; }

    if gh auth status >/dev/null 2>&1; then
        note "authenticated, $(gh --version 2>/dev/null | head -1 | awk '{print $3}')"
        # setup-git is a no-op under a bare GH_TOKEN, so only wire it when a
        # stored login exists.
        gh auth setup-git >/dev/null 2>&1 || true
        return "$_rc"
    fi

    secret_have GH_TOKEN || { note "not authenticated and GH_TOKEN unavailable"; return "$RC_SKIP"; }

    info "authenticating gh"
    # --with-token persists the login so future interactive shells and
    # `git push` over HTTPS work without the env var being present.
    printf '%s' "$GH_TOKEN" | gh auth login --with-token || {
        err "gh auth login failed"; return 1; }
    gh auth setup-git >/dev/null 2>&1 || warn "gh auth setup-git failed"

    gh auth status >/dev/null 2>&1 || { err "gh still unauthenticated"; return 1; }
    _scopes=$(gh auth status 2>&1 | sed -n 's/.*Token scopes: //p' | head -1)
    case "$_scopes" in
        *read:org*) : ;;
        *) warn "token is missing the 'read:org' scope; some gh org operations will fail" ;;
    esac
    note "authenticated"
    return "$RC_UPDATED"
}
