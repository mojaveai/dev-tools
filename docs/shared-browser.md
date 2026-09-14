# DOM shared browser pilot

Stage 1 implementation lives in `shared_browser/`. It runs one persistent remote
Chromium browser and shares reconstructed DOM, not video. It is separate from the
Mac native relay and from the existing noVNC viewer.

## Installed pilot

- Host: procbox, service `dev-tools-shared-browser.service` (user systemd).
- Code: `~/.local/share/dev-tools-shared-browser/`.
- Profile and private RPC socket: `~/.local/state/dev-tools/shared-browser/`.
- Viewer: `https://procbox.agent-trace.ts.net:8443/` through Tailscale Serve.
- HTTP upstream: loopback port 8791. Agent RPC uses a mode-0600 UNIX socket.
- Viewer access requires Tailscale's verified `manbir@asgroup.ai` login header.
  Other users, tagged identities without that login, missing identity, and
  cross-origin WebSocket connections are rejected. This does not protect against
  a privileged process on the browser host fabricating proxy headers.

The remote browser does not depend on a viewer or an SSH session staying open.
Both viewers and agents can interact without taking control. Individual actions
execute through one ordered queue. There is no ownership lock or idle handback.
Viewer disconnect does not pause the agent. Changes to the same field can still
overwrite each other, as with two people using one browser.
MCP reconnect/reset preserves the browser but resets JavaScript
bindings. Browser process failure is explicit; the service does not replay actions.

The owner-only TCP 8443 grant is saved in both the live Tailscale policy and
Agent Trace's `deploy/gitops/tailscale-policy.hujson` on `main`. Source commits
`53c97e51` and `90800c94` preserve the grant and add policy assertions for owner
access, neighboring-port denial, and service-host denial. The latter commit has
a valid GitHub signature. The first REST-created commit was unsigned; the
signed follow-up restores the signed-head requirement without rewriting history.
These changes do not replay a production deployment. Releases built from older
commits still contain the old policy and can remove the grant. Use a release that
includes the source fix. `shared-browser-access.patch` retains the complete source
diff for reference. Do not enable Funnel.

## Setup and operation

Copy this directory to the code location, then run `sh install.sh` on procbox.
The installer reuses the sandbox-verified Chromium path from dev-tools' browser
configuration when available. It never disables Chromium's sandbox.

Publish only after inspecting existing Serve configuration:

```sh
sudo tailscale serve --bg --https=8443 --yes http://127.0.0.1:8791
~/.local/bin/dev-tools-shared-browser status
~/.local/bin/dev-tools-shared-browser url
~/.local/bin/dev-tools-shared-browser request-input 'Please check the form.'
```

`start` and `stop` explicitly control the persistent browser. A stop/start retains
the profile; it does not promise to restore unsaved live-page state. Service
reruns do not restart a healthy process; after a code update, explicitly restart
the service when no human is editing.

The source checkout's `bin/dev-tools shared-browser` exposes the same commands.
The independently installed pilot also provides `dev-tools-shared-browser` so it
does not need to overwrite the existing managed dev-tools installation.

## Agent tool surface

Register the stdio MCP using:

```sh
codex mcp add shared_browser_repl -- /usr/local/bin/node /home/manbir/.local/share/dev-tools-shared-browser/mcp.mjs
```

On a separate agent host, prefix the command with `ssh -T -o BatchMode=yes
-o StrictHostKeyChecking=yes procbox`. This transport carries tool calls, not the
viewer. New MCP registrations may require reconnecting the agent's MCP tools.

The `js` tool accepts persistent JavaScript with `await`. Example:

```js
const state = await cua.getState();
const tab = await cua.getTab(state.activeTab);
nodeRepl.write(await tab.getAXState());
```

Use `tab.click(nodeId)` or `tab.click(cssSelector)`, `tab.setValue(nodeId, text)`,
`tab.type(selector, text)`, `tab.typeText(text)`, `tab.pressKey(key)`, and
`tab.scroll({x, y})`. `tab.getState()` includes DOM observations and identity;
`tab.getScreenshot()` returns an image only when requested. Tab lifecycle,
navigation, form selection, and JavaScript dialogs are supported. Optional
semantic locators are also available. Read the MCP's tool instructions for the
complete supported surface; it is not the proprietary native runtime.

