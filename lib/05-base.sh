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
    _want='curl git jq tar keyctl'
    _missing=''
    for c in $_want; do
        have "$c" || _missing="$_missing $c"
    done
    # python3 is required by the config-merge helpers.
    have python3 || _missing="$_missing python3"

    [ -z "$_missing" ] && { note "curl git jq tar keyctl python3 present"; return "$RC_OK"; }

    if ! can_privileged; then
        warn "missing:$_missing -- and no root/sudo to install them"
        note "missing:$_missing (no privileges)"
        return "$RC_SKIP"
    fi

    _pm=$(pkg_manager) || { note "no known package manager"; return "$RC_SKIP"; }
    pkg_refresh_once
    _pkgs=''
    for c in $_missing; do
        _pkgs="$_pkgs $(base_pkg_for "$c" "$_pm")"
    done
    info "installing:$_pkgs"
    # shellcheck disable=SC2086
    pkg_install $_pkgs || { err "package install failed"; return 1; }

    _still=''
    for c in $_missing; do have "$c" || _still="$_still $c"; done
    [ -n "$_still" ] && warn "still missing after install:$_still"
    note "installed:$_pkgs"
    return "$RC_UPDATED"
}
