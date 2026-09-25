# Shared browser installation and agent use

The default Linux installation uses `shared_browser_repl`, replacing the
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

The selected Chrome profile can be pinned in
`~/.config/dev-tools/shared-browser.json`, with absolute `stateDir` and `chrome`
paths and a `hostService` systemd unit name. MCP, CLI, receiver, Chrome host,
passkey helper, and installer all read this selection. Explicit
`SHARED_BROWSER_STATE` / `SHARED_BROWSER_CHROME` / `SHARED_BROWSER_HOST_SERVICE`
overrides remain available for isolated diagnostics. Change this configuration
as part of a coordinated service migration, then run the installer; changing
only the file does not switch already-running receiver/Chrome processes.

Procbox's operational profile is
`~/.local/state/dev-tools/shared-browser-primary`, using regular Google Chrome
and `dev-tools-shared-chrome-primary.service`. It was promoted from the tested
session; the standard MCP and port 8443 viewer now use that same session.
The older profile remains at `~/.local/state/dev-tools/shared-browser/profile`;
its Chrome host must be stopped and disabled, while the profile is retained.
Disabling automatic startup alone leaves live tabs polling; copied signed-in
tabs can repeatedly invalidate the selected browser's application session.
The installer retires the previous managed host when changing the receiver's
host dependency. Ordinary updates preserve the selected live browser. Its original
`browser-host.json` retains the older Chrome endpoint for explicit recovery.

The installer keeps the original `shared-browser/server.sock` as a compatibility
link to the selected receiver when that path is free. This lets MCP processes
started before the profile migration keep working. It refuses to replace an
occupied socket or ordinary file. After migration, call `cua.getState()` and
obtain fresh tab handles; `js_reset` only resets JavaScript bindings, not the
MCP process or its loaded tool descriptions. A fresh MCP connection is needed
to refresh descriptions from an older installation.

## Install or update

Run the normal bootstrap or `./provision.sh --only mod_shared_browser` to install
and update the default browser. The provisioner installs missing dependencies,
checks Chromium's sandbox, starts the services, verifies browser RPC readiness,
and publishes port 8443 only when it is free or already belongs to this browser.
Other Serve routes are preserved. Use `--skip mod_shared_browser` to omit it.

Prerequisites for the standalone runtime installer: Linux, Python 3.11+, Node
22+, npm, sandbox-capable Chromium, Tailscale, Xvfb and flock. Hosts with a user
systemd manager use it; containers without one require the `supervisor` package.
The provisioner supplies a private checksum-verified Node 24 LTS build when the
system Node is too old. The shared runtime does not use VNC.

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

The standalone installer infers the HTTPS hostname from this machine's Tailscale DNS name,
installs dependencies/builds assets, enables the persistent service, configures
both agent CLIs, and disables the old native-registration repair service. It
preserves unrelated agent settings. The default `native` engine runs normal
Chrome on an authenticated local Xvfb display, with no VNC or pixel stream.
The configured host service (normally `dev-tools-shared-chrome.service`) owns
Chrome separately from the DOM receiver.
Updates restart the receiver while preserving Chrome, open tabs, and unsaved
page state. Viewer asset changes require a refresh. The first migration from
the old owned headless engine restarts Chrome and reopens saved tab addresses;
cookies/profile data stay in place, but unsaved forms cannot survive that initial
Chrome restart. `SHARED_BROWSER_ENGINE=headless` retains the old launch mode for
diagnostics. Reinstalling in that mode also restarts Chrome.

### Share an existing desktop Chrome

Set `SHARED_BROWSER_ENGINE=attached` and an absolute
`SHARED_BROWSER_CDP_PORT_FILE` when the shared viewer should show a Chrome
window already running on a desktop, including one visible through AnyDesk.
Chrome must have remote debugging enabled on loopback. For the default Linux
Chrome profile the file is usually `~/.config/google-chrome/DevToolsActivePort`;
use the actual desktop user's profile path. Then run the normal installer with
these two variables. The installer configures either systemd or Supervisor
without launching another Chrome. It reads the current debugging port and
browser route on each receiver start, so a Chrome restart does not require
editing a stored WebSocket URL.

The service account must be able to read the port file. If a different desktop
account owns it, grant the service account permission only for `sudo -n cat`
of that exact file. The installer does not change sudoers. Chrome asks the
desktop user to allow the debugger connection, which gives the receiver access
to that Chrome's tabs and browser data. The receiver disconnects rather than
closes the desktop Chrome on stop. When Chrome exits, the receiver stops and
the service retries until Chrome is available again. A new connection may
need another approval in Chrome.

