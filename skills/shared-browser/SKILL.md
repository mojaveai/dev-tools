---
name: shared-browser
description: Use native cua_repl routing on dev-tools hosts, with Mac Chrome preferred and local native fallback; identify the active browser destination and use the optional noVNC viewer for explicit manual fallback tasks.
---

Use the `cua_repl` MCP for Codex browser work on dev-tools hosts. Each JavaScript
result identifies the selected machine. It prefers a connected Mac Chrome
extension, otherwise a connected local browser. Follow the tool's returned API
and permission instructions. The legacy `dev-tools-browser` and
`dev-tools-mac-browser` MCPs are retired.

Selection happens on the first `js` call with a connected browser. If neither
machine has a browser, discovery can be retried in the same MCP connection after
the user opens ChatGPT desktop and Chrome on the browser host. The Mac extension
requires that desktop app; a headless Codex app-server alone does not supply it.
`dev-tools native-browser check --json` distinguishes tunnel failures from a
runtime with no connected browser. It reports `unavailable` when neither works.

After dispatch, the destination stays pinned until `js_reset`. A successful
reset releases it; the next `js` may select a different machine. Inspect the
reported destination and fresh browser state before continuing. If a connection
drops during an action, its outcome may be unknown: reset and inspect, never
replay that action automatically. Do not weaken permissions to make a route work.

`dev-tools native-browser check` reports current route availability but does not
change the destination of an existing connection. Native tools require genuine
Codex task/turn metadata and approval callbacks from the registered MCP connection;
do not manufacture approvals. If `cua_repl` is missing from available tools,
reconnect MCP or start a fresh task. Installation automatically restores a missing
registration on Linux hosts with user systemd. `check` only checks the route,
not the current task's tool registration or approval support.

Do not launch the native runtime from a shell or `node_repl` and build a custom
MCP client. That client does not inherit Codex's approval handling. `JavaScript
execution requires an approval elicitation` indicates a client integration
problem; asking for blanket user permission cannot configure a missing callback.

For an explicitly requested noVNC fallback, use `dev-tools browser start NAME
--json` and share the returned `viewer_url`. These are separate viewer sessions;
verify the exact browser/tab before claiming the viewer shows native CUA actions.
Missing publication is diagnosed with `dev-tools browser doctor --json`.

- When login or human input is needed, stop browser actions and run
  `dev-tools browser request-input SESSION --message "Please sign in, then click Done" --json`.
  Share the viewer URL and explain the task. The viewer enables input and shows
  a Done button automatically; do not ask the user to find noVNC settings.
- Save the returned request ID. Wait with
  `dev-tools browser wait-input SESSION --request-id ID --timeout 60 --json`.
  Repeat while that same request is pending. Resume browser actions only when
  that request reports `completed` (the user clicked Done), or the user explicitly
  confirms completion in conversation. For conversational completion, use
  `dev-tools browser cancel-input SESSION --request-id ID` to return to view-only.
  Timeout, viewer disconnect, cancellation, or a different request ID is not
  permission to resume. Never put passwords in the handoff message or ask for
  passwords in chat. This cooperative handoff does not mechanically block MCP actions.

`browser stop ID` preserves the profile; deleting a profile is explicit cleanup.
Do not change tailnet policy just to make a viewer reachable. Sessions share their
OS user's privileges and are not isolation boundaries between untrusted agents.

If discovery reports `unconfirmed`, `discovery_timeout`, or a transport failure,
report that connection verification failed temporarily, not that Chrome is
closed or absent. Discovery already performs bounded retries; after a short
pause, retry the registered tool's discovery before declaring browser work
blocked. After a stream loss, reset and recreate JavaScript bindings. An idle
loss has no pending action; an in-flight action may have completed and must not
be replayed. Never silently substitute a local browser when the user requested
the Mac browser.
