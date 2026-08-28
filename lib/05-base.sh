#!/bin/sh
# Baseline packages every later module assumes.

pkg_manager() {
    for m in apt-get dnf yum apk pacman zypper; do
        have "$m" && { echo "$m"; return 0; }
    done
    return 1
}

pkg_install() {
    _pm=$(pkg_manager) || return 1
    case "$_pm" in
        apt-get) run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" ;;
        dnf|yum) run_privileged "$_pm" install -y "$@" ;;
        apk)     run_privileged apk add --no-cache "$@" ;;
        pacman)  run_privileged pacman -S --noconfirm --needed "$@" ;;
        zypper)  run_privileged zypper install -y "$@" ;;
    esac
}

pkg_refresh_once() {
    [ "${_DEVTOOLS_PKG_REFRESHED:-0}" = "1" ] && return 0
    _pm=$(pkg_manager) || return 1
    case "$_pm" in
        apt-get) run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update -qq || true ;;
        apk)     run_privileged apk update >/dev/null 2>&1 || true ;;
        pacman)  run_privileged pacman -Sy --noconfirm >/dev/null 2>&1 || true ;;
        *)       : ;;
    esac
    _DEVTOOLS_PKG_REFRESHED=1
    return 0
}

# Map a command name to its package name for the active manager.
base_pkg_for() {
    case "$1:$2" in
        keyctl:apt-get|keyctl:dnf|keyctl:yum) echo keyutils ;;
        keyctl:apk)      echo keyutils ;;
        keyctl:pacman)   echo keyutils ;;
        keyctl:zypper)   echo keyutils ;;
        cc:apt-get)      echo build-essential ;;
        cc:apk)          echo build-base ;;
        cc:pacman)       echo base-devel ;;
        cc:*)            echo gcc ;;
        *)               echo "$1" ;;
    esac
}

mod_base() {
    ensure_dirs
    # Required: nothing else works without these.
    _req='curl git jq tar python3'
    # Optional: keyctl keeps the pass-cli key in the kernel keyring instead of on
    # disk; tmux lets a run over a mobile link survive a dropped connection.
    _opt='keyctl tmux'

    _missing=''
    for c in $_req $_opt; do
        have "$c" || _missing="$_missing $c"
    done
    [ -z "$_missing" ] && { note "all present"; return "$RC_OK"; }

    _missing_req=''
    for c in $_req; do have "$c" || _missing_req="$_missing_req $c"; done

    if ! can_privileged; then
        if [ -n "$_missing_req" ]; then
            err "missing required:$_missing_req -- and no root/sudo to install them"
            note "missing:$_missing_req (no privileges)"
            return 1
        fi
        warn "optional tools unavailable and no root/sudo to install them:$_missing"
        note "optional missing:$_missing"
        return "$RC_SKIP"
    fi

    _pm=$(pkg_manager) || {
        [ -n "$_missing_req" ] && { note "no known package manager"; return 1; }
        note "no known package manager"; return "$RC_SKIP"; }
    pkg_refresh_once
    _pkgs=''
    for c in $_missing; do
        _pkgs="$_pkgs $(base_pkg_for "$c" "$_pm")"
    done
    info "installing:$_pkgs"
    # shellcheck disable=SC2086
    pkg_install $_pkgs || warn "package install reported an error"

    _still_req=''
    for c in $_req; do have "$c" || _still_req="$_still_req $c"; done
    if [ -n "$_still_req" ]; then
        err "still missing after install:$_still_req"
        note "missing:$_still_req"
        return 1
    fi
    _still=''
    for c in $_opt; do have "$c" || _still="$_still $c"; done
    note "installed:$_pkgs${_still:+ (optional still missing:$_still)}"
    return "$RC_UPDATED"
}
