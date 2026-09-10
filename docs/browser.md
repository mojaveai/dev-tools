# Shareable Linux browser sessions

This is the optional Linux/noVNC viewer fallback. Agent browser control now uses
[native cua_repl routing](native-browser.md). The legacy Playwright MCP and Mac
MCP are removed by provisioning. These viewer sessions remain available for
manual interaction and existing authentication helpers; they are not automatically
the same browser controlled by native CUA.

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

- Native desktop packages come from the distribution; the Playwright library and its
  compatible Chromium are pinned by `config/browser/package-lock.json`.
- A fully provisioned host checks installed packages, runtime identity, browser
  dependencies and owned configuration. It does not refresh apt indexes, fetch
  npm metadata, redownload Chromium, or restart healthy sessions.
- An installed browser module continues to converge on normal provisioning
  reruns, even without repeating `--with-browser`. `--skip mod_browser` skips it.
- Browser setup never runs `codex login`, `claude login`, `tailscale up`, or vault
  authentication. Existing CLI authentication and browser profiles are retained.
- Browser setup does not register agent MCPs. Normal provisioning runs
  `mod_native_browser` separately to migrate the old entries.

## Chromium sandbox on Ubuntu

Provisioning and `doctor` now launch a temporary blank browser to check sandbox
startup, rather than just checking that executable files exist. This does not
open or change task profiles. Healthy reruns perform the check without sudo or
policy changes.

Ubuntu's restricted user namespaces can reject downloaded Chromium with
`No usable sandbox`. If this occurs while the Ubuntu restriction is enabled,
provisioning installs a root-owned `/etc/apparmor.d/dev-tools-browser-<uid>`
profile granting `userns` to the exact resolved Chromium executable path, using
Chromium's documented `flags=(unconfined)` profile. It loads only that profile
and checks startup again. Sudo and `apparmor_parser` are required; unavailable
permissions or a continued failure are reported as a failed browser step.
Neither global namespace restrictions nor Chromium's sandbox are disabled.
The executable is user-owned, so this path exception also applies to a binary
that the same Linux user places at that exact path. It is not a boundary against
that user. Updating the managed Chromium version updates the owned profile when
needed; unrelated profiles are preserved.

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

For a reviewed tailnet, record the acknowledgement during installation and avoid
a separate publication step for future sessions:

```sh
curl -fsSL https://raw.githubusercontent.com/mojaveai/dev-tools/main/bootstrap.sh | sh -s -- --with-browser --viewer-policy-reviewed
```

The interactive installer requests sudo when host setup needs it. It handles
sandbox setup and Serve operator permissions, saves the review acknowledgement,
and future sessions automatically publish their viewer URLs. This flag records
your review; it does not change or validate tailnet ACLs. Existing machines retain
the acknowledgement on ordinary reruns.

To publish an existing session after review instead:

```sh
dev-tools browser publish my-task --policy-reviewed
dev-tools browser url my-task
```

The review acknowledgement is saved on this host, so subsequent sessions publish
automatically without another acknowledgement. It is **not** a policy engine:
this helper cannot infer or enforce your organization’s authorization policy.
Review again when that policy or the host's ownership changes.

Tailscale must be running with MagicDNS and HTTPS enabled, and the Linux user
must be authorized to manage Serve. Provisioning uses sudo to designate the
installing Linux user as Tailscale operator when none is set. A matching operator
is reused; another user's operator setting is preserved and reported for the
host owner to resolve. This grants that user Tailscale administration on this host,
including session route creation and cleanup. Serve failures include the daemon's
diagnostic.

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

Start viewer sessions explicitly with `dev-tools browser start NAME --json`.
Use the returned session ID for status, handoff and cleanup. Native `cua_repl`
uses its own tab/session lifecycle; do not infer a viewer session from its MCP
connection or attach multiple controllers to the same browser profile.

## Mac browser control

Use the [native SSH relay setup](native-browser.md). The old HTTPS Mac MCP,
`approve-mac` commands and `mcp-remote` proxy are retired.

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
the retained Playwright library, two native desktops, noVNC input, reconnects, persisted
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

## Human input handoff

The shared-browser skill directs the agent to give you its session URL and pause
when your input is needed. The agent runs:

```sh
dev-tools browser request-input my-task --message "Please sign in, then click Done" --json
dev-tools browser wait-input my-task --request-id REQUEST_ID --timeout 60 --json
```

Your open viewer automatically enables keyboard/mouse input and shows the request
with a **Done** button. Clicking Done records completion and returns viewers to
view-only. The agent checks that exact request ID before resuming. A timed-out
wait or disconnected viewer leaves the request pending; it does not imply you
finished. Reloading/reconnecting preserves a pending request. Completion from an
older request cannot complete a newer one. Other connected viewers see the same
state within about a second.

`input-status SESSION --json` reads the state. `cancel-input SESSION --request-id ID`
returns to view-only without recording human completion. Stopping the session
cancels pending input. Handoff messages should describe the task, never contain
credentials. Input toggling is a collaborative convenience; the skill tells the
agent to pause, but this does not forcibly block separate browser controllers.

Installer reruns update the integration and skill. Existing legacy viewers are
upgraded alongside their running desktop, preserving Chromium and tabs; refresh
an already-open viewer page to load the handoff controls. The old loopback viewer
remains until its desktop stops. The replacement follows the supervisor's lifetime
and is removed by normal session cleanup. No unattended background updater runs.
