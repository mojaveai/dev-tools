#!/bin/sh
# One-command entrypoint.
#
#   curl -fsSL https://raw.githubusercontent.com/mojaveai/dev-tools/main/bootstrap.sh | sh
#
# First run on a machine also needs the Proton Pass token, once:
#   ... | PROTON_PASS_PERSONAL_ACCESS_TOKEN=pst_... sh
# It is then stored 0600 and later runs need nothing.
#
# This file contains no secrets -- only the names of vault items to look up.

set -eu

REPO="${DEVTOOLS_REPO:-mojaveai/dev-tools}"
REF="${DEVTOOLS_REF:-main}"
# Installed to a stable path, not a temp dir: skills are symlinked from here and
# those links have to keep resolving long after this script exits.
DEST="${DEVTOOLS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/dev-tools}"

die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }

for c in curl tar; do
    command -v "$c" >/dev/null 2>&1 || die "required command missing: $c"
done

# Single-quote a value for safe embedding in a generated command string.
_q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

run_provisioner() {
    _dir=$1; shift
    chmod +x "$_dir/provision.sh" 2>/dev/null || true

    # stdin here is the pipe carrying this script, so hand the provisioner the
    # real terminal when there is one -- Tailscale approval and codex login both
    # need to prompt. Test that /dev/tty can actually be OPENED: the device node
    # exists in many containers where opening it fails with ENXIO. The probe runs
    # in a subshell because a redirection failure on a special builtin is fatal
    # in POSIX shells (dash is /bin/sh on Debian and Ubuntu).
    if ! ( true < /dev/tty ) 2>/dev/null; then
        REPO_DIR="$_dir" "$_dir/provision.sh" --non-interactive "$@" < /dev/null
        return $?
    fi

    # Provisioning over a mobile SSH session outlives the connection when it
    # runs inside tmux: a dropped link leaves the run going, and reconnecting
    # reattaches to it rather than restarting from scratch.
    if [ "${DEVTOOLS_NO_TMUX:-0}" != "1" ] && [ -z "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
        _cmd="REPO_DIR=$(_q "$_dir") $(_q "$_dir/provision.sh")"
        for _a in "$@"; do _cmd="$_cmd $(_q "$_a")"; done
        # Hold the pane open so the summary survives the command exiting.
        _cmd="$_cmd; printf '\n[provisioning finished - press enter to close]'; read -r _"
        printf 'bootstrap: running inside tmux session "dev-tools" (survives disconnects)\n'
        printf '           reattach with: tmux attach -t dev-tools\n\n'
        if tmux new-session -A -s dev-tools "$_cmd" < /dev/tty; then
            return 0
        fi
        # tmux could not start (unwritable socket dir, restricted container).
        # Provisioning still matters more than the session wrapper.
        printf '\nbootstrap: tmux unavailable, continuing without it\n\n' >&2
    fi

    REPO_DIR="$_dir" "$_dir/provision.sh" "$@" < /dev/tty
}

# Already running from a checkout (git clone, or a previous install): use it.
_self=${0:-}
case "$_self" in
    ''|sh|-sh|bash|-bash|/dev/fd/*|/proc/self/fd/*) ;;
    *)
        if [ -f "$_self" ]; then
            _here=$(CDPATH='' cd -- "$(dirname -- "$_self")" && pwd)
            if [ -f "$_here/provision.sh" ]; then
                exec_dir=$_here
                run_provisioner "$exec_dir" "$@"
                exit $?
            fi
        fi
        ;;
esac

TMP=$(mktemp -d "${TMPDIR:-/tmp}/dev-tools.XXXXXX") || die "cannot create temp dir"
trap 'rm -rf "$TMP"' EXIT INT TERM

printf 'bootstrap: fetching %s@%s\n' "$REPO" "$REF"
curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 \
    "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}" \
    -o "$TMP/src.tar.gz" || die "could not download ${REPO}@${REF}"

tar -xzf "$TMP/src.tar.gz" -C "$TMP" || die "could not unpack archive"

SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$SRC" ] && [ -f "$SRC/provision.sh" ] || die "archive did not contain provision.sh"

# Swap the new tree into place. Symlinks into $DEST/skills keep resolving
# because the final path never changes.
mkdir -p "$(dirname -- "$DEST")" || die "cannot create $(dirname -- "$DEST")"
rm -rf "$DEST.new"
mv "$SRC" "$DEST.new" || die "cannot stage into $DEST.new"
if [ -d "$DEST" ]; then
    rm -rf "$DEST.old"
    mv "$DEST" "$DEST.old" || die "cannot rotate $DEST"
fi
mv "$DEST.new" "$DEST" || {
    [ -d "$DEST.old" ] && mv "$DEST.old" "$DEST"
    die "cannot install into $DEST"
}
rm -rf "$DEST.old"

run_provisioner "$DEST" "$@"
