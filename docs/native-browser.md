# Native browser control across hosts

Codex uses `cua_repl` on the agent host. On the first JavaScript call, dev-tools
checks the Mac relay for a connected Chrome extension, then checks for an actual
local browser. An installed runtime alone does not count as a working browser.
If neither is available, the MCP stays connected and returns a diagnostic;
the next call retries discovery without restarting Codex. After dispatch the
destination stays pinned until a successful `js_reset`, which permits discovery
again. Each JavaScript result identifies the machine that handled the call.

This uses the installed ChatGPT native CUA runtime and Chrome extension, including
their normal interaction behavior and permission checks. SSH transports MCP
requests, results and approval callbacks. There is no continuous desktop video
stream. Screenshots still travel when an agent explicitly requests one.

The Chrome extension requires the ChatGPT desktop app on the browser machine to
remain running, as well as Chrome. Closing the desktop app removes its browser
bridge even if the SSH tunnel is healthy. Running `codex app-server` headlessly
does not replace that bridge. The relay recovers discovery when the desktop app
and extension reconnect; it does not manufacture approvals or replace the native
host. This is a desktop dependency, not an SSH transport failure.

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
- On Linux hosts with user systemd, installs a user service and path watcher
  that restore a missing router registration at login and after external Codex
  configuration rewrites. Existing custom or explicitly disabled `cua_repl`
  entries are preserved. The saved custom socket is reused. No approval policies
  are changed and no active agent is terminated. Without user systemd, repairs
  occur on provisioning reruns.
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
idempotent; it reloads the service when its configuration or installed source changes.
The supervisor uses dedicated SSH connections (no shared ControlMaster), with
15-second heartbeat deadlines on both ends. After a drop it retries automatically
using a fresh socket, then atomically publishes that socket at the stable agent
path. An orphaned listener cannot block recovery. A per-installation owner marker
prevents a different installation from replacing the endpoint. Stop the prototype `com.manbir.native-chrome-relay` LaunchAgent,
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

The MCP initialization instructions explain selection; each JavaScript result
identifies its actual destination. The router
keeps native tool descriptions, genuine session/turn metadata and approval
messages intact. It never automatically approves a request. If the Mac disappears
mid-action, the MCP remains available but rejects further JavaScript until
`js_reset`. Inspect the new browser state before continuing: the last action may
already have completed, and requests are never replayed locally.

On the agent host:

```sh
dev-tools native-browser check
dev-tools native-browser check --json
# Exercise local selection without stopping your real relay:
dev-tools native-browser check --socket /tmp/nonexistent-native-relay.sock
```

`check` reports selection, not an authorized website interaction. Browser discovery
and approval cancellation have been verified against the native runtime; the
full navigation/cursor workflow also depends on your agent client's approval UI.
It returns `unavailable` when neither route has a connected browser. JSON output
separates missing/unreachable relay sockets, failed native discovery and a runtime
with no browser. A successful SSH heartbeat alone is not browser readiness.

If the current task lacks `cua_repl`, reconnect MCP or start a fresh task after
registration repair. Do not launch a custom MCP client inside a shell or
`node_repl`: it does not inherit Codex's approval callbacks. The error
`JavaScript execution requires an approval elicitation` can result from such
a client initializing without elicitation support; it is not resolved by a
blanket conversational approval. Inspect automatic repair with
`systemctl --user status dev-tools-native-browser-repair.path` and
`journalctl --user -u dev-tools-native-browser-repair.service`.

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
socket only after stopping it. The remote `.owner` file identifies this installation;
retain it across upgrades, and remove it only when intentionally uninstalling or
transferring ownership. Keep the matching Mac settings file across upgrades.

SSH recovery normally takes about 20–30 seconds after a stalled connection when
SSH is reachable (a forced-stall test recovered in 25.7 seconds). Longer outages
keep retrying. A task that has not dispatched JavaScript can retry discovery as
soon as a browser returns. After a native connection drops, use `js_reset` and
inspect the browser; the interrupted action is never replayed. Tailscale SSH
reauthentication still requires the user to complete the provided login link.

To restore unwrapped local CUA, remove `[mcp_servers.cua_repl]` and the
`[plugins."unified-computer-use@openai-bundled".mcp_servers.cua_repl]` override from
Codex configuration, then reconnect MCP. Existing browser profiles are untouched.
First disable automatic registration repair with
`systemctl --user disable --now dev-tools-native-browser-repair.path dev-tools-native-browser-repair.service`.

Native internals can change across desktop releases. Each connection loads the
most recently updated installed native runtime configuration. Generic MCP
registration may not get bundled automatic turn-end hooks; callers should use
`turn_ended` with their actual task/turn identifiers when supported. Unexpectedly
disconnected sessions may need tab cleanup. Avoid sharing one tab between agents.

### Recovery during network path changes

The Mac tunnel allows up to 60 seconds for a heartbeat response; the remote
lease allows 75 seconds so it does not expire before the Mac's deadline. SSH
keepalives use the same 60-second tolerance. A closed connection reconnects
after two seconds. Tunnel replacement keeps the relay listener process alive,
but an actual broken SSH stream still loses its attached JavaScript session.
No browser actions are replayed. Reset and recreate bindings after stream loss.

Discovery retries transient failures up to three probes, with one-second gaps.
`check --json` reports `state: unconfirmed` when discovery times out or the
transport/runtime cannot be verified. This does not establish that Chrome is
closed. `unavailable` means both runtimes reported no connected browser.
Timestamped JSON events in the Mac supervisor log identify tunnel generations,
connection establishment and reconnects. Router disconnect events distinguish
idle losses from browser actions with uncertain outcomes.
