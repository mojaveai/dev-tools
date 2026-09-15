# Safari authentication companion: Mac pilot

## Parked development prototype

**Decision (2026-09-15): keep this as a development prototype and resume only
when broader authentication forwarding is needed.** The regular procbox admin
dashboard continues using its existing Agent Trace passkey adapter, including the
separate approval-window fallback. This prototype is not required for that flow,
does not change the dashboard's registered credentials or authentication policy,
and is not part of the default dev-tools installation or production deployment.

The isolated procbox test browser, Mac relay and SSH tunnel were stopped after
testing, and the temporary Safari extension was disabled. Source, tests and
reproduction instructions are retained below. Generated
capabilities and browser profiles are local test artifacts, not committed assets;
generate fresh pairing when resuming.

### Resume here

1. Read the successful Mac and Yubico results below and run the automated checks.
2. Use `pilot.mjs` for the disposable local fixture, then `yubico.mjs` and the
   isolated host extension to reproduce real remote-site authentication.
3. Before general rollout, implement durable device pairing, per-agent request
   routing, disconnect/restart recovery, navigation cancellation and explicit
   per-site access. Preserve signed client data and the original site's verifier.
4. Test interaction with the existing Agent Trace adapter before enabling the
   proxy in the regular browser; avoid two handlers competing for one request.
5. Validate iPhone Safari separately. The successful Mac tests do not establish
   mobile support or universal compatibility with other sites and credential options.

## Verified results

Status: local prototype. **Real Safari registration and authentication passed on
macOS on 2026-09-15**, using Safari 26.6.2. The user approved both requests and the
original test site verified the registration and authentication signature. No
credential provider or biometric method was inferred from the returned response.
Not installed on the production shared browser; iPhone remains untested.

**Yubico end-to-end test also passed on 2026-09-15:** an isolated Chrome 153
profile on procbox used the supported `chrome.webAuthenticationProxy` API. Safari
on the Mac approved the original requests at `https://demo.yubico.com`. Yubico's
unmodified demo reported registration completed for an Apple Passwords credential,
then a fresh physical-key registration reported **Device verified — YubiKey Bio /
YubiKey C Bio, FIDO Edition**. Subsequent sign-in with that key reached
**Authentication successful!** in procbox's original browser session. No cookies,
client-data rewrites or modifications to Yubico's JavaScript/verifier were used.

## What this tests

A separate disposable Chrome session calls WebAuthn. The pilot holds that call,
and the Safari extension opens a local approval tab at the original site's origin.
An explicit click invokes Safari's credential API from an isolated content script.
The response returns to Chrome's original call. The original test site checks the
cryptographic signature, challenge, origin, RP ID and user verification.

The relay delivering a response does **not** mean the site accepted it. Look for
`SIGNED IN — original site verified the Safari signature` in the test browser.

## Run on this Mac

From the repository root (shared_browser dependencies installed):

```sh
node shared_browser/safari-auth/pilot.mjs
```

The process starts loopback services on ports 8811 and 8812, opens a disposable
Chrome profile, and generates the extension in `safari-auth/local/extension`.
This ignored directory contains a short-lived local relay capability. Never
commit or distribute it. No passkey private key is handled by dev-tools.

In Safari Settings > Developer, enable **Allow unsigned extensions**, then
**Add Temporary Extension…** and select the generated extension directory. Enable
the extension and grant it access to localhost for the test. No other sites are
requested. Temporary loading is available on the tested Safari 26.6.2 installation;
older versions may require Xcode packaging.

1. In the disposable Chrome window, click **Create test passkey**.
2. Open the **Dev Tools Auth** Safari toolbar popup and select the pending request.
3. In the approval tab, click **Continue with passkey** and complete your provider's
   prompt yourself. This creates a disposable credential named `dev-tools-mac-test`.