The default managed `native` mode remains the portable choice for hosts with
no desktop Chrome to attach. It uses regular, visible Google Chrome on a
private Xvfb display; that window will not appear in an unrelated AnyDesk
desktop session. Attached and managed Chrome profiles do not share logins.

Do not replace an occupied 8443 listener. Do not reset Serve configuration or
broaden ACLs. Tailscale policy must allow the intended user to reach that port.
Existing noVNC routes and profiles are retained for explicit fallback; no active
legacy sessions are killed by installation.

### Coder pods without systemd

The provisioner installs a private Supervisor instance with a mode-0700 Unix
control socket. Chrome and the receiver run as separate supervised processes;
an installer rerun restarts only the receiver when the Chrome configuration is
unchanged. The supervisor automatically restarts crashed processes and rotates
its logs. A third process restores a missing shared-browser MCP registration
after a workspace template rewrites Codex configuration, preserving user overrides.

The managed Bash startup block and the first MCP call start existing services
after a pod restart. `dev-tools shared-browser start` also starts them explicitly.
Services survive an SSH disconnect. A full pod restart necessarily closes live
pages; the browser profile remains on the user's persistent volume.

Logs and `supervisor.conf` live in the selected browser state directory (normally
`~/.local/state/dev-tools/shared-browser`). Inspect `chrome.log`, `receiver.log`,
`registration.log`, and `supervisor.log` if startup fails. For process status:

```sh
supervisorctl -c ~/.local/state/dev-tools/shared-browser/supervisor.conf status
dev-tools shared-browser status
```

