# Face ID approvals for remote websites: feasibility research

Research date: 2026-09-15. This is an implementation proposal, not a deployed
capability. The agent's browser remains on procbox. Existing Agent Trace inline
approval is site-specific and does not establish arbitrary-site support.

Mac experiment update: the local Safari companion in
[`shared_browser/safari-auth`](../shared_browser/safari-auth/README.md) successfully
forwarded real registration and authentication responses from Safari 26.6.2 to a
separate disposable Chrome session. The original localhost verifier accepted both.
Isolated content-script WebAuthn worked with explicit user approval. A subsequent
test used Chrome's supported authentication proxy API in an isolated procbox
profile with Yubico's unmodified HTTPS demo. Safari forwarded registration and
authentication using the user's physical YubiKey; the remote demo reported
**Device verified** and **Authentication successful!**. This proves the mechanism
on that real site. Durable device pairing, integration into the active shared
browser, additional sites and iPhone remain unvalidated.

## What needs to move

Face ID stays on the phone. It authorizes use of a passkey; the biometric is never
sent to procbox. The remote browser needs the resulting WebAuthn credential
response for its original website, challenge, and browser session.

The two independent pieces are:

1. Capture registration/authentication requests in remote Chrome, preserving the
   trusted caller origin, RP ID, options, cancellation and request identity.
2. On the user's device, obtain a response using a credential enrolled for that
   RP, with the correct client-data origin, and return it to the same request.

Chrome has a supported host-side API for this purpose:
[`chrome.webAuthenticationProxy`](https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy).
It supports create/get requests, completion, cancellation, and platform
availability queries. Its existence establishes the interception mechanism, not
that an arbitrary Safari webpage can act as the local authenticator client.

## Option A: native iOS remote-browser client using existing passkeys

Apple documents browser APIs that can request system/provider passkeys with
explicit WebAuthn client data:

- `ASAuthorizationWebBrowserPublicKeyCredentialManager`
- `ASPublicKeyCredentialClientData(challenge:origin:)`
- `createCredentialAssertionRequest(clientData:)`
- `ASAuthorizationController`

[Apple's browser authentication guide](https://developer.apple.com/documentation/authenticationservices/authenticating-people-by-using-passkeys-in-browser-apps)
describes keychain and third-party-provider credentials and the system approval
UI. The installed Apple SDK marks the relevant platform browser APIs available
on iOS 17.4 and newer.

Crucially, [the browser passkey entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential)
is a managed capability. Apple requires an eligible browser application and an
organization account holder to request it. The published application form is
macOS-labelled, despite the APIs also being available on iOS. Acceptance of an
iOS remote-browser client needs explicit verification; a simple helper or WKWebView
wrapper cannot be assumed to qualify.

Proposed UX: our app shows the remote viewer, names the real requesting site,
asks for approval, presents the system passkey sheet, and returns the assertion.
Only the approval happens locally; the agent still controls Chrome on procbox.
This is a promising architecture, not proof of entitlement approval or compatibility
with every site's extensions, attestation policy, or credential provider.

## Option B: Safari web extension with a temporary approval tab

Proposed lower-friction prototype for existing passkeys:

1. Remote Chrome captures the pending request.
2. A paired Safari extension opens a local top-level tab on the *actual caller
   origin*, e.g. `https://demo.yubico.com`.
3. With explicit website access, it provides an approval control that invokes
   WebAuthn for the remote challenge in that site's context.
4. The owner approves with their existing provider/Face ID; the extension returns
   the result through the authenticated relay and returns to the viewer.

[Safari web extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions)
are available on iOS and macOS and require an app package for installation.
Apple also documents [script injection and site permissions](https://developer.apple.com/documentation/safariservices/injecting-a-script-into-a-webpage).
Those are building blocks, not documentation of this complete forwarding flow.

Unproven points: credential API behavior in the selected execution world, Safari
user-activation requirements, site redirects/CSP, interference from the site's own
passkey prompt, extension suspension, and reliable return to the viewer. Test these
on physical iPhone Safari before building a general relay. A browser-extension
popup at the extension's own origin does not solve the RP-origin restriction.
No site cookies or account session would be copied to procbox: the response must
complete the remote browser's original pending request.

## Option C: our own Face ID-protected authenticator app

If separately enrolled passkeys are acceptable, a companion app can own per-site
signing keys and implement the authenticator side. Apple exposes
[Secure Enclave signing keys](https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing/privatekey)
and [biometric key access controls](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset).

This would require a correct WebAuthn authenticator implementation: registration,
credential storage/discovery, RP binding, authenticator data, counters/backup flags,
user verification and signing. These APIs provide primitives, not a complete FIDO
authenticator. A Face ID dialog alone is not a website authentication response.
It cannot use existing Apple Passwords keys, requires new registrations, and may
not satisfy sites requiring a particular attested/certified authenticator.
Device-bound Secure Enclave keys also require a deliberate recovery strategy.
This is a larger security-sensitive product, not the preferred first prototype.

## Option D: managed Chromium viewer

Chromium has a [remote-desktop origin policy](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/policy/resources/templates/policy_definitions/Miscellaneous/WebAuthenticationRemoteDesktopAllowedOrigins.yaml)
and a privileged `remoteDesktopClientOverride` WebAuthn extension. This can allow
a specifically trusted viewer origin to request another RP's credentials.
The policy has management/affiliation constraints and does not apply to Safari.
It is useful for a Mac proof of concept while retaining the actual browsing
session on procbox, but is not an iPhone-Safari solution.

The newer [`remoteClientDataJSON` proposal](https://github.com/MicrosoftEdge/MSEdgeExplainers/blob/main/WebAuthnRemoteClientDataJSON/explainer.md)
addresses complete signed-client-data forwarding. Proposal/spec work should not
be treated as shipped interoperable Safari support.

## Why VPNs and a remote QR code do not fix this

A VPN changes network routing, not the local browser origin or credential access.
Ordinary cross-device passkey authentication also verifies physical proximity
using Bluetooth, so a QR code from a distant procbox is not a general solution.
See [FIDO's cross-device authentication explanation](https://fidoalliance.org/passkeys/).
A nearby Mac could participate in a deliberately implemented local forwarding
client; that is a separate design from simply relaying a QR image.

## Recommended next experiment

For existing passkeys, prototype Option B against Yubico's demo while separately
confirming eligibility for Option A. The experiment must prove all of:

- Registration and subsequent authentication with a real iPhone passkey.
- The unmodified demo verifier accepts the response in remote Chrome's session.
- The local operation authenticates the remote challenge, not a separate local
  sign-in session; no cookie copying or origin rewriting.
- Actual top-level/frame origin and RP validation originate in the trusted remote
  browser, not arbitrary agent-supplied strings.
- A visible real-site approval, authenticated device pairing, request/session
  binding, short expiry, explicit cancellation and one-time completion.
- Rejection of substituted domains/challenges, reuse, canceled requests, and a
  response delivered to another agent's request.

If Safari blocks this route, decide between entitlement-backed native support
and separately registered companion-app credentials. Do not expand the current
Agent Trace helper's origin allowlist as a substitute for a genuine client.
