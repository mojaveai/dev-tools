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