4. Confirm Chrome says registration was verified.
5. Click **Sign in with test passkey** in Chrome and repeat the Safari approval.
6. Confirm Chrome says **SIGNED IN** and the terminal reports verified authentication.

Each request expires after two minutes. Closing the assigned Safari tab cancels
the request. The test browser's Cancel button or navigation also cancels it.
Stop the pilot with Ctrl-C. Disable/remove the temporary extension after testing;
remove the disposable localhost credential from your provider if desired. Restarting
the pilot creates a new relay capability, so reload the generated extension.
For a development restart with the already-loaded extension, use
`AUTH_REUSE_PAIRING=1 node shared_browser/safari-auth/pilot.mjs`; it reuses only
the local generated capability. `AUTH_TEST_HEADLESS=1` keeps the disposable test
Chrome hidden. `AUTH_TEST_DIAGNOSTICS=1` logs relay paths and origins without
authorization headers or credential responses.

## Automated verification

```sh
node --test shared_browser/safari-auth/test/*.test.mjs
# While pilot.mjs is running; uses disposable simulated keys, not your provider:
node shared_browser/safari-auth/test/live.mjs
```

The live test replaces the fixture's in-memory credential. Run the human
registration step again afterward. Tests cover original-site registration and
signature verification, replay rejection, cancellation, pairing capability checks,
and extension message binding to the assigned top-level tab and request.

## Yubico test wiring

`yubico.mjs` replaces the local fixture relay on port 8811 and generates a Safari
build with access limited to localhost and `demo.yubico.com`. Stop `pilot.mjs`
before starting it. It reuses the already-paired local Safari capability and
generates a separate capability for the host extension. Reload the temporary
Safari extension and allow Yubico demo access.

The isolated procbox test directory is
`~/.local/state/dev-tools/safari-auth-test`. Copy generated `local/host-extension`
and `launch-host.mjs` there, with `node_modules` pointing to the installed shared
browser dependencies. The launch script starts a separate headless Chrome profile;
it must **not** be pointed at the active shared browser profile. A loopback-only
SSH reverse forward connects procbox's port 8811 to the Mac relay:

```sh
ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:8811:127.0.0.1:8811 procbox
```

`launch-host.mjs` uses Chrome's native authentication proxy extension API, preserving
real credential interfaces in the original page. Chromium supplies the validated
caller origin in `remoteDesktopClientOverride`; `host-options.mjs` checks the exact
demo origin and same-origin ancestry, then removes that transport extension because
Safari is already running at the actual site origin. The relay binds the resulting
response to the original challenge and operation. Yubico verifies the signature.

For physical YubiKey registration, choose **More Options → Security Key** in the
Safari passkey prompt, then use the key's touch/biometric/PIN flow. Choosing Apple
Passwords creates a different credential and is also valid; it does not enroll
the physical key. Always use the companion's assigned approval tab, since manually
starting a login in a local Yubico tab creates a separate local session.

## Scope and next gate

The basic fixture build requests only localhost access; the Yubico test build adds
only the demo origin. It has no cookies,
history, downloads, native messaging, or all-sites permissions. The local capability
is test pairing only; production needs durable authenticated device pairing.

The fixture-only Chrome shim returns a minimal credential interface to its controlled
test page. The Yubico test instead uses supported host interception. Both remain
single-request prototypes: production integration needs durable device pairing,
per-session routing, disconnect behavior, diagnostics and approved origin handling.

Safari content-script WebAuthn execution context and user activation passed the
Mac experiment: the isolated content script produced responses accepted for the
actual localhost origin. No main-world injection, origin rewriting, cookie copying,
cross-origin restriction changes, or native Apple browser entitlement was needed.
The initial permission/startup transition produced a transient load error; once
localhost access was granted and the extension started, background fetches worked
without adding CORS exceptions. Temporary extension reload changes its origin UUID.
Yubico HTTPS is now proven. Other sites, redirects, credential extensions,
cross-origin frames and iPhone behavior still require separate validation.