See [Supervisor's configuration reference](https://supervisord.org/configuration.html)
for the process and private Unix-socket settings used by this backend.

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
systemctl --user status dev-tools-shared-browser dev-tools-shared-chrome
journalctl --user -u dev-tools-shared-browser -n 40
```

If dev-tools is not on the shell PATH, use `~/.local/bin/dev-tools`.
`dev-tools shared-browser mcp` starts the stdio server; normally the agent client
launches it automatically from its registered MCP configuration. No Mac or local
viewer must stay connected. The remote Chrome host must remain running.

## Deployment verification (2026-09-14)

Both hosts passed all 15 live MCP checks: discovery, persistent bindings, form
entry/click, shared human input, DOM snapshots, viewport/scroll handling, action
feedback, stale-input rejection, and browser survival across viewer disconnect,
reconnect, MCP reconnect and reset. Both native repair units are inactive and
disabled. Demobox's published viewer returned HTTP 200 from the owner's Mac.
The configuration migration test verifies unrelated settings survive and reruns
are idempotent. All 14 shared-browser unit checks passed.

## Navigation blank-screen fix (2026-09-14)

Finder's hash/history routes exposed a viewer bug: Puppeteer's `framenavigated`
also fires for same-document navigation, and the server/viewer discarded the
recorded document even though no replacement full snapshot would follow.
Refreshing the viewer recovered because reconnect explicitly takes a snapshot.

The viewer now retains the last rendered document until subsequent events or a
replacement full snapshot arrive. This client fix works with the already-running
server and can be activated by refreshing the viewer, preserving the active
Chrome task. The server additionally uses CDP's top-level `Page.frameNavigated`
event to invalidate only genuinely new documents; history/hash navigation only
updates tab metadata. That server change takes effect at the next deliberate
service restart. No restart was forced during the user's active Finder task.

`test/navigation-live.mjs` reproduced the hash-route failure before the fix. Its
real viewer/browser checks pass for hash routing, pushState, and full navigation
through a redirect, both with the old server/new viewer and with both fixes.
This test runs on separate local ports and a disposable profile, without touching
production portal state. All 14 shared-browser unit checks also pass.

## Cursor continuity fix (2026-09-14)

Cursor movement now has one requestAnimationFrame position writer, replacing
competing Web Animation transforms and layout offsets. New actions start at
the current displayed position. Completion freezes the last observed target,
so removal/replacement of a clicked button neither hides the cursor nor pulls
it toward a new layout. Ripple and cursor share the final point. Movement still
tracks target position changes before completion. Viewer refresh activates the
change without restarting Chrome or Codex.

The isolated Chromium pointer test covers target removal, post-click layout
changes, interruption by the next action, and matching target/ripple coordinates.
All four checks passed, alongside the 14 shared-browser unit checks.

## Collapsed form control visibility (2026-09-14)

The QA Finder invitation input retained a nonzero layout box inside closed
`details`, so the native viewer overlay incorrectly exposed it. Overlay creation
now checks closed details (preserving first-summary controls), computed visibility,
content visibility, ancestor opacity and overflow clipping. Partially clipped
controls receive the corresponding clip-path; fully clipped controls are removed.
The replay input's intentional opacity zero remains compatible with native overlays.

The isolated Chromium test passes expand/collapse, summary visibility, CSS-hidden
ancestors, zero-height and partial clipping. All 14 unit checks passed. This is a
viewer-only deployment; refresh the viewer to activate without restarting Chrome.

## Live CSS animations (2026-09-14)

Set rrweb's `pauseAnimation: false` for the live viewer. Its default injected
paused-state rule froze CSS loading spinners even while live DOM updates worked.
The isolated real-viewer test reproduced `animation-play-state: paused` before
this change and verifies that the spinner transform advances during idle time
afterward. Hash/history navigation and redirects still pass. This enables CSS
animations; canvas and JavaScript-driven animations retain their existing limits.
Refresh the viewer to load this client-only update.

## Outlook acceptance pass (2026-09-14)

External-site testing reached Microsoft sign-in, inbox reading, recipient
suggestions and a saved unsent draft. User observations: missing Authenticator
number border, undersized initial pane with a later expansion/stutter, and missing
compose icons/images. No email was sent during the test.

Corrections: normalize asset URLs (including dot segments and protocol-relative
URLs) to Chrome cache keys; rewrite late stylesheet/FontFace asset references;
keep SVG fragments separate from fetch URLs; suppress replay prefetch/modulepreload
requests for scripts that the visual replay never executes. Previously failing
Outlook Fluent icon fonts changed from error to loaded in an isolated viewer
against the same live tab. Failed requests dropped from dozens to a favicon.
Some email images are blocked by Outlook itself; blocked-content policy was not
changed. The exact Authenticator border still needs verification in a later
sign-in; asymmetric border and outline preservation is covered by a fixture.

The viewer now requests its size on tab switches, rather than leaving new agent
tabs at Chrome's default size until a later resize/reconnect. It hides the initial
mismatched viewport until the correctly sized replay is ready. Mirrored inputs
copy per-side borders, outlines and shadows. All 16 unit checks pass, plus live
spinner, hash/history/redirect, asymmetric border and new-tab sizing checks.

Remaining engine observations from Outlook: AX/DOM observations currently cap
at 150 elements, combined key shortcuts are not parsed, and rich-text human
editing needs its own acceptance pass. These are distinct from the visual fixes.

## Edge controls / full-page viewer (2026-09-14)

The permanent title, URL and agent-message bars have been replaced by a small
handle at the top center. Hover reveals the floating toolbar; click/tap pins it
open. Escape, the close button, or a click outside closes it. The toolbar contains
tabs/address/navigation, Downloads and a collapsed Agent message. It does not
participate in page layout. The website now starts at y=0 and uses the available
window width and height instead of reserving 150 pixels for viewer chrome.

Passkey requests and active file transfers float separately near the bottom-right;
dialogs remain accessible. Desktop and 390px phone tests verify opening/closing
controls causes no page-area loss, alongside existing navigation, spinner, border
and sizing checks. Desktop/mobile designs were visually inspected. Refresh the
viewer to activate; no browser or Codex restart is required.

## CAPTCHA investigation and native launch

The controlled comparisons and limitations are recorded in
[captcha-investigation.md](captcha-investigation.md). The engine change does
not spoof browser properties or fabricate pointer movement. A normal remote
profile can still receive image challenges when an established local profile
passes with one checkbox click. There is no guarantee of equal provider decisions
across devices, profiles, networks, or sites.

Native-style coordinate input is available as `await tab.click([x, y])`, in
source viewport CSS pixels. It works across iframe boundaries and emits the
same visual click feedback as other agent actions. Existing node/selector clicks
remain supported.

The final native-engine checks passed on procbox and demobox, including receiver
restarts preserving unsaved parent/child fields and recovering external styles
and CSS background images without reloading the source page. Demobox also passed
a full installer rerun with Chrome PID and unsaved edits preserved. The current
unit suite has 33 checks; iframe and navigation live suites passed 12 and eight.
Run those last two suites sequentially because they share a fixture port.

Use the shared MCP for semantic agent actions in source Chrome. A separate
extension operating the viewer must use actual pointer input; semantic clicks
directly into the visual replay can bypass forwarding. Full screen-reader and
semantic activation parity in the viewer has not been established.
