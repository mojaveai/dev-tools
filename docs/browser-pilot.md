# Browser pilot evidence — 2026-09-09

Implementation remains opt-in (`--with-browser`). This file records measured
results, not a claim that the complete two-environment rollout gate has passed.

## Coder container

Environment: Ubuntu 26.04, amd64, no systemd; Node 22.23.2, Playwright MCP
0.0.80 with its lockfile-selected Chromium, distribution TigerVNC/noVNC packages.
The container has a 64 MiB `/dev/shm`; automatic disk-backed Chromium shared
memory was needed for concurrent headed browsers. Chromium's sandbox stayed on.

`node tests/browser-live.mjs` passed with synthetic login data:

- Two independent native desktops, with real Playwright MCP navigation.
- noVNC starts in view-only mode and sends human-style mouse/keyboard input
  through websockify/VNC to the same browser the agent controls.
- The agent observes a login entered through that viewer.
- Closing the viewer and reconnecting MCP preserve the running browser.
- Stopping/resuming the session retains the saved login; stopping one session
  leaves the other running.
- Browser debugging, VNC, and websockify listeners are loopback-only.

Provisioning rerun: **1.1 seconds**, `OK`, authentication and unrelated MCP
configuration byte-identical. Spy executables confirmed no invocation of
apt-get, curl, codex, claude, tailscale or pass-cli during that browser rerun.

Partial-install repair: removed the installed Playwright MCP entrypoint, then
reran the module. It restored the runtime in **1.52 seconds**, reported
`UPDATED`, and left an existing browser process running. Neither operation ran
an authentication flow. These timings describe this host and its warm caches.

Offline regression coverage includes config preservation, malformed config
refusal, exclusive agent attachment, task IDs, PID reuse, pending Mac approval,
proxy adapter configuration, Serve route ownership, Funnel rejection, timed-out
publication cleanup, and the default-rollout gate.

The existing JSON/TOML merge helpers had a dash heredoc/stdin bug: they could
consume the Python program instead of the incoming patch and silently do no
work. This implementation fixes it and tests real merge behavior under `sh`.

## Still required before default rollout

- An ordinary Linux host pilot, including native provisioning and the live test.
- Real Tailscale Serve publication and HTTPS/WebSocket access from a second
  authorized device in both environments.
- Tailnet ACL/grant audit, policy tests, and a denied-device access check.
- Optional Mac service approval/revocation and actual userspace proxy connectivity.

This Coder container does not expose a Tailscale CLI or LocalAPI socket. Its
tailnet network identity is insufficient to configure Serve from inside the
container. `doctor` reports that gap. No second daemon, new tailnet enrollment,
public listener, or replacement SSH tunnel was introduced to bypass it.
The user's existing Mac browser tunnel is unchanged.
