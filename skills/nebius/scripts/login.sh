#!/bin/sh
# Refresh Nebius CLI federation credentials through this host's shared browser.
# The CLI's authorize URL redirects to a 127.0.0.1 listener on this host, so it
# must be opened by the shared browser here, not on the user's own machine.
set -eu
PATH="$HOME/.nebius/bin:$HOME/.local/bin:$PATH"
command -v nebius >/dev/null || { echo 'nebius CLI not installed (see skill instructions)' >&2; exit 1; }
# On a Mac the user's own browser is local, so the CLI's normal flow works.
if [ "$(uname -s)" = Darwin ]; then exec nebius iam whoami "$@"; fi
log=$(mktemp)
# whoami exits at once with a valid token and otherwise waits on its callback.
nebius iam whoami --no-browser "$@" </dev/null >"$log" 2>&1 & pid=$!
trap 'rm -f "$log"; kill "$pid" 2>/dev/null || true' EXIT
url=
for _ in $(seq 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid" && { echo 'Nebius CLI already authenticated.'; exit 0; }
        cat "$log" >&2; exit 1
    fi
    url=$(grep -oE 'https://auth\.nebius\.com/oauth2/authorize[^[:space:]]+' "$log" | head -1) && [ -n "$url" ] && break
    sleep 0.5
done
[ -n "$url" ] || { cat "$log" >&2; echo 'No Nebius authorize URL was printed' >&2; exit 1; }

dev-tools shared-browser open "$url" >/dev/null
echo 'Opened the Nebius sign-in in the shared browser; waiting for the CLI callback...'
# An existing auth.nebius.com session completes without input. Otherwise the
# user signs in through the viewer.
asked=
for i in $(seq 300); do
    if ! kill -0 "$pid" 2>/dev/null; then
        if wait "$pid"; then echo 'Nebius CLI authenticated.'; exit 0; fi
        sed -E 's/(code|state)=[^&[:space:]]+/\1=…/g' "$log" >&2; exit 1
    fi
    if [ "$i" -eq 20 ] && [ -z "$asked" ]; then
        asked=1
        dev-tools shared-browser request-input 'Please sign in to Nebius in the open tab so the CLI can finish authenticating.' >/dev/null || true
        echo "Sign-in needs the user: share $(dev-tools shared-browser url)"
    fi
    sleep 1
done
echo 'Timed out waiting for Nebius sign-in' >&2; exit 1