Humans and agents share one ordered action queue without a takeover lock.
Inspect state after a timeout or reconnect; never blindly replay an uncertain action.

## Tests and current acceptance gates

```sh
npm ci
npm run build
npm test
# Against the running pilot on procbox; opens only synthetic test tabs:
node test/live.mjs
```

The live test uses the actual MCP SDK and stdio server, plus viewer WebSockets.
It checks tool discovery, persistent bindings, form entry, DOM delivery, denied
access, shared mutation access, stale input rejection, and viewer/MCP reconnect/reset.
It does not establish that a second physical device can reach the Tailscale URL.

Visual QA can use `test/qa-proxy.mjs` with a temporary loopback-only SSH forward.
That helper injects the owner identity solely for local testing. It must never be
published or represented as the independent remote viewer deployment.

Core collaboration and the refined cursor demo have been accepted by the user.
Uploads/downloads are implemented and tested on desktop; physical iPhone acceptance
is next, followed by passkey-gated WebAuthn against a private fixture.
Contenteditable/IME fidelity, arbitrary cross-origin-frame input, and pixel-free
canvas/WebGL support are not yet accepted.
A separate cooperating-site passkey approval fixture is now available; see
[the passkey fixture guide](shared-browser-passkey-fixture.md). Transparent WebAuthn
interception and an approval-gated third-party credential service remain unimplemented.
The inspected Agent Trace approval dashboard requires attested YubiKey Bio
credentials, so a software credential must not be represented as compatible.

## File transfers

The viewer uses a local native file picker for visible remote file inputs. Selected
bytes travel over an owner-authenticated, exact-origin HTTP request, independently
of the DOM stream. The server binds attachment to the live viewer connection, tab,
and document generation, stages files privately, then sets the real Chrome input.
Interrupted requests are not retried. Cancellation before attachment keeps the
existing selection. If a connection drops after attachment but before its response,
the viewer reports uncertainty and asks the user to inspect the page.

Custom upload buttons are intercepted in Chrome and display a Choose files / Cancel
prompt in the viewer. The extra user tap preserves browser user-activation rules
on iPhone. Closing this prompt discards it without clearing existing files. Native
website cancel-event fidelity and directory pickers are not implemented.

Agent examples (paths are on procbox):

```js
await tab.setFiles('#upload-single', '/absolute/path/to/test.txt');
await tab.setFiles('#upload-multiple', ['/absolute/one.txt', '/absolute/two.txt']);
await tab.chooseFiles('/absolute/path/to/test.txt'); // pending custom picker
nodeRepl.write(await tab.getDownloads());
```

Uploads allow 10 files, 10 MB per file and 20 MB total. Viewer-staged files use
random private directories, preserve duplicate basenames separately, and remain
available to Chrome until the tab navigates/closes or the service stops. Retained
uploads are limited to 128 MB per server process. Agent-supplied source files are
never deleted. Graceful stop deletes the private transfer directory; after a crash,
old private transfer directories can remain on disk and are not re-served.

Chrome downloads continue without viewers. Completed downloads appear as
owner-authenticated attachment links that the user explicitly saves to their own
device. Agent download records additionally expose the private remote path.
Website filenames are sanitized and never become storage paths. The pilot limits
downloads to 20 MB each, 100 MB total and 20 tracked downloads per process.
Downloads are available across viewer reconnects, not service restarts. Streaming
resume, folder uploads, and large-file support are outside this pilot stage.

`node test/transfers-live.mjs` checks identity/origin enforcement, connection and
generation binding, file limits, wrong targets, exact hashes, duplicate names,
repeat selection, agent uploads, custom picker cancellation, interrupted transfer,
and downloads/reconnect. Use `TEST_PORT` and `SHARED_BROWSER_STATE` for a separate
QA instance. `npm test` includes transfer size/path/storage checks.

## Rollback

```sh
systemctl --user disable --now dev-tools-shared-browser.service
sudo tailscale serve --https=8443 off
codex mcp remove shared_browser_repl
```

Remove the matching MCP registration on any other client where it was added.
If the owner-only grant was applied, remove that exact grant from both the live
policy and its source of truth. Keep the profile unless deletion is separately
requested. Other Serve routes, Mac relay configuration, and noVNC profiles remain
unchanged.

### Embedded-frame handoff regression

