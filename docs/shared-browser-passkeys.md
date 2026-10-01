# Shared browser passkey approval

Every dev-tools host's shared browser can complete WebAuthn sign-ins and
registrations for any HTTPS site with a passkey on the owner's Mac. Nothing is
installed on the websites, and no passkey material leaves the owner's device.

## How it works

1. The receiver (`shared_browser/server.mjs`) starts `auth-host.mjs`. It loads an
   unpacked extension into the host's Chrome that uses Chrome's
   [`webAuthenticationProxy`](https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy)
   API, and runs a loopback-only relay on `127.0.0.1:8811`. Chromium validates
   the caller origin and RP before proxying; cross-origin frames are refused.
2. The viewer lists the pending request with **Approve with passkey**. Its
   `/auth-companion/*` routes sit behind the viewer's Tailscale owner check.
3. The owner's **Dev Tools Auth** extension (Mac Chrome or Safari) verifies the
   request, navigates the same tab to the site's real origin, invokes the local
   passkey prompt there, returns the response through the same viewer, and goes
   back to the viewer. The site's own verifier decides whether sign-in succeeded.

## Trust

A fleet key (`~/.config/dev-tools/auth-fleet.key`, 0600) is generated on the
controller Mac and copied to every inventory host by `./bin/dev-tools apply`.
Hosts sign each request together with their viewer origin; the extension ignores
anything unsigned, so a look-alike viewer elsewhere on the tailnet cannot ask the
owner to approve a sign-in for its own browser. Completion and cancellation carry
HMAC proofs the relay checks. The relay also binds each response to the original
challenge, origin, operation and allowed credentials, and delivers it once.
Requests expire after two minutes. Rotating the key: delete it on the controller
and reapply, then reload the Mac extensions.

## Mac setup

`./bin/dev-tools apply` (or `python3 shared_browser/safari-auth/install-mac.py`)
builds both extensions from the fleet key:

- Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
  `~/.local/share/dev-tools-chrome-auth/extension`. After a rebuild, click **Reload**.
  Use Chrome for YubiKeys with Always-UV, which Safari does not support.
- Safari: Settings → Developer → **Allow unsigned extensions**, then **Add Temporary
  Extension…** → `~/.local/share/dev-tools-safari-auth/local/extension`. Grant it
  access to all websites. Safari may require re-enabling after a restart.

Only one approval runs at a time per browser; use the one where the site's
credential lives. The approving Mac must be able to load the site itself.

## Limits

The approval page must stay on the requesting origin; sites whose root redirects
to a different origin need the approval started again from that origin. Agent
Trace uses the same extension flow as other HTTPS sites. The older QA and
canonical portal passkey bridge services should be disabled; they override the
site's WebAuthn call before Chrome can send it through the general host extension.

The extension first tries a successful, script-free document at the site's
origin, then falls back to its root document. HTTP errors, redirects, downloads,
binary files, and no-content responses are not usable approval documents.
If injection fails after navigation, it retries the root once and reports any
remaining failure in the extension popup. A local PIN or touch prompt confirms
that handoff reached the authenticator; successful sign-in still requires a
credential registered with the requesting site and its server's verification.
