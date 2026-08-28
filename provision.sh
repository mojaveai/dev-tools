#!/bin/sh
# dev-tools provisioner.
#
# Converges this machine onto the desired development environment. Safe to run
# repeatedly: every step checks before it acts, and steps that are already
# satisfied report OK without redoing work.
#
# Deliberately does NOT use `set -e`. One failing step must not prevent the
# others from running -- partial success is the normal outcome on a new box.

set -u

REPO_DIR=${REPO_DIR:-$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)}
export REPO_DIR

# shellcheck source=lib/common.sh
. "$REPO_DIR/lib/common.sh"

for _m in "$REPO_DIR"/lib/[0-9]*.sh; do
    [ -f "$_m" ] || continue
    # shellcheck source=/dev/null
    . "$_m"
done

# Anything we install lands here; make it visible to the rest of this run.
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) PATH="$BIN_DIR:$PATH"; export PATH ;;
esac

# --- step runner -------------------------------------------------------------
RESULTS=$(mktemp "${TMPDIR:-/tmp}/devtools-results.XXXXXX") || exit 1
trap 'rm -f "$RESULTS"' EXIT INT TERM
FAILED=0

step() {
    _label=$1; _fn=$2
    if [ -n "${ONLY:-}" ]; then
        case " $ONLY " in
            *" $_fn "*) : ;;
            *) printf 'SKIP %s\n' "$_label|not selected" >> "$RESULTS"; return 0 ;;
        esac
    fi
    if [ -n "${SKIP:-}" ]; then
        case " $SKIP " in
            *" $_fn "*) printf 'SKIP %s\n' "$_label|deselected" >> "$RESULTS"; return 0 ;;
        esac
    fi

    STEP_NOTE=''
    printf '%s%s%s %s\n' "$C_BLD" "==>" "$C_RESET" "$_label"
    "$_fn"
    _rc=$?
    case "$_rc" in
        0)  _st=OK ;;
        10) _st=UPDATED ;;
        20) _st=SKIP ;;
        *)  _st=FAIL; FAILED=$((FAILED + 1)) ;;
    esac
    printf '%s %s\n' "$_st" "$_label|$STEP_NOTE" >> "$RESULTS"

    case "$_st" in
        OK)      printf '    %sok%s       %s\n'      "$C_GRN" "$C_RESET" "${STEP_NOTE:-already configured}" ;;
        UPDATED) printf '    %supdated%s  %s\n'      "$C_GRN" "$C_RESET" "${STEP_NOTE:-changed}" ;;
        SKIP)    printf '    %sskipped%s  %s\n'      "$C_YEL" "$C_RESET" "${STEP_NOTE:-not applicable}" ;;
        FAIL)    printf '    %sfailed%s   %s\n'      "$C_RED" "$C_RESET" "${STEP_NOTE:-see output above}" ;;
    esac
    return 0
}

summary() {
    printf '\n%s─────────────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
    printf '%sSummary%s\n\n' "$C_BLD" "$C_RESET"
    while IFS=' ' read -r _st _rest; do
        _label=${_rest%%|*}
        _n=${_rest#*|}
        case "$_st" in
            OK)      _c="$C_GRN" ;;
            UPDATED) _c="$C_GRN" ;;
            SKIP)    _c="$C_YEL" ;;
            *)       _c="$C_RED" ;;
        esac
        printf '  %s%-8s%s %-22s %s%s%s\n' "$_c" "$_st" "$C_RESET" "$_label" "$C_DIM" "$_n" "$C_RESET"
    done < "$RESULTS"
    printf '\n'

    if [ "$FAILED" -gt 0 ]; then
        printf '  %s%s step(s) failed.%s Re-running is safe and will retry only what is unfinished.\n\n' \
            "$C_RED" "$FAILED" "$C_RESET"
    else
        printf '  %sEverything converged.%s Open a new shell (or: . %s) to pick up PATH changes.\n\n' \
            "$C_GRN" "$C_RESET" "$HOME/.bashrc"
    fi
}

usage() {
    cat <<EOF
Usage: provision.sh [options]

  --only  "fn ..."   run only these step functions
  --skip  "fn ..."   skip these step functions
  --list             list step functions and exit
  --non-interactive  never prompt (codex login will be reported, not run)
  --debug            verbose
  -h, --help         this help

Steps: mod_base mod_passcli mod_secrets mod_shell mod_tailscale mod_github
       mod_claude mod_codex mod_skills mod_sshid mod_uv mod_ripgrep mod_g2
EOF
}

ONLY=''; SKIP=''
while [ $# -gt 0 ]; do
    case "$1" in
        --only)  ONLY=$2; shift 2 ;;
        --skip)  SKIP=$2; shift 2 ;;
        --list)  usage; exit 0 ;;
        --non-interactive) DEVTOOLS_NONINTERACTIVE=1; export DEVTOOLS_NONINTERACTIVE; shift ;;
        --debug) DEVTOOLS_DEBUG=1; export DEVTOOLS_DEBUG; shift ;;
        -h|--help) usage; exit 0 ;;
        *) err "unknown option: $1"; usage; exit 2 ;;
    esac
done

printf '%sdev-tools%s  provisioning %s (%s, %s)\n\n' \
    "$C_BLD" "$C_RESET" "$(hostname 2>/dev/null || echo this machine)" \
    "$(arch)" "$(is_root && echo root || (can_privileged && echo 'sudo available' || echo 'unprivileged'))"

step "base packages"   mod_base
step "pass-cli"        mod_passcli
step "secrets"         mod_secrets
step "shell env"       mod_shell
step "tailscale"       mod_tailscale
step "github cli"      mod_github
step "claude code"     mod_claude
step "codex"           mod_codex
step "agent skills"    mod_skills
step "ssh keys"        mod_sshid
step "uv"              mod_uv
step "ripgrep"         mod_ripgrep
step "g2-terminal"     mod_g2

summary
[ "$FAILED" -gt 0 ] && exit 1
exit 0
