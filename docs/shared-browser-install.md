# Shared browser installation and agent use

The default on procbox and demobox is `shared_browser_repl`, replacing the
Mac Chrome SSH relay and noVNC agent workflow. Both Codex and Claude Code receive
stdio MCP registration and the shared-browser skill. Reconnect MCP or start a
new agent session after installation; existing sessions retain old tool lists.

Tell an agent:

> Use shared_browser_repl to browse. Start with await cua.getState(), give me the
> viewerUrl, then use the shared remote Chrome session. I can watch and interact
> from that link. Use the shared-browser skill, not the Mac relay or noVNC.

Viewers (Tailscale required, owner identity checked by the application):

- procbox: https://procbox.agent-trace.ts.net:8443/
- demobox: https://demobox.asg.ts.net:8443/

Each host has its own profile/session. Only procbox currently has the Agent Trace
QA same-origin passkey adapter. Generic sites do not automatically gain passkey
forwarding. See [the portal adapter](shared-browser-dev-portal.md).

## Install or update

Prerequisites: Linux user systemd, Python 3.11+, Node 22+, npm, sandbox-capable
Chromium, Tailscale. The legacy `--with-browser` provisioner can install Chromium
and its dependencies; the shared runtime does not use its VNC server.

From a persistent dev-tools checkout:

```sh
# Optional overrides: SHARED_BROWSER_NODE, SHARED_BROWSER_CHROME,
# SHARED_BROWSER_ORIGIN, SHARED_BROWSER_OWNER (default manbir@asgroup.ai).
bin/dev-tools shared-browser install
# Inspect existing Serve routes before allocating the dedicated 8443 listener.
tailscale serve status
tailscale serve --bg --https=8443 http://127.0.0.1:8791
bin/dev-tools shared-browser status
```

The installer infers the HTTPS hostname from this machine's Tailscale DNS name,
installs dependencies/builds assets, enables the persistent service, configures
both agent CLIs, and disables the old native-registration repair service. It
preserves unrelated agent settings. It starts a stopped runtime but does not
restart an active browser during updates; restart deliberately when server code
changes (`systemctl --user restart dev-tools-shared-browser`). Viewer assets
require a page refresh. Restarting closes tabs; persisted site cookies may survive.

Do not replace an occupied 8443 listener. Do not reset Serve configuration or
broaden ACLs. Tailscale policy must allow the intended user to reach that port.
Existing noVNC routes and profiles are retained for explicit fallback; no active
legacy sessions are killed by installation.

On the two installed hosts runtime code is in
`~/.local/share/dev-tools-shared-browser`, separate from the dev-tools checkout.
Sync updated shared_browser sources there before running its install.sh. Use
`SHARED_BROWSER_REPO=~/.local/share/dev-tools` if the checkout location is ambiguous.
Demobox uses checksum-verified official Node 24.1.0 under
`~/.local/share/dev-tools-node/node-v24.1.0-linux-arm64/`; its system Node is unchanged.

## Diagnostics

```sh
dev-tools shared-browser status
dev-tools shared-browser url
dev-tools shared-browser start
systemctl --user status dev-tools-shared-browser
journalctl --user -u dev-tools-shared-browser -n 40
```

If dev-tools is not on the shell PATH, use `~/.local/bin/dev-tools`.
`dev-tools shared-browser mcp` starts the stdio server; normally the agent client
launches it automatically from its registered MCP configuration. No Mac or local
viewer must stay connected. The headless browser host must remain running.

## Deployment verification (2026-09-14)

Both hosts passed all 15 live MCP checks: discovery, persistent bindings, form
entry/click, shared human input, DOM snapshots, viewport/scroll handling, action
feedback, stale-input rejection, and browser survival across viewer disconnect,
reconnect, MCP reconnect and reset. Both native repair units are inactive and
disabled. Demobox's published viewer returned HTTP 200 from the owner's Mac.
The configuration migration test verifies unrelated settings survive and reruns
are idempotent. All 14 shared-browser unit checks passed.
