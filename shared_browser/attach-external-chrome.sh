#!/bin/sh
set -eu
# Read Chrome's current debugger endpoint at service start. Chrome rotates the
# browser route when it restarts, so the full URL must not be stored in a unit.
: "${SHARED_BROWSER_CDP_PORT_FILE:?Set SHARED_BROWSER_CDP_PORT_FILE}"
case "$SHARED_BROWSER_CDP_PORT_FILE" in /*) :;; *) echo 'Chrome port file must be absolute' >&2; exit 1;; esac
if [ -r "$SHARED_BROWSER_CDP_PORT_FILE" ]; then
    details=$(cat "$SHARED_BROWSER_CDP_PORT_FILE")
else
    # A different desktop account may own Chrome. Configure sudoers for this
    # exact read-only cat command; the installer never broadens permissions.
    details=$(sudo -n cat "$SHARED_BROWSER_CDP_PORT_FILE")
fi
port=$(printf '%s\n' "$details" | sed -n '1p')
route=$(printf '%s\n' "$details" | sed -n '2p')
case "$port" in ''|*[!0-9]*) echo 'Invalid Chrome debugging port' >&2; exit 1;; esac
case "$route" in /devtools/browser/*) :;; *) echo 'Invalid Chrome debugging route' >&2; exit 1;; esac
case "$route" in *[!a-zA-Z0-9/_-]*|/devtools/browser/) echo 'Invalid Chrome debugging route' >&2; exit 1;; esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then echo 'Invalid Chrome debugging port' >&2; exit 1; fi
export SHARED_BROWSER_CDP_WS_ENDPOINT="ws://127.0.0.1:$port$route"
exec "${SHARED_BROWSER_NODE:-node}" "$(dirname "$0")/server.mjs"
