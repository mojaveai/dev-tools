# Existing passkey handoff: Agent Trace development portal

The discovered QA portal is https://procbox.agent-trace.ts.net:23581/.
It displays Manbir (Development QA), and is served by
`agent-trace-qa-identity-dashboard.service`. The original edge authenticates
peers with tailscaled whois and forwards to the pinned TLS backend on loopback
23582. The unrelated live-dev dashboard at port 3581 has a private CA and was
not selected. Remote shared Chrome reached 23581 with valid TLS and its existing
ACLs; no network grants or certificate exceptions were added.

## Mechanism

A separate user service, `dev-tools-portal-passkey.service`, connects to the
existing shared Chrome through its loopback DevTools endpoint. It intercepts
only navigator.credentials.get for the exact origin
https://procbox.agent-trace.ts.net:23581. Other origins and credential creation
are unaffected. The agent still clicks the normal Verify passkey button through
the shared-browser MCP, and the portal obtains its normal server challenge.

The bridge creates a single-use, two-minute handoff URL under
`/_shared-browser-passkey/` on the portal's own origin. The owner opens that URL
in their phone browser and chooses Unlock for the agent. WebAuthn executes there
using the existing portal passkey. The signed response retains the original RP ID,
challenge, origin, and credential ID, and is serialized back into the remote
portal's normal credential response interface (including its instanceof checks).
The original dashboard backend performs the cryptographic verification and
creates its ordinary reviewer session. The broker only checks structural binding,
origin, challenge, credential allow-list and UP/UV flags; it never claims that a
forwarded response is an authenticated session. Dashboard state must confirm it.

This is a same-origin helper integration, not standard Bluetooth hybrid transport
and not a generic solution for sites whose origin cannot host a helper. It needs
an edge route but leaves the dashboard application, passkey registration and
backend verifier unchanged. No new portal credential was created. Device-local
passkey private material stays in its authenticator/passkey provider.

## Deployment boundary

Code is in `~/.local/share/dev-tools-passkey-fixture` on procbox. The broker listens
on loopback 8797; its `/agent/state` endpoint exposes only pending handoff links to
local callers and is not routed through the edge. The only public helper prefix
is `/_shared-browser-passkey/` on the existing tailnet-only 23581 listener.

`portal-passkey-edge.py` imports the exact installed QA identity module, delegates
all normal requests to its original handler, and adds the helper prefix. The helper
uses the same host check and tailscale whois admission function, bounded bodies,
exact POST Origin checking in the broker, and random 192-bit request identifiers.
Existing TLS credentials and app backend pins remain in the original unit.

The pilot wrapper is installed at
`/usr/local/lib/dev-tools-shared-browser/portal-passkey-edge.py` and selected by
`/etc/systemd/system/agent-trace-qa-identity-dashboard.service.d/90-shared-browser-passkey.conf`.
The original unit is untouched. The drop-in pins the inspected Nix source and Python
environment; it must be removed or updated before upgrading the QA edge package.
This adapter is saved in dev-tools, not integrated into Agent Trace's Nix source.
An initial restart failed because DynamicUser could not traverse the private
/etc/agent-trace-qa directory to load the wrapper. Moving the non-secret wrapper
to the public code directory resolved this without changing private-directory
permissions. The edge is active and the dashboard JavaScript matches its pre-change
bytes exactly. Shared Chrome was not restarted.

No production dashboard or financial action is in scope. The owner authorized
viewing, authentication and navigation of the dev admin portal. Read-only sections
are the first post-login test. Changes affecting money, signing, accounts or access
need their own concrete task scope.

## Evidence and next step

`test/portal-passkey-live.mjs` uses a separate browser, disposable virtual passkey,
and local RP on 8798 with broker 8799. It verifies that an already enrolled key
signs on the original origin, that the serialized response passes portal-style
PublicKeyCredential/AuthenticatorAssertionResponse type checks, and that the
original verifier accepts the signature. It also verifies one-time delivery and
remote cancellation leaving the site locked. No virtual key was registered in
Agent Trace. The earlier passkey gate and file-transfer tests remain separate.

The live portal tab is 1d505df7. Trigger Verify passkey, then read
`http://127.0.0.1:8797/agent/state` on procbox for the human approval URL and matching
code. Show the URL to the user; the agent must not perform device verification.
Inspect the dashboard after approval before claiming authentication succeeded.

## Rollback

Remove only the new `90-shared-browser-passkey.conf` drop-in, then run
`sudo systemctl daemon-reload` and restart
`agent-trace-qa-identity-dashboard.service`. Disable/stop the user
`dev-tools-portal-passkey.service`. Reload the affected remote dashboard tab to
remove the in-page hook. Keep all original units, ACLs and TLS credentials.

## Phone picker hint correction

The first live portal request (Manbir Development QA) contained one allowed
credential marked `transports: ["usb"]`, hints `security-key, client-device`, and
required user verification. The user reported that Face ID was not offered.
The phone helper now removes transport hints and prefers `client-device` while
preserving the exact allowCredentials IDs, challenge, RP ID, extensions and user
verification requirement. This is client discovery/presentation only; it cannot
make a different credential pass the original verifier. The installed live-dev
registry on port 3581 also lists USB transport metadata for Manbir; that alone
does not establish which passkey the user has on their phone.

All 14 unit checks pass. The isolated handoff test now intentionally emits the
same USB/security-key hints for a registered platform key; phone selection works
and the original verifier accepts it. The real user's matching credential and
successful dashboard sign-in still need confirmation.
