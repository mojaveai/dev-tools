# Canonical actual-dev passkey adapter

This adapter preserves `https://procbox.agent-trace.ts.net:3581` as the WebAuthn
origin and RP hostname. It proxies the actual dashboard on `127.0.0.1:3581`.
QA `23581`/`23582` and its bridge `8797` remain separate. Canonical bridge
`8798` uses distinct page function names so both bridges can attach safely.
No challenge, credential, authenticator flags, or signed client data are rewritten.
The original dashboard remains responsible for cryptographic verification.

The ingress uses the existing `/etc/agent-trace-qa/procbox.crt` and `.key` through
systemd credentials. Normal client CA/hostname/expiry verification remains in
force. The observed ingress fingerprint is release evidence, not a permanent
renewal prohibition. Backend connections use their existing CA, IP hostname
verification, and immutable `47a89c…43894b` leaf pin. Every request requires the
exact canonical Host and an admitted Tailscale user identity. The public config
contains only the reviewed numeric user allowlist.

## Build and integration

From a clean reviewed, signed dev-tools commit, on procbox Linux:

```
python3 shared_browser/build-canonical-adapter.py \
  --output /private/fresh-bundle \
  --python /reviewed/absolute/python3 --node /reviewed/absolute/node \
  --allowed-tailnet-user-id REVIEWED_NUMERIC_ID \
  --ingress-certificate-sha256 OBSERVED_PUBLIC_LEAF_SHA256
```

The builder runs the locked npm dependency build and embeds all bridge npm
modules in one ESM file. Its CommonJS compatibility loader permits only Node
builtins, never external or user-home modules. `--check-bundle` proves imports
and helper assets load without binding sockets or attaching Chrome. `manifest.json`
pins every generated payload, config, and rendered unit. No key enters the bundle.
Record the signed source commit and generated manifest hash in agent_trace's
tracked expected manifest. Stage the verified bundle root-owned/no-clobber at
`/data/agent-trace-live-dev/adapter-cache/<source_sha>/` using existing reviewed
transport. The agent_trace lifecycle-locked installer validates it before app
mutation; no service downloads arbitrary source at runtime.

Installed layout:

* `/usr/local/lib/dev-tools-shared-browser/canonical/<source_sha>/` (no symlink)
* `/etc/agent-trace/dev-canonical-passkey.json`, matching bundle `config.json`
* `dev-tools-canonical-dashboard-edge.service`
* `dev-tools-canonical-passkey.service`

Directories are root-owned `0555`, payloads `0444`; interpreter identity and
loaded unit/config/process bindings are checked by app assurance. After the app
has moved its bind to loopback, start the edge and bridge. Before rollback to an
older public-bind app, stop both canonical units first under the same lifecycle
lock, then reconcile the old app. Never change the QA services for this transition.

The bridge reads only the fixed primary browser descriptor; every reconnect
checks path ownership, no symlinks, no writable-by-group/other components, and
loopback endpoint. There is no legacy fallback. Chrome can restart normally;
its ephemeral websocket is not a release artifact or financial authority.

The existing shared-browser viewer also requires the narrow `server.mjs` feed
and CSP changes and `viewer-passkeys.js` canonical URL change. Apply those through
its supported deployment while preserving current user changes. They are outside
the adapter manifest; do not claim that manifest attests the viewer. Qualification
must exercise the canonical helper in the existing viewer and complete a real
user passkey before declaring manual login healthy.

## Focused checks and limits

```
python3 shared_browser/test/canonical-edge_test.py
node --test shared_browser/test/portal-passkey-profile.test.mjs \
  shared_browser/test/portal-passkey-origin.test.mjs
```

Tests cover exact Host/tailnet admission, request framing, original body/Origin
and duplicate cookies, backend pin rejection, and independent canonical/QA
namespaces. Bundle import validation makes no network connection. These tests do
not substitute for deployed public TLS verification and actual user WebAuthn.
App bodies stream in at most 64 KiB chunks; requests retain the app maximum of
256 MiB and responses have no smaller edge size limit. Helper responses remain
bounded to 500 KiB. WebSockets are not supported. Logs deliberately omit request URLs,
assertions, cookies, and exception bodies.
