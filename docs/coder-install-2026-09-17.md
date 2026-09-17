# Coder installation repair, September 17, 2026

Target: `coder@ws-bolde-workspace-large.asg.ts.net` (local SSH alias `coder`).
The Coder CLI proxy could not read its Mac keychain session; the VS Code session
was expired. Direct Tailscale SSH worked and is now used by that alias.

## Findings

- The pod runs the Coder agent as PID 1, without a user systemd manager. The old
  default installed a `cua_repl` router despite having no usable desktop runtime.
  The shared runtime was a separate, systemd-only installation.
- The pod already had a ChatGPT login. Its `bolde_medium` model provider sets
  `requires_openai_auth=false`, making `account/read` return null. Device login
  could succeed yet the installer would still report absent credentials.
- Chromium's sandbox probe passed; its sandbox did not need disabling.

## Changes

The default provisioner installs shared browser, its prerequisites, MCP
registration, and the private viewer. It uses private Supervisor services in
containers and user systemd on conventional hosts. Services have bounded,
rotated logs; startup is verified through browser RPC. Existing port-8443 routes
are checked before publication. Registration repair also runs in containers.
Chrome remains separate from the receiver so receiver updates preserve live tabs.

The Codex account probe selects the OpenAI provider only in its disposable
app-server. Saved model routing is unchanged. An ambiguous HTTP 401 can trigger
a refresh check but cannot by itself trigger a fresh login.

The installed pod detected its existing account and passed online verification
without a new login. Shared-browser MCP initialization, tool listing, state
retrieval, and HTTPS viewer reachability passed. See the tests for regression
coverage of auth, safe listener publication, and service update behavior.

A live installer rerun preserved Chrome's endpoint and unsaved input in a
temporary test tab. The isolated Supervisor integration test also recovered
stopped services with a stale socket through the first production RPC call.
Targeted validation passed: 9 auth, 9 shared installer/configuration, 16 native
router, and 49 JavaScript unit tests. The monolithic Python discovery command
on macOS encounters existing Linux `/proc` assumptions and collisions between
the legacy modules named `configure`; targeted suites run in separate processes.
