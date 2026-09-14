# Shared browser pilot evidence — 2026-09-13

## Stage 1 implemented and activated

Procbox runs the new user service and its sandboxed Chromium. The separate
`shared_browser_repl` MCP is registered both on procbox and on the Mac client.
The browser and profile live on procbox; the Mac transports only tool calls when
used as the agent client. Existing native relay and noVNC configurations were not
replaced.

Verification completed:

- Three new runtime regression tests pass on macOS and procbox/Linux.
- The actual stdio MCP integration passes eleven checks: discovery, persistent
  JavaScript, form input/clicks, denied unauthenticated/wrong-user HTTP, DOM
  delivery, human exclusion of agent mutations, stale generation rejection,
  viewer disconnect, viewer reconnect, MCP reconnect, and MCP reset.
- Real Chrome viewer QA through a temporary local SSH test connection: typed
  `Human-side edit verified`, clicked Save, and observed the saved result.
- The actual MCP read that exact remotely stored value, then changed the notes
  field and counter. Both changes appeared in the viewer's DOM/accessibility
  tree. The screenshot confirmed normal text, controls, and layout.
- Native-style `getAXState()` exposes current node IDs and values through MCP.
- The owner-only Tailscale policy patch passes `git apply --check` against the
  inspected Agent Trace checkout. The matching grant is now saved in the live
  Tailscale policy; the GitOps source patch remains pending.
- Existing repository-wide Python discovery reports three failures and two
  errors on this Mac. An isolated archive of unchanged HEAD reproduces exactly
  those failures: Linux `/proc` assumptions, macOS path canonicalization, and a
  pre-existing `configure` module import collision. No existing test code changed.

## Direct link verified

After the user signed into Tailscale admin, saved the owner-only grant:
`manbir@asgroup.ai` → `tag:procbox` → `tcp:8443`. Existing rules and Serve
routes were preserved. No credential vault was accessed.

`https://procbox.agent-trace.ts.net:8443/status` now returns HTTP 200 from the
Mac. Opened the direct viewer in Chrome and used the actual remote MCP to save
`Hello Manbir — this was entered by the remote agent.` and increment the counter
to 1. Both appeared in the direct viewer's accessibility tree. The viewer is
open for the user's first joint takeover test.

## Remaining staged work

1. Preserve the already-live narrow grant in the GitOps source of truth using
   `shared-browser-access.patch`; avoid overwriting unrelated live policy rules.
2. Confirm the direct URL on a real second device and iPhone. Jointly test
   takeover, handback, mobile resizing, five-minute reconnect, and an independent
   remote agent with the Mac disconnected. Measure bandwidth and latency against
   the pixel baseline. User acceptance remains pending.
3. After core acceptance, implement and jointly test uploads (desktop/iPhone,
   multiple files, cancellation, 50 MiB limit, interrupted transfers, hashes),
   downloads, clipboard/IME/contenteditable, frames, popups, and dialogs.
4. After edge-case acceptance, implement a separate approval-gated WebAuthn
   signer and private test relying party. Register an approval passkey on the
   iPhone and a distinct software-held website credential. Verify request-bound,
   single-use, two-minute approvals, user verification, cancellation, replay and
   cross-session rejection. No signing without verified approval; no private key
   access from the browser/MCP runtime. Host administrators remain trusted.
5. Inspect the intended Agent Trace endpoint and test authentication only. The
   inspected approval dashboard requires attested, hardware-bound YubiKey Bio
   credentials. Software-credential rejection is expected there; do not alter
   that policy or claim support for existing iCloud/YubiKey forwarding.

Stage 1 implementation is not acceptance of Stages 2–4. Uploads and WebAuthn have
not been activated. Documentation and rollback are in `shared-browser.md`.

## Shared control update

The user requested simultaneous access, matching local Chrome control. Removed
exclusive ownership; viewer and MCP actions execute through one ordered queue.
Take/give messages from old viewers are compatibility no-ops. Handoff buttons
are hidden in the updated viewer. Service restarted to activate this change,
resetting the synthetic test page. The integration test now verifies viewer
form entry followed by MCP Save without ownership handoff. Earlier exclusive
control test descriptions above describe the superseded implementation.

## Viewer input and reconnect repair

The real direct-link viewer reproduced typing without a completed remote Save.
Sandboxed frame event listeners were absent in Chrome diagnostics; Safari also
has a documented parent-listener restriction (WebKit bug 218086). Replaced
frame event handling with native parent-document inputs and button targets,
aligned over the inert replay. Website scripts remain sandboxed.

A separate background-tab issue stalled remote clicks; bringing the fixture to
the front immediately completed queued actions. Both viewer and MCP mutations
now activate their target tab first. Disconnected viewer actions waiting in the
queue are discarded. New connections request a current full DOM snapshot so
input properties restore without replaying historical events.

Verified through real Chrome UI: typed and saved `Saved and survives reconnect`,
read the exact saved output through MCP, reloaded the direct viewer, and saw
the field and saved output persist (also checked visually). Added integration
regressions for background-tab clicks and reconnect snapshot input properties.
Actual iPhone verification of this repair remains pending. The server restart
for the tab activation fix reset the synthetic fixture; no production page used.

## First iPhone synchronization and performance follow-up

