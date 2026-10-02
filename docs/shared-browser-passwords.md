# Saved passwords in the shared browser

The shared browser's reconstructed DOM belongs to the viewer URL. Local password
managers therefore match the viewer host, rather than the remote site's address.
The password bridge uses the existing paired Dev Tools Auth extension to open a
native autofill form at the remote site's real HTTPS origin.

In Chrome, install and unlock Proton Pass (or the appropriate password-provider
extension). When a password field is visible, click **Fill saved password** in
the viewer. The same action is also available in its toolbar. Choose the saved
login in the local form. Proton Pass selection fills and returns automatically;
manual entry also supports Enter or **Fill and return**. The extension
fills the original remote sign-in fields and returns to the viewer automatically.
It leaves submission to the website's normal sign-in control.

The host signs the site, viewer, request identity, operation, field roles and
expiry using the existing fleet pairing key. Credentials are sent only after
the user chooses a password-manager entry or explicitly completes the helper; the completion proof covers their exact
payload. They are not saved in extension storage, request metadata, or logs.
The remote page URL, selected tab, document generation, original input nodes,
field attributes and form action are checked before either field is filled.
Requests expire after two minutes and are consumed once. An uncertain delivery
is never retried automatically. Remote password inputs remain masked in the DOM
replay by the existing recorder.

The helper requires a successful plain-text document at `/robots.txt` or
`/.well-known/dev-tools-auth` on the site's origin. It does not fall back to an
application page with site scripts. HTTP, cross-origin forms/iframes, ambiguous
multiple forms, new-password fields, and pages without a suitable helper document
require manual filling. Native password-manager matching for a different saved
subdomain still follows that provider's rules.

Validation: `npm test`, `node --test safari-auth/test/*.test.mjs`,
`python3 -m unittest tests.test_chrome_auth_build` from the repository root, and
`node test/password-fill-live.mjs` from `shared_browser`. The live test uses
two disposable Chrome profiles and owned HTTPS fixtures, loads the actual
extension, fills dummy credentials in the original browser, verifies automatic
return, and rejects stale destinations. Its test certificate and pairing key
exist only inside the disposable test directory. It does not validate a user's
real Proton vault or Apple Passwords provider. Safari/iCloud provider behavior
needs separate acceptance testing.

2026-10-02: deployed to the procbox runtime and the existing Mac Chrome Auth
extension (version 1.1.1, unchanged permissions). The source change is retained
in this checkout; the installed release symlink was not modified. A later
dev-tools deployment must include this source change to preserve the feature.
Procbox's preceding files are saved in
`~/.local/state/dev-tools/password-fill-backup-20261002/`. The old Mac extension
scripts are saved in this chat's `work/auth-extension-backup/`; its existing
fleet key/configuration is reused.

Cloudflare acceptance: the original batch value setter lost the password when
the username had been edited first. Version 1.1.1 commits each field and its
events in sequence, revalidates destinations between updates, and checks the
retained values before reporting success. The helper uses a non-submit button
to avoid Chrome offering to save a duplicate copy.

Fleet rollout on 2026-10-02: the password bridge and editor PAT policy were
committed and pushed on `codex/general-passkey-approval` (PR #18). Runtime release
`92a7fe9774df8efe104e575000418634629ee18ee1e97aee09532d4666e42e20`
is active on every inventory host. All four Linux browser runtimes match the
release, and the Mac Chrome/Safari companion extensions were rebuilt at 1.1.1.
Procbox, demobox and bolde-b200s serve the new password-fill controls publicly.

The rebuilt Coder pod needed Supervisor restored and its stale Chrome profile
locks cleared after verifying that the preceding pod no longer existed. Chrome,
receiver and registration now run normally. Its Tailscale daemon lives in a
separate pod container, so local installation used
`SHARED_BROWSER_ORIGIN=https://ws-bolde-workspace-large.asg.ts.net:8443` with
`shared_browser/install.sh`. Public viewer publication remains pending an admin
Kubernetes context: the workload account cannot execute commands in the sidecar.
Inspect the sidecar's existing Serve configuration before allocating its dedicated
8443 listener to `http://127.0.0.1:8791`; preserve other routes.
