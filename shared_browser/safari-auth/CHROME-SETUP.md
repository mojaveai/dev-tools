# Chrome approval client on macOS

Use local Chrome to approve requests from procbox with a YubiKey, Touch ID, or
another credential available in Chrome. The companion retains the same explicit
cryptoagent and Yubico origin allowlist as Safari. The target site must already
have the credential enrolled.

Build against the existing Mac companion pairing:

```sh
python3 shared_browser/safari-auth/build-chrome.py
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load
unpacked**, and select `~/.local/share/dev-tools-chrome-auth/extension`. This
folder contains a private relay capability: do not commit or distribute it.
No Chrome Web Store publication or restart of the shared browser is required.

Open or refresh `https://procbox.agent-trace.ts.net:8443/` in that Chrome profile.
When the remote site requests a passkey, click **Approve with passkey** in the
viewer. Chrome navigates the same tab to the real site, displays the approval
panel, and returns to the viewer after completion. Choose the security-key
option in Chrome's prompt and use the enrolled YubiKey. The extension popup
provides a separate-tab fallback.

The background worker uses callback-based asynchronous message responses for
Chrome compatibility. The tab binding is stored in extension storage so worker
suspension does not lose the pending approval. The local client does not request
`webAuthenticationProxy`; only the existing remote host extension intercepts
WebAuthn. Site code does not change.

Keep the Mac companion and SSH tunnel running. Safari and iPhone packages are
not rebuilt or reinstalled by this builder. After source changes, rebuild and
click **Reload** for the unpacked Chrome extension, then refresh the viewer.

Validation: automated origin/tab/request binding, same-tab return, Chrome callback
messaging, and build permissions checks. Installation and real YubiKey approval
must be confirmed in Chrome; passing automated tests alone does not establish
hardware authentication success.