`SHARED_BROWSER_CHROME=/path/to/chrome node test/iframe-live.mjs` runs an isolated
cross-origin frame fixture. It verifies initial images, reconnect snapshots,
human coordinate clicks, and replacement images after an action. The viewer
uses direct DOM rebuilds because rrweb 2.1.4's synchronous virtual DOM path can
lose iframe documents/images. Frame clicks retain the human's page coordinates.
Recorder snapshot requests also propagate to cross-origin child recorders.

The CAPTCHA acceptance test is human-operated: inspect image loading metadata
and validate interactions on the fixture; leave challenge selection and submission
to the viewer. Successful rendering does not guarantee every CAPTCHA provider
will accept a remote browser.

Recorder bundles are loaded when the server starts. An active session can receive
`installFrameSnapshots` in its existing frames and new-document hooks without
closing Chrome; a normal service restart loads it for all future tabs.

### Snapshot delivery under load

`test/socket-delivery.test.mjs` covers ordered delivery of snapshots larger than
8 MiB and bounded queues for stalled viewers. Delivery waits for each WebSocket
send callback before sending the next message. Reconnecting because a single
snapshot exceeded `bufferedAmount` caused a repeated full-page rebuild loop.
`compact-images.mjs` removes repeated inline bitmaps only when the original
image bytes already exist in the authenticated asset relay.

These server changes take effect on service restart. Procbox was restarted with
user approval on September 14 and its nine prior tab addresses were reopened;
the ordered delivery queue and cached-image compaction are active there.

### Paired rendering and delayed-asset checks

The embedded-frame fixture now delays image responses by 700 ms and loads icon
CSS from a different origin. It compares source and replay control/image geometry,
computed styles, visibility, decoded image dimensions, and document layout mode.
This caught three gaps that an immediate local image response missed:

- DOM image mutations can arrive before the source response is cached. The asset
  route now waits up to 15 seconds for those bytes, with disconnect cleanup.
- External stylesheet URLs must resolve against the original stylesheet and go
  through the authenticated relay, including nested CSS imports.
- rrweb 2.1.4 mishandles legacy doctypes in quirks-mode documents. The replay
  adapter invokes its quirks initialization path instead of silently changing
  the page to standards mode and shifting layout/click coordinates.

A paired audit of Google's outer CAPTCHA page confirmed matching layout modes
and measured positions after the fixes. Live challenge transitions and successful
human completion remain acceptance checks; fixture success alone does not prove
all vendor-specific challenge flows work.

### Human click coordinate regression

The paired live audit found a requested tap at (135, 282) arriving on a source
parent DIV at (228, 309). Replay iframe hit-testing can return an ancestor when
pointer events are disabled; resolving that ancestor to a node click moves the
tap to its center. Interaction-layer taps now always retain page coordinates.
The iframe fixture explicitly disables replay-frame hit-testing and verifies
that the intended source button still receives the click. Native form overlays
retain their existing node-based input handling.

Opening a new viewer currently requests a fresh snapshot broadcast to existing
viewers too. During paired audits, keep the diagnostic viewer connected across
steps rather than repeatedly reopening it; this avoids introducing rebuilds
that could be mistaken for an autonomous reconnect loop.

### Visible-Chrome comparison session

For a controlled diagnostic, `SHARED_BROWSER_CDP_URL=http://127.0.0.1:PORT`
attaches the shared service to a separately supervised desktop Chrome. Only
uncredentialed loopback HTTP endpoints are accepted. Stopping the shared service
disconnects this attachment without closing Chrome; normal owned launches retain
their existing lifecycle. Use a separate state directory, listener and viewer URL.

On September 14, the procbox `captcha-ab` desktop loaded Google search without a
challenge, then completed Google's public reCAPTCHA demo using direct noVNC
input. The checkbox reported `aria-checked=true`. This differs from the previous
headless profile and is not a controlled proof that headless mode alone caused
rejection. The subsequent report of nine source images versus an empty replay
frame compared different tabs with the same URL and is retracted. Audits must
match the active tab's `__sharedGeneration`, not rely on URL or page order.

