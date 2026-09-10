# Native browser control across hosts

Codex uses `cua_repl` on the agent host. At MCP connection startup, dev-tools
checks the Mac relay for a connected Chrome extension. If it responds, native
browser commands run on the Mac. Otherwise the installed local native CUA runtime
runs them on the agent host. The connection remains pinned to that destination;
reconnect MCP to select again. `js_reset` does not change machines.

This uses the installed ChatGPT native CUA runtime and Chrome extension, including
their normal interaction behavior and permission checks. SSH transports MCP
requests, results and approval callbacks. There is no continuous desktop video
stream. Screenshots still travel when an agent explicitly requests one.

## Agent-host installation and migration

Normal provisioning now includes `mod_native_browser`, independently of
`--with-browser` (the optional Linux/noVNC viewer):

```sh
./provision.sh --only mod_native_browser
# Optional custom remote socket, persisted across later reruns:
./provision.sh --only mod_native_browser --native-browser-socket /short/private/mac.sock
```

The step:

- Removes `dev-tools-browser` and `dev-tools-mac-browser` from Codex and Claude
  user MCP configuration. Removes the earlier `mac_native_browser` prototype
  alias when its launcher matches the prototype's relay.
- Registers the router as `cua_repl` in Codex and disables only the bundled
  `unified-computer-use` plugin's duplicate MCP server through a user override.
  It does not edit the bundled plugin cache or disable the plugin as a whole.
- Preserves unrelated servers, authentication, browser profiles and viewer
  sessions. Invalid/ambiguous configuration causes an error before replacement.
- Stops installing `@playwright/mcp` and `mcp-remote`. On viewer provisioning
  reruns, `npm ci` prunes these packages from the managed viewer runtime. The
  Playwright library remains for existing viewer lifecycle and Codex login helpers.

Python >=3.11 is required for provisioning. The native runtime and Chrome extension
must already be set up using the ChatGPT desktop app on each browser machine.
The Codex CLI alone does not provide that runtime. Provisioning configures routing;
it does not install a proprietary desktop runtime or automatically grant browser
permissions. A remote-only agent host can route to an available Mac without a
local native runtime, but local fallback requires that runtime on the agent host.

This is a Codex integration: native CUA requires genuine Codex turn metadata and
MCP elicitation handling. We remove the legacy Claude MCP entries but do not
register an incompatible native server in Claude.

## One-time setup on the Mac

Use a **stable checkout** of this repository, or its normal installed location.
Keep it in place; the LaunchAgent refers to it. Chrome and ChatGPT must be running
in your logged-in Mac session. Set up Chrome in ChatGPT Settings → Computer Use.

On the Mac, run:

```sh
/path/to/dev-tools/bin/dev-tools native-browser install-mac --ssh-host procbox
```

Replace `procbox` with the SSH alias of the agent host. SSH must already work
non-interactively from the Mac. The command discovers the remote user's home,
UID/GID and `CODEX_HOME` rather than assuming usernames or machine paths. Run
agent-host provisioning separately as above.

With Tailscale SSH implementations that create reverse UNIX sockets as root,
use the explicit repair option:

```sh
/path/to/dev-tools/bin/dev-tools native-browser install-mac \
  --ssh-host procbox --repair-root-socket
```

This uses `sudo -n chown` on **only the forwarded socket**, assigning it to the
remote agent user. It does not broaden the socket mode or install sudo rules.
That host must already permit this operation. If sudo is unavailable, use an SSH
server that creates forwarded sockets under the logged-in user.

The command installs a per-host user LaunchAgent, a private local socket and an
SSH reverse UNIX-socket forward. No TCP listener is exposed. Repeated setup is
idempotent; it only reloads the service when its configuration changes. The
supervisor reconnects after SSH loss. It refuses a remote socket already serving
another relay. Stop the prototype `com.manbir.native-chrome-relay` LaunchAgent,
if present, before starting this replacement; do not run two forwarders for the
same remote socket.

The default remote socket is `$CODEX_HOME/run/mac-native-browser.sock` (or
`~/.codex/run/mac-native-browser.sock`). On both machines this must be a private
user directory. A custom `CODEX_HOME` must be available in the SSH environment.
The explicit installer socket override must agree with the relay's remote path.

## Use and verification

Reload MCP connections or start a fresh procbox task after installation. Ask:

> Use cua_repl. Confirm which machine this connection controls, list its
> browsers, then open example.com and click Learn more using native controls.

The MCP initialization instructions identify the selected destination. The router
keeps native tool descriptions, genuine session/turn metadata and approval
messages intact. It never automatically approves a request. If the Mac disappears
mid-action, the connection ends; requests are not replayed locally.

On the agent host:

```sh
dev-tools native-browser check
# Exercise local selection without stopping your real relay:
dev-tools native-browser check --socket /tmp/nonexistent-native-relay.sock
```

`check` reports selection, not an authorized website interaction. Browser discovery
and approval cancellation have been verified against the native runtime; the
full navigation/cursor workflow also depends on your agent client's approval UI.

Local fallback uses the host's existing native browser setup. It does **not**
automatically attach that runtime to a dev-tools noVNC session. The noVNC viewer
remains a separate manual fallback; identify the actual browser/tab before
assuming an agent and viewer share a page.

## Lifecycle and removal

The service label and plist path are printed by `install-mac`; logs and per-host
settings live in `~/.local/share/dev-tools-native-browser/`. It starts at login,
requires the Mac to stay awake, and ends active relay connections when stopped.
Use `launchctl bootout gui/$(id -u) PATH_TO_PLIST` to stop it, and remove that
specific plist to uninstall automatic startup. Remove its per-host settings and
socket only after stopping it.

To restore unwrapped local CUA, remove `[mcp_servers.cua_repl]` and the
`[plugins."unified-computer-use@openai-bundled".mcp_servers.cua_repl]` override from
Codex configuration, then reconnect MCP. Existing browser profiles are untouched.

Native internals can change across desktop releases. Each connection loads the
most recently updated installed native runtime configuration. Generic MCP
registration may not get bundled automatic turn-end hooks; callers should use
`turn_ended` with their actual task/turn identifiers when supported. Unexpectedly
disconnected sessions may need tab cleanup. Avoid sharing one tab between agents.
