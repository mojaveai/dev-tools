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

When a site in the shared browser asks for a passkey (sign-in or registration),
the viewer shows **Approve with passkey** on every dev-tools host. Tell the user;
they click it in the viewer, approve at the real site with Touch ID, a YubiKey or
another passkey on their Mac (Chrome or Safari with the Dev Tools Auth extension),
and return to the viewer automatically. Wait for them, then confirm from the page
that the site actually signed in; delivery alone is not success. Requests expire
after two minutes. If the button says to enable Dev Tools Auth, the user's
extension is not loaded in that browser. Agent Trace uses the same extension
approval flow as every other HTTPS site.
Never request passwords, passkey private material, or biometric data in chat.

If tools are absent, reconnect MCP or start a new agent session. Diagnose with
`dev-tools shared-browser status` and `systemctl --user status dev-tools-shared-browser`.
Start a stopped runtime with `dev-tools shared-browser start`. Do not use the
Mac relay or noVNC unless the user explicitly requests that fallback. Do not
change tailnet ACLs to fix reachability without an authorized network task.

Each host has one shared browser profile for its OS user. It is not isolation
between unrelated agents. DOM replay has limitations for canvas, video and
other non-DOM content; do not describe it as universal native desktop control.