The corrected comparison exposed native editable-field overlays painting above
the embedded challenge and potentially intercepting its taps. The viewer now
checks replay paint order before creating a native overlay and restores the
replay field when it is occluded. An isolated regression covers embedded dialog
occlusion, exact child clicks, and editing the background field after dismissal.
After this fix, the DOM viewer completed a fresh bicycle challenge in the
visible Chrome comparison session: source and replay prompts, images and
selection state matched, and the exact source checkbox returned
`aria-checked=true`. The viewer also showed the green checkmark. This verifies
one DOM-forwarded completion; the normal headless session and user devices
still need retesting. Do not mark universal CAPTCHA handoff accepted.

### Mouse fidelity and repeated-challenge investigation

The viewer now forwards observed mouse movement and separate left-button
press/release events over the page interaction layer, including cross-origin
frames. Native form copies retain their existing editing/click path, and touch
retains tap/scroll handling. A server capability handshake keeps older receivers
compatible. Hover updates are frame-coalesced and acknowledgement-limited so a
slow receiver gets the latest pending position; press/release flush pending
movement in order. No synthetic movement paths or human-like timing are added.
Cancellation/disconnect releases outside the page to avoid activating the control
that was pressed. All mouse operations use the shared session action queue.

Regression coverage checks hover before click, movement with a held button,
separate press/release duration, exactly one click, touch fallback, reconnect
without accidental activation, stale-document cleanup and bounded hover backlog.
The unit suite has 26 passing checks; iframe and navigation live suites passed.

September 14 follow-up observations (not a statistical CAPTCHA study):

- The existing headless session produced both a successful DOM-forwarded bus
  challenge and a rejected crosswalk attempt before the mouse update.
- The mouse update completed a car challenge through the separate visible
  comparison browser, with the exact source checkbox `aria-checked=true`.
- The normal profile still produced rejection after the update. Temporarily
  running that same profile/binary/network on an Xvfb display did not eliminate
  rejection either. The experiment was reverted to normal headless operation.
- A direct-CDP crosswalk challenge in that same profile passed; another shared
  attempt did not. Earlier direct attempts expired and are inconclusive.
- Inspected prompts, selections and image URLs synchronized; decoded RGBA image
  checksums also matched in an inspected 4-by-4 challenge. A live input trace
  confirmed one down/up/click at the requested coordinates with a ~120ms press.

Image classification errors and provider risk decisions remain possible. These
results verify input improvements, **not** a fix for repeated CAPTCHA rejection.
Do not infer that every rejected answer was correct or that forwarding alone
caused rejection. `SHARED_BROWSER_HEADLESS=false` is available for controlled
diagnostics with a separately configured authenticated local display; it is not
the default or a claimed CAPTCHA remedy.

Temporary comparison services are `dev-tools-shared-browser-headed-test`
(port 8792 / private HTTPS 8444) and `dev-tools-captcha-desktop-proxy`
(port 8793 / private HTTPS 8445). The desktop proxy requires the owner's
Tailscale identity for HTTP and validates the origin for WebSockets. It forwards
to the `captcha-ab` desktop, whose browser/CDP listener remains loopback-only.
The normal shared service at 8443 is separate.

The desktop test is also available at `https://procbox.agent-trace.ts.net:8443/desktop/vnc.html`
with the noVNC WebSocket path set to `desktop/websockify`. This reuses the
existing allowed 8443 listener; no tailnet ACL changes were made. The proxy
accepts WebSocket origins 8443 and 8445, with the same owner identity check.
HTTP page/assets and the VNC WebSocket handshake were verified through the
8443 tailnet URL from the Mac. Existing root and passkey routes are preserved.

### Persistent desktop engine and measured CAPTCHA comparison

The installer now defaults to a normal desktop Chrome process owned by
`dev-tools-shared-chrome.service`, with local authenticated Xvfb rendering and no
pixel forwarding. The DOM receiver attaches separately; receiver updates retain
Chrome, cookies, live page state, and focused-tab selection. The first migration
from the old owned headless launch reopens tab addresses but cannot retain unsaved
DOM state. See [installation](shared-browser-install.md).

The follow-up [CAPTCHA investigation](captcha-investigation.md) includes native
Mac, native remote OS input, direct CDP, actual tailnet viewer, recorder-free,
and headless/desktop comparisons. In the fixed 60-attempt desktop block, direct
input completed within three rounds in 24/30 attempts and shared input in 23/30;
both worsened late in the block. This **does not establish the requested
reliability or distributional equivalence**. Earlier one-off successes above
should not be presented as acceptance evidence. Full ordered counts and limitations
are saved with the investigation.
