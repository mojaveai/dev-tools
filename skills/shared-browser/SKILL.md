---
name: shared-browser
description: Use the Linux host's Playwright browser with a private live viewer URL so the user can watch or complete logins in the same session. Applies to browser tasks on machines provisioned by dev-tools.
---

Use the `dev-tools-browser` MCP tools for browser work on this host. They launch
a native Linux session; the user's Mac does not need to stay connected.

- Find your session with `dev-tools browser status --json` when `CODEX_THREAD_ID`
  or `DEVTOOLS_BROWSER_SESSION` is set. Otherwise read the session ID from this
  MCP server's startup log; `dev-tools browser list --json` lists IDs and health.
  Do not guess which session is yours if several agents are running. An explicit
  `DEVTOOLS_BROWSER_SESSION` must be unique to a task.
- Give the user the `viewer_url` as a clickable link early in browser work. It
  opens the exact Linux browser you control, initially in view-only mode. They
  can enable input in noVNC. They need an authorized device on the tailnet.
- If `viewer_url` is absent, report `viewer_error` and use `browser doctor`.
  Local automation can work while publication is unavailable. Never describe a
  configured route as proof another device can reach it.
- When login or other human input is needed, stop browser actions, share the
  URL, and wait for the user to confirm they are finished. Do not ask them to
  paste passwords into chat. Viewer input mode does not pause an agent for you.
- Closing a viewer or MCP connection leaves the browser running. Resume with
  the same named session; do not copy cookies or share a live profile with a
  second agent. `browser stop ID` stops only that session and retains its profile.
  `browser delete-profile ID --yes` destroys saved logins and is explicit cleanup.
- Do not enable Mac access, mark policy reviewed, or change tailnet policy just
  to make a failed connection succeed. Optional `dev-tools-mac-browser` access
  needs the owner's prior approval and network/extension authorization.

These sessions share the Linux user's privileges and are not security sandboxes
between mutually untrusted agents. Use separate Linux accounts/hosts for that.
