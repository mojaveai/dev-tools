# Shareable Linux browser sessions

The agent controls a browser on the Linux machine with local Playwright MCP.
You open a private noVNC URL to see **that same browser** and enter a login when
needed. Your Mac need not be online; any authorized tailnet device can view it.
No Docker, XQuartz, public listener, or SSH port-forward is required.

## Install and rerun

Browser provisioning is a **pilot opt-in** until the acceptance matrix below is
complete. It is not silently enabled on every existing development machine.

```sh
curl -fsSL https://raw.githubusercontent.com/mojaveai/dev-tools/main/bootstrap.sh | sh -s -- --with-browser
# From a checkout:
./provision.sh --with-browser
# Only the browser step on an already-provisioned machine:
./provision.sh --only mod_browser --with-browser
```

The same command can be rerun to repair or update an existing installation.

Requirements: Debian/Ubuntu, amd64/arm64, Python >=3.11 (the existing Codex TOML
merger's requirement), Node >=18, and root/passwordless sudo for missing system
packages. Supported OS/architecture combinations are detected before installing.
Run browser sessions as an unprivileged user with sudo available for setup;
the launcher does not disable Chromium's sandbox to accommodate root.
An unsuitable platform or lack of package privileges is reported as `SKIP`.
An interrupted download/install is a failure that a rerun repairs.

- Native desktop packages come from the distribution; Playwright MCP and its
  compatible Chromium are pinned by `config/browser/package-lock.json`.
- A fully provisioned host checks installed packages, runtime identity, browser
  dependencies and owned configuration. It does not refresh apt indexes, fetch
  npm metadata, redownload Chromium, or restart healthy sessions.
- An installed browser module continues to converge on normal provisioning
  reruns, even without repeating `--with-browser`. `--skip mod_browser` skips it.
- Browser setup never runs `codex login`, `claude login`, `tailscale up`, or vault
  authentication. Existing CLI authentication and browser profiles are retained.
- `dev-tools-browser` is added to Codex and Claude Code's user MCP configuration.
  Existing servers, settings, authentication and the old `mac-chrome` server are
  preserved. Restart/reconnect the agent once to discover the added tools.

## First shared session

```sh
dev-tools browser doctor --json
dev-tools browser start my-task --json
```

Local browser readiness and tailnet publication are deliberately separate. A
missing viewer URL does not imply that local Playwright is broken.

Before first publication, the tailnet owner must review access to this host's
HTTPS viewer port, including existing broad rules. Tailscale grants are additive:
adding a narrow grant does not revoke an existing `*:*` grant. Restrict this
listener to the intended owner/viewer identities or devices; do not assume every
machine tagged `dev` should be able to view every other machine's signed-in
desktop. Use the tailnet's policy tests to verify allowed and denied sources.

Once that review is done:

```sh
dev-tools browser publish my-task --policy-reviewed
dev-tools browser url my-task
```

The review acknowledgement is saved on this host, so subsequent sessions publish
automatically without another acknowledgement. It is **not** a policy engine:
this helper cannot infer or enforce your organization’s authorization policy.
Review again when that policy or the host's ownership changes.

Tailscale must be running with MagicDNS and HTTPS enabled, and the Linux user
must be authorized to manage Serve. If an operator needs to be designated, the
administrator can use Tailscale's operator setting for that user; the helper
does not grant itself privileges. Serve failures include the daemon's diagnostic.

The URL has this shape (with connection settings in its query):

```text
https://HOST.TAILNET.ts.net/browser/SESSION/vnc.html
```

Serve forwards the session's path and WebSocket traffic to local websockify.
An existing route with the same name is not overwritten. Other Serve handlers
are preserved. Publication refuses an HTTPS listener that has Funnel enabled.
No command in this feature enables Funnel or modifies tailnet ACLs.

The default HTTPS port is 443. Set `viewer_https_port` in the local browser
configuration to another private Serve port if 443 has public Funnel exposure.
If this container's Tailscale daemon is elsewhere, supply a supported CLI and
its mounted LocalAPI socket via the `tailscale` and `tailscale_socket` config
keys. A tailnet IP alone does not prove the CLI/Serve API is available inside
the container. Do not start a second daemon over an existing workspace setup.

## Agent and human collaboration

Agents normally use the registered MCP without manual startup. Each MCP launcher
selects the current Codex task ID, `DEVTOOLS_BROWSER_SESSION` if supplied, or a
fresh generated session ID. Task identities are hashed before becoming directory
names. Explicit names can be supplied to `dev-tools browser mcp NAME`.

The launcher prints its session ID and viewer state to **stderr**, leaving stdout
for the upstream MCP protocol. The helper's `list`/`status` commands expose the
same metadata. The bundled `shared-browser` skill explains how to find and share
the URL, and how to wait for user input. For clients without task identity,
set a distinct `DEVTOOLS_BROWSER_SESSION` per task when launching that client;
otherwise use the generated ID from its MCP startup log. Never set one global
session name for every task.

The viewer starts in **view-only** mode. To enter a login:

1. Ask the agent to pause browser actions and wait for it to stop.
2. Enable input using noVNC's settings and enter the login in the live browser.
3. Tell the agent to resume, optionally returning the viewer to view-only mode.

Input mode does not acquire a lock or automatically pause an agent. Do not
paste credentials into the task. Modern browser passkeys tied to a local Mac
may require another authentication method; the optional Mac capability can be
used when the task really needs that Mac's browser state.

Closing the viewer, ending an MCP connection or dropping SSH leaves the native
session running. Reattaching the same session reaches the same browser. Only one
agent MCP client can attach to a named session at a time. Other tasks use
independent profiles, displays, browser processes and viewer ports.

```sh
dev-tools browser list --json
dev-tools browser status my-task --json
dev-tools browser stop my-task
dev-tools browser start my-task       # restart with its saved profile
dev-tools browser delete-profile my-task --yes  # requires a stopped session
```

`stop` removes only an owned Serve route and the session's processes. If
Tailscale is unavailable during cleanup, route ownership is retained for a
later retry. The helper does not remove routes someone else changed, delete
another X display's lock, or kill every Chrome process. Processes are identified
by PID, Linux start time and boot ID to avoid signalling reused PIDs.

The default limit is eight live sessions per Linux user; adjust `max_sessions`
in the local config if needed. Sessions are not silently evicted. Browser RAM
remains in use until the session stops. After a host reboot, processes restart
on demand with the retained profile rather than automatically restoring every
old task. Browser profiles are not backed up or copied between hosts.

## Optional Mac browser

The Linux-local browser works without any Mac access. To configure the option:

```sh
./provision.sh --with-mac-browser https://MAC.TAILNET.ts.net/mcp
# Containers using dev-tools' Tailscale HTTP proxy:
./provision.sh --with-mac-browser https://MAC.TAILNET.ts.net/mcp \
  --mac-browser-proxy http://127.0.0.1:1056
```

This registers a separate `dev-tools-mac-browser` MCP client in a **pending**
state. It uses the existing `mcp-remote` adapter, not a custom transport. No Mac
extension token is copied to Linux.

The Mac owner separately runs Playwright MCP with its browser extension in a
dedicated automation profile, serves that MCP HTTP endpoint privately through
Tailscale, and authorizes this Linux machine in tailnet policy and the extension.
That Mac service is not installed remotely by this Linux provisioner. The
currently working Mac SSH tunnel is left intact.

After the owner has approved that access:

```sh
dev-tools browser approve-mac
# Disable this client again:
dev-tools browser revoke-mac
```

The local approval flag prevents accidental use; it is not protection against a
hostile agent with the same Linux account. The actual boundary is Mac-side
network policy and extension authorization. Revoking an already active session
also requires disconnecting it in the Mac extension or removing network access.
Rerunning provisioning against the same endpoint preserves approval and the
adapter's authentication cache. Changing the endpoint/proxy requires fresh
approval. No interactive authentication is attempted by installation.

## Files and service model

- CLI: `~/.local/bin/dev-tools`, linked into the installed repository.
- Runtime: `~/.local/share/dev-tools-browser/runtime` (outside bootstrap's
  replaceable repository tree).
- Config: `~/.config/dev-tools/browser.json` (0600).
- Sessions: `~/.local/state/dev-tools/browser/sessions/ID/` (0700), containing
  profile, process metadata, X authority, `supervisor.log` and MCP artifacts.

The supervisor is a detached process group with log files and no controlling
terminal. It works in systemd machines and Coder containers alike. A component
failure stops that session's remaining components; the next start resumes its
profile. It does not silently restart an active automation mid-operation.

All browser/CDP, VNC and viewer listeners bind loopback. X uses a private
authority cookie and no TCP listener. The viewer is nevertheless powerful:
authorized viewers can interact with the desktop and signed-in sites. Sessions
under one Linux account are not sandboxes from that account or each other.
Use separate accounts/hosts for untrusted agents and do not store profiles in
git. No passwords are included in viewer URLs.

## Validation and release gate

```sh
python3 -m unittest discover -s tests -v
node tests/browser-live.mjs
```

The live test uses temporary profiles and synthetic login state. It exercises
real Playwright MCP, two native desktops, noVNC input, reconnects, persisted
login, loopback binding and session-scoped cleanup. It deliberately does not
claim to test another device's tailnet access.

Before enabling the module by default, record these in an ordinary Linux host
**and** a Coder-style environment:

- Fresh install and cheap rerun; partially removed runtime repaired; no reauth.
- Live test passes, including human-style input over noVNC.
- Viewer URL opens from a second authorized tailnet device, including assets
  and WebSockets beneath the session path.
- A policy test and an unauthorized device both confirm viewer access is denied.
- Mac disconnection does not interrupt Linux automation.
- Existing Serve handlers and browser profiles survive reprovisioning.
- Optional Mac access is blocked before approval and works after approval;
  userspace proxy connectivity is exercised where applicable.

The pilot remains opt-in while any required environment/network check is
unavailable. Installation success is not full acceptance.