User successfully saved `Milk boy`; confirmed via remote MCP. User reported slow
typing, jittery scrolling, and after-images. Viewer now batches layout work into
animation frames, ignores non-layout replay events for layout, avoids rebuilding
unchanged select options/styles, coalesces fills (40 ms) and scroll deltas (50 ms),
and flushes pending text before clicks/blur. Disconnect drops unsent batches.
The pinned rrweb scroll adapter forces immediate replay scroll to avoid controls
jumping while the underlying page animates. Editable source copies are hidden
to avoid double drawing. Remote focus/blur echoes are ignored so they cannot
steal focus/keyboard from the local native inputs.

Real desktop viewer test preserved the user's message, typed a separate Notes
value and confirmed every final character through MCP, and inspected scrolling
visually. iPhone smoothness and measured latency remain unverified; no claim of
native scroll latency yet (scroll still requires a remote round trip).

## Local scrolling and initial viewport negotiation

Viewer connects with its width/height. The server applies these before producing
its initial full snapshot and ready marker. The page stays hidden until that
snapshot has the requested width, preventing a desktop-first flash. Width changes
still resize the remote viewport; keyboard/address-bar height changes do not.

Wheel and touch gestures now scroll the local replay immediately and reposition
native controls in the same paint. Touch release adds local momentum. Batched
absolute positions synchronize the relevant document/nested scroller remotely.
Sequence numbers prevent stale acknowledgements from correcting newer gestures;
short-lived echo suppression prevents replayed remote scrolls causing bounce.
Pending gestures are discarded on disconnect or navigation. Existing viewers
and agents still share one remote viewport and authoritative scroll position.

Five unit tests pass, including out-of-order acknowledgements and independent
nested targets. Fourteen integration checks pass, including phone dimensions in
the first snapshot, absolute scroll acknowledgements and stale-generation
rejection. Actual Chrome viewer at phone width reported width 378 and scroll Y
817; a read-only remote inspection confirmed the same width and Y. User message
`Updated check!` and Notes restored after service activation. Physical iPhone
momentum feel remains to be confirmed; this is local gesture handling, not a
claim that every native Safari scrolling behavior has been reproduced.

## Agent action feedback

Added a separate agentActivity stream (no website text or credentials). Click,
fill, selection and scroll tools retain their interfaces. With viewers attached,
an action emits its target and kind, allows a 240 ms visual lead-in, then emits
completion or failure after the actual operation. No-viewer actions skip the
visual lead-in. The viewer renders an original purple cursor with a curved local
motion path, target outline, confirmed-click pulse, and editing/scroll labels.
Keyboard typing uses actual character input with a short delay; bulk replacement
is highlighted as editing rather than displaying fictional keystrokes. Reduced
motion preferences are respected. Feedback cannot receive pointer events.

Eight unit tests pass, including ordering, no false success on failure, and no
visual wait without viewers. Fifteen integration checks pass, including matching
start/completion messages for click, typing and selection. A real Chrome screenshot
confirmed the cursor, target outline and Agent badge at the Save button.

The prior fixture renderer stopped answering Runtime.evaluate/Network.enable;
no dialog was present. Recovery restarted the browser, so latest user edits could
not be preserved. Root cause of that renderer stall remains undiagnosed. The
current fixture says `Ready for the visual demo.`. The user asked us to wait for
their next message and then start the next watch-along demo after 10 seconds.

## Viewer access recovery

The viewer became unreachable while the remote browser and loopback status stayed
healthy. The live Tailscale policy lacked the previously approved owner-only
8443 grant. Restored exactly manbir@asgroup.ai -> tag:procbox tcp:8443 through
the admin console. HTTPS status now succeeds from the Mac and the real Chrome
viewer displays Connected, shared access, and the existing message/Notes. No
service restart or session reset was needed.

Current Agent Trace main deployment policy also lacks this grant; a deployment
may overwrite the live repair. Refreshed shared-browser-access.patch against
current main. This source patch remains to be incorporated into Agent Trace;
no production deployment or unrelated access changes were performed.

## Accepted cursor demo and saved progress (2026-09-14)

The user reported the second cursor demo was looking great. The viewer now uses
a solid dark arrow based on the supplied SVG silhouette, subtle click pulses,
and local DOM target bounds refreshed during scrolling to keep highlights aligned.
Agent actions continue to scroll targets into view. The demonstration used real
MCP clicks, character typing, select changes, checkbox/counter actions, and scrolls.
Final saved message: `Demo complete — your turn!`, color Ocean, counter 4.
Notes retained prior text and received an insertion at the current line end;
keyboard End is line-end, not document-end, so this was not an append-to-end test.

All eight unit tests and the build pass at this checkpoint. Fifteen integration
checks passed previously; no new integration run was needed for this save-only
checkpoint. Uploads and WebAuthn remain future stages, not implemented features.

The permanent Tailscale source grant and policy assertions are now on Agent Trace
main in 53c97e51 and signed follow-up 90800c94. Policy assertions are committed;
they have not yet been evaluated against the tailnet as part of a release.
Structural comparison verified the grant insertion preserved other policy entries.
The live viewer already works with the restored rule; no production release was
triggered. Older release policies can still overwrite it. GitHub CI may run for
the source commits; the initial unsigned REST commit does not meet the signed-head
check, so a GitHub-signed follow-up was created without rewriting history.
