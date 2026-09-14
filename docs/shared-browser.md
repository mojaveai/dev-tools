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
