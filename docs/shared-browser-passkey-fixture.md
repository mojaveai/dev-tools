# Passkey approval test fixture

This fixture mimics an agent browsing a site that needs the owner's passkey
approval before sign-in. It deliberately modifies the test relying party to
support delegated approval. It does not intercept an unchanged website's
navigator.credentials calls, forward existing website credentials, or create an
approval-gated software authenticator for a third-party site.

## Live test

- Shared remote site: http://127.0.0.1:8795/fixture (open through the agent's MCP).
- Phone setup and approval: https://procbox.agent-trace.ts.net:8443/passkey/
- Service: user systemd `dev-tools-passkey-fixture.service` on procbox.
- Code: `~/.local/share/dev-tools-passkey-fixture/`.
- State: `~/.local/state/dev-tools/passkey-fixture/credential.json` (public key,
  credential ID, transports and counter only; no authenticator private key).

First, the user opens the approval URL in their own iPhone browser and taps
Create demo passkey. The agent does not operate enrollment or the device's
verification prompt. This registers a new test passkey for procbox.agent-trace.ts.net.
Only one credential is accepted; the API cannot add or replace it after enrollment.
Device verification is required, but the server cannot insist on Face ID specifically
or distinguish it from an allowed device passcode fallback.

After the user reports ready, the agent clicks Request sign-in approval in the
remote site. The user compares the eight-character code on both pages, taps
Approve with passkey and completes device verification. The server verifies the
WebAuthn assertion and the remote page changes to Signed in as Demo Owner. The
agent can then click Open project report. This is a synthetic report, not a real
account or financial action.

Next try Deny request, dismissing the device prompt, waiting two minutes, refreshing
the approval page, and disconnecting the shared viewer while the agent waits.
Each new request has a fresh ID and challenge. No request should unlock the report
without verified approval. Opening or ignoring an approval link never authenticates.

## Verification and scope

SimpleWebAuthn server 14.0.2 and browser 14.0.0 handle credential serialization and
cryptographic registration/assertion verification. Expected origin includes port
8443; RP ID is the exact procbox hostname. Both registration and authentication
require user verification. Approval challenges are bound to a request and approval
browser cookie; requests are bound to an independent remote website session.
Challenges are consumed on a verification attempt. Approved requests can be
consumed once, by their originating site session, before expiry.

The phone API requires the existing owner Tailscale identity and exact POST Origin.
It is not publicly exposed. The site uses a separate HttpOnly session cookie and
a server-enforced protected report endpoint; disabling the button is not its
security check. POST verification is serialized, and the credential counter is
saved before approval becomes visible. Pending requests and authenticated demo
sessions live only in memory; service restart signs them out and discards requests.
The registered public credential persists. Passkey material on the phone stays
there (or in its passkey provider), not on the remote server.

This is not a security boundary against an administrator or compromised process
on procbox: that host runs the fixture and can modify its code, credential database,
and trusted loopback proxy headers. It is a test of a real WebAuthn approval flow,
not a claim of production signing isolation or hardware attestation. No Agent Trace
credential policy or existing website passkeys were changed.

## Installation and rollback

Copy `shared_browser/` to its separate code directory and run
`sh install-passkey-fixture.sh`. Node 22+ is required; procbox uses
`/usr/local/bin/node` (24), not `/usr/bin/node` (18).
After checking existing routes, add only the path proxy:

```sh
sudo tailscale serve --bg --https=8443 --set-path=/passkey --yes http://127.0.0.1:8795
```

The original `/` browser proxy and all 443 routes remain intact. No new ACL grant
is needed; the existing owner-only 8443 grant applies. To stop the fixture:

```sh
sudo tailscale serve --https=8443 --set-path=/passkey off
systemctl --user disable --now dev-tools-passkey-fixture.service
```

Do not turn off the entire 8443 listener when removing this fixture. Keep the
registered credential state unless the owner intentionally wants to reset setup.

## Automated evidence

`npm test` passes 13 checks, including gate expiry/cancellation, browser/device
binding, one-time consumption, and inability to replace an enrolled credential.
`test/passkey-live.mjs` passes 10 checks against a separate loopback QA service
on port 8796 with a disposable state directory and a Chrome virtual authenticator:
registration, enrollment replacement denial, locked report before approval,
invalid signature, wrong origin, missing user verification, cancellation,
cross-request/session binding and replay, API access control, and the actual
approval-page button triggering WebAuthn and unlocking the site.

Virtual credentials exist only in QA. The deployed phone fixture starts without
a registered credential. Its setup page was verified in actual Mac Chrome but
human iPhone enrollment/Face ID and live scenario acceptance remain pending.
