#!/bin/sh
# General dev tooling: uv, ripgrep.

mod_uv() {
    if have uv; then
        _b=$(uv --version 2>/dev/null | awk '{print $2}')
        UV_NO_MODIFY_PATH=1 uv self update >/dev/null 2>&1 || true
        _a=$(uv --version 2>/dev/null | awk '{print $2}')
        note "uv $_a"
        [ "$_b" = "$_a" ] && return "$RC_OK"
        return "$RC_UPDATED"
    fi
    info "installing uv"
    _tmp=$(mktemp "${TMPDIR:-/tmp}/uv.XXXXXX") || return 1
    download 'https://astral.sh/uv/install.sh' "$_tmp" || { rm -f "$_tmp"; return 1; }
    # We own PATH via the managed .bashrc block; without this the installer
    # re-appends to the shell profile on every self-update.
    UV_NO_MODIFY_PATH=1 sh "$_tmp" >/dev/null 2>&1 || { rm -f "$_tmp"; err "uv install failed"; return 1; }
    rm -f "$_tmp"
    have uv || { err "uv not on PATH after install"; return 1; }
    note "uv $(uv --version 2>/dev/null | awk '{print $2}')"
    return "$RC_UPDATED"
}

RG_VER="${DEVTOOLS_RG_VERSION:-14.1.1}"

mod_ripgrep() {
    # A shell function named rg (Claude Code installs one) is not a real binary.
    if [ -x "$BIN_DIR/rg" ] || command -v rg 2>/dev/null | grep -q '^/'; then
        _v=$(rg --version 2>/dev/null | head -1 | awk '{print $2}')
        [ -n "$_v" ] && { note "ripgrep $_v"; return "$RC_OK"; }
    fi

    case "$(arch)" in
        # musl specifically: the gnu build fails on older-glibc hosts, which is
        # exactly the arbitrary-Linux case this script targets.
        x86_64)  _t="x86_64-unknown-linux-musl" ;;
        aarch64) _t="aarch64-unknown-linux-gnu" ;;
        *)       note "no ripgrep build for $(arch)"; return "$RC_SKIP" ;;
    esac

    info "installing ripgrep $RG_VER"
    _d=$(mktemp -d "${TMPDIR:-/tmp}/rg.XXXXXX") || return 1
    # shellcheck disable=SC2064
    trap "rm -rf '$_d'" EXIT INT TERM
    download "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VER}/ripgrep-${RG_VER}-${_t}.tar.gz" \
        "$_d/rg.tgz" || { rm -rf "$_d"; err "ripgrep download failed"; return 1; }
    tar -xzf "$_d/rg.tgz" -C "$_d" || { rm -rf "$_d"; return 1; }
    install -Dm755 "$_d/ripgrep-${RG_VER}-${_t}/rg" "$BIN_DIR/rg" || { rm -rf "$_d"; return 1; }
    rm -rf "$_d"; trap - EXIT INT TERM
    note "ripgrep $RG_VER"
    return "$RC_UPDATED"
}
