# Opt-in Mac companion for the cryptoagent dashboard

Target: `https://cryptoagent-1-1.agent-trace.ts.net:3581/`, viewed through the
regular procbox shared browser. This uses the extension path and does not install
anything on cryptoagent or change its credential verification or authentication
policy. The old procbox QA adapter on port 23581 remains available independently.

## Components

- Mac: `python3 shared_browser/safari-auth/install-mac.py` copies the companion to
  `~/.local/share/dev-tools-safari-auth`, generates private local pairing, and
  installs two user LaunchAgents: `com.dev-tools.auth-companion` and
  `com.dev-tools.auth-tunnel`. They start at login and restart on failure.
- Safari: load `~/.local/share/dev-tools-safari-auth/local/extension` as a temporary
  extension and enable it. Grant access to localhost and the exact dashboard host.
  The old `Dev Tools Auth — Mac Test` build can remain disabled.
- Procbox: generated `local/host-extension` and `load-host.mjs` live in
  `~/.local/state/dev-tools/safari-auth-test`, with its `node_modules` symlink to
  the shared-browser runtime. `dev-tools-auth-host.service` loads this extension
  when the native Chrome endpoint changes. Chrome 153 accepted the unpacked
  extension in the already-running browser without restarting it.
- Viewer: the existing passkey feed now includes the companion's public request
  metadata and shows a notice directing the owner to Safari's toolbar extension.

The host and Safari use different pairing capabilities. No private passkey material
is copied. Generated configuration must stay out of git; rotate it and recopy the
host extension if local pairing is reset. Restart/reload both extensions afterward.

## Network path on this Mac

The Mac is not directly connected to this dashboard's Agent Trace tailnet route.
The managed SSH connection to procbox provides two loopback-only forwards:

- Mac `127.0.0.1:3581` → cryptoagent's HTTPS dashboard, through procbox.
- Procbox `127.0.0.1:8811` → Mac authentication relay.

Safari must still visit the real dashboard origin. On this Mac only, add
`127.0.0.1 cryptoagent-1-1.agent-trace.ts.net` to `/etc/hosts` with administrator
authorization. TLS passes through unchanged: certificate validation and RP/origin
checks are preserved. The forward was verified with normal certificate validation
and HTTP 200. If using direct Agent Trace tailnet access instead, remove this local
hostname override and use the real route.

## Use and verification

Click **Verify with YubiKey** in the remote dashboard. The viewer displays
the request code and **Approve with passkey** when Dev Tools Auth has permission
on the viewer. Click it, then **Continue with passkey** in the real-origin tab.
Safari opens its native prompt. After delivery the extension closes only its
approval tab and returns to the initiating viewer, where the site's actual result
is visible. The toolbar request list remains a fallback. Select **Security Key**
when needed. The YubiKey must
already be registered for this dashboard's RP; old-host and Yubico demo credentials
are not interchangeable. Only the dashboard's successful authenticated state
establishes sign-in, not the companion's delivery message.

Live Mac check (2026-09-15): the hostname override and managed tunnel returned
HTTP 200 with normal TLS verification, Safari loaded the real dashboard, and a
request from the regular procbox browser appeared in Dev Tools Auth. Safari then
invoked the security key for the exact dashboard hostname. The tested key returned
**No Credentials Found**. Transport and prompt delivery are verified; successful
dashboard authentication remains unverified until a matching enrolled credential
is used. The relay's 10 automated tests and shared-viewer build passed.

Follow-up: the owner confirmed this key signs in successfully in Chrome but fails
even when visiting the dashboard directly in Safari. The live dashboard requests
one USB credential for `manbir`, with the correct RP ID and user verification
required. Read-only `ykman fido info` reports **Always Require UV: On**; PIN and
fingerprint retries remain available. Yubico's [browser support matrix](https://developers.yubico.com/Developer_Program/WebAuthn_Starter_Kit/Browser_Support_Matrix.html)
lists AlwaysUV as supported by Chrome on macOS and unsupported by Safari. This
is a likely browser/key compatibility issue, not evidence that enrollment is
missing. Do not reset or reenroll the key, or disable AlwaysUV, to troubleshoot
the companion. A local Chrome approval companion is the next implementation
option; the Safari prototype cannot bypass Apple's authenticator implementation.

The owner subsequently enrolled an Apple passkey and the remote dashboard accepted
it through this companion. Do not infer current credential policy solely from the
older YubiKey-only UI wording or source checkout.

Version 0.3 live verification: viewer button opened the exact-origin approval tab,
Touch ID completed remote sign-in, and the approval tab closed automatically with
the original viewer selected. Automatic authentication on tab load was blocked
while Safari focused its address field, so the explicit Continue button remains.
A short focus wait fixed the first-click `document is not focused` error; the first
Continue click then opened Touch ID. Twelve tests cover request binding, exact
viewer origin/top-frame checks, synthetic-click rejection and return-tab behavior.

An embedded native WKWebView is not part of this implementation. Apple's
[passkey guidance](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys)
requires associated-domain configuration for ordinary app webviews; entitled
browser apps have a separate path. The Safari extension retains real-origin tabs
without requiring website changes. iPhone packaging and relay routing remain
future work.

This remains an opt-in development extension, not a signed Safari App Store build.
Safari may require unsigned extensions to be reenabled after restart. It requires
this Mac and its relay to be online. iPhone is not configured. Up to 16 independent
requests may queue; Safari presents one approval tab at a time. Host cancellation,
short expiry, response origin/challenge binding and one-time delivery are enforced.
Loss of the relay fails authentication; it does not bypass site checks.

## Disable / rollback

Disable the Safari extension. Stop the two Mac LaunchAgents with `launchctl bootout
gui/$(id -u)/com.dev-tools.auth-companion` and the corresponding
`com.dev-tools.auth-tunnel` label. Disable `dev-tools-auth-host.service` on procbox
and uninstall its extension ID with Chrome's Extensions API to detach the active
proxy without restarting Chrome. Remove the exact localhost mapping from
`/etc/hosts` if it was added. The original QA dashboard adapter remains separate.
