---
name: shared-browser
description: Control persistent remote Chrome with shared_browser_repl on dev-tools hosts; share the DOM viewer with the user for simultaneous browsing, files, and supported passkey handoffs.
---

Use the registered `shared_browser_repl` MCP for browser work. It replaces the
Mac SSH browser relay and noVNC workflow on hosts with the shared runtime installed.
First call `js` with `await cua.getState()`. Share the returned `viewerUrl` so the
user can watch and interact on a computer or iPhone connected to Tailscale.

Follow the tool's returned API. Typical calls:

```js
const browser = await cua.getBrowser();
const tab = await browser.tabs.new('https://example.com');
nodeRepl.write(await tab.getAXState());
```

Use fresh node IDs for `tab.click(id)` / `tab.setValue(id, text)`, or the supported
selectors. Scroll with `tab.scroll({x:0,y:500})`. Inspect after actions, navigation,
and reconnect. Bindings persist within an MCP connection; `js_reset` clears
bindings without stopping Chrome. Do not automatically repeat an action whose
outcome is uncertain after a disconnect.

Humans and agents can interact simultaneously; there is no Take control button.
Viewer disconnection does not stop the browser. Give the user time to finish
requested input, and confirm the result from current page state.

File inputs support human uploads from the viewer and agent uploads via
`tab.setFiles(nodeIdOrSelector, ['/absolute/remote/path'])`. Downloads appear in
the viewer's collapsed Downloads section. `tab.getDownloads()` provides agent
paths. Limits: 10 files, 10 MB each, 20 MB per upload batch.

On procbox, Agent Trace QA passkey requests appear above the viewer with an
Approve with passkey link. The user opens it on their own device, verifies with
their registered authenticator, and returns to the viewer. Verify the portal
actually signed in before reporting success. This is a site-specific adapter,
not universal passkey forwarding; demobox does not have that portal adapter.
Never request passwords, passkey private material, or biometric data in chat.

If tools are absent, reconnect MCP or start a new agent session. Diagnose with
`dev-tools shared-browser status` and `systemctl --user status dev-tools-shared-browser`.
Start a stopped runtime with `dev-tools shared-browser start`. Do not use the
Mac relay or noVNC unless the user explicitly requests that fallback. Do not
change tailnet ACLs to fix reachability without an authorized network task.

Each host has one shared browser profile for its OS user. It is not isolation
between unrelated agents. DOM replay has limitations for canvas, video and
other non-DOM content; do not describe it as universal native desktop control.
