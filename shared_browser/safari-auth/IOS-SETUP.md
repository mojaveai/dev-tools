# iPhone Safari extension development

The extension runs in iPhone Safari. Apple requires an iOS containing app to install
it; the containing app is not a replacement browser. Reuse the same-tab approval
flow from the Mac extension. The generated iOS archive contains no pairing keys.

## Network and pairing

The iPhone must reach both URLs over the Agent Trace tailnet:

- `https://procbox.agent-trace.ts.net:8443/`
- `https://cryptoagent-1-1.agent-trace.ts.net:3581/`

The Mac's `/etc/hosts` SSH-forward workaround does not transfer to iPhone. Do not
rewrite the dashboard hostname or disable TLS to work around phone reachability.
The iPhone extension uses `https://procbox.agent-trace.ts.net:8443/auth-companion`.
The viewer's existing Tailscale owner check runs first, then the relay requires a
separate pairing capability. Only GET `/pending` and POST `/complete`, `/cancel`
are forwarded; Chrome host APIs are inaccessible through this proxy.

For this prototype the relay still runs on the Mac, through the existing SSH
reverse tunnel. The Mac must remain awake and connected. This is not yet an
independent always-on phone deployment.

After running `install-mac.py`, the separate mobile key is stored in
`~/.local/share/dev-tools-safari-auth/local/mobile-token` with mode 0600. Transfer
it privately to the owner phone and paste it into **Dev Tools Auth → Pair this
iPhone**. Never put it in an IPA/ZIP, commit, URL, screenshot, or log. Pairing is
accepted only from the extension popup and saved in extension-local storage.
The key can complete/cancel pending requests but cannot create host requests.
To revoke, replace that mobile-token file with a new random 32-byte hex value and
restart the Mac companion; re-pair the intended device. This prototype pairs one
mobile capability, not a fleet of independently managed devices.

## Build

```sh
python3 shared_browser/safari-auth/build-ios.py
```

Produces `local/ios/Dev-Tools-Auth-iOS.zip` for Apple's web extension packager.
For an Xcode project, install full Xcode and select its developer directory, then:

```sh
python3 shared_browser/safari-auth/build-ios.py --xcode
```

Uses Apple's `safari-web-extension-packager` (or its older converter name), with
an iOS-only Swift containing app and copied extension resources. Generated files
stay under ignored `local/`. The default bundle ID is `com.mojaveai.devtools.auth`;
use an identifier available to the signing team when preparing distribution.
Select the Apple development team for both app and extension, connect/trust the
iPhone, enable Developer Mode if requested, and build/run to that device. Device
trust, Apple login, and biometric approvals are performed by the owner.
TestFlight distribution instead requires the appropriate Apple Developer/App
Store Connect access. An extension ZIP alone cannot be installed in iPhone Safari.

Apple: [Packaging a web extension](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari).

## Device test

1. Install the containing app, enable Dev Tools Auth under Safari extensions,
   and allow access to procbox and cryptoagent dashboard hosts.
2. Pair from the extension popup. Verify both real HTTPS origins load on the phone.
3. Start an authentication request from the procbox shared browser.
4. Tap **Approve with passkey** in the phone viewer. The same tab should redirect
   to the real dashboard and show Face ID; Continue is available if a gesture is needed.
5. Approve with a passkey registered for this RP and available on this phone.
   Face ID unlocks a credential; it does not create an enrollment automatically.
6. Confirm automatic return to the viewer and server-accepted remote sign-in.
7. Check cancel/expiry and that an unpaired device cannot fetch pending requests.

## Current validation

- 16 automated relay/extension/proxy tests passed.
- Procbox HTTPS proxy returned 403 without pairing and 200 with mobile pairing.
- Shared Chrome stayed on its original PID during receiver deployment.
- Xcode 27 installed and its packager generated the iOS app/extension. The unsigned
  device build passes. The generator fixes the packager's app/extension bundle-ID
  mismatch before compilation.
- Connected iPhone 15 Pro Max (iOS 26.7) is paired with this Mac and on Agent Trace.
  The owner enabled Developer Mode and configured an Apple Personal Team.
- Both native targets built successfully with development signing after the owner
  allowed codesign access to the Apple Development key. `devicectl` confirmed the
  containing app was installed on the physical iPhone.
- Safari extension enablement, private device pairing, and the live Face ID test
  remain pending; installation alone does not verify authentication.

## Disposable Yubico demo test

Use the same explicit site on the relay and iPhone build:

```sh
python3 shared_browser/safari-auth/install-mac.py --site https://demo.yubico.com
python3 shared_browser/safari-auth/build-ios.py --site https://demo.yubico.com
```

Copy the generated `local/ios/extension/` resources into an existing Xcode
project's extension Resources directory before building and reinstalling. Preserve
its signing settings and bundle ID so the device pairing survives an app update.
Allow the updated extension access to `demo.yubico.com` in iPhone Safari. Register
a disposable passkey from the remote demo, approve creation on the phone, then
perform a separate authentication and confirm the remote demo accepts it.
Both commands default to cryptoagent when `--site` is omitted; use the same site
for both when restoring the dashboard prototype. The relay accepts one site at
a time. No dashboard enrollment is changed by a demo test.

On this test iPhone the owner trusted the developer profile, opened the containing
app, and enabled the extension after temporarily lifting their own Screen Time
restriction. The owner confirmed mobile pairing succeeded. The Yubico demo subsequently accepted both registration and authentication from
the iPhone extension: remote Chrome displayed “Authentication successful!” and
the relay logged delivery for both operations. This used the popup fallback,
which required returning manually. The viewer had filtered out Yubico requests;
the allowlist now includes the demo, with a regression test. After refreshing the deployed viewer, the owner confirmed the approval button
appeared and the full Face ID flow stayed in one tab with automatic return.
Remote Chrome showed “Authentication successful!” and the relay confirmed delivery
for request `3a42524f`. This verifies the iPhone same-tab sign-in flow end to end.
The current test deployment remains scoped to Yubico; restoring cryptoagent
requires matching relay/build configuration and a credential available on the phone.
