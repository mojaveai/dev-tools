# dev-tools

One command to take any Linux machine to a working development environment —
and to keep it there.

```sh
curl -fsSL https://raw.githubusercontent.com/mojaveai/dev-tools/main/bootstrap.sh | sh
```

Native Codex browser routing is configured on every install: Mac Chrome when
available, otherwise the host's native runtime. Set up the Mac relay once using
[the native browser guide](docs/native-browser.md).

Include the optional **noVNC browser viewer** with one command:

```sh
curl -fsSL https://raw.githubusercontent.com/mojaveai/dev-tools/main/bootstrap.sh | sh -s -- --with-browser
```

Already set up? The same command checks and repairs the installation, preserving
authentication and browser profiles. Browser installation and private viewer
access are reported separately; see [the browser runbook](docs/browser.md).

Nothing to paste, no secret to carry, nothing self-hosted. A new machine asks you
to approve two links — Tailscale, then Proton Pass — and does the rest itself.

```
==> tailscale

  Tailscale needs you to approve this machine.
  Open the link below and approve; provisioning continues automatically.

  To authenticate, visit: https://login.tailscale.com/a/4f2c9a1b

    updated  Running @ 100.x.y.z, SSH on
==> pass-cli

  Proton Pass needs you to approve this machine.
  Open the link it prints below and sign in.

  https://account.proton.me/desktop/login?app=pass#payload=...

    updated  scoped to 1 vault(s), expires in 3m
```

**This repository is public and contains no secrets** — only the *names* of vault
items to look up. Every credential is fetched at run time.

## Running it from a phone

It is built for a mobile SSH client (Termius, Blink):

- **A tappable URL, not a QR code.** You cannot scan a QR shown on the screen you
  are reading it on, so the Tailscale approval is a plain link you tap.
- **Survives dropped connections.** If tmux is present the run happens inside a
  session named `dev-tools`, so a dead mobile link leaves it going. Reconnect and
  `tmux attach -t dev-tools` picks up live progress. `DEVTOOLS_NO_TMUX=1` opts
  out; it is skipped automatically when you are already inside tmux.
- **One tap to launch.** Save the one-liner as a Termius Snippet and run it on one
  host or several at once.

## What it sets up

| | |
|---|---|
| Tailscale | joined, tagged, with **Tailscale SSH** enabled |
| Claude Code | native install, settings, keybindings, long-lived OAuth token |
| Codex | standalone install, keymap, login |
| Keymaps | **Enter inserts a newline, Tab submits** — in both CLIs |
| Agent skills | everything in `skills/`, linked into both CLIs |
| pass-cli | installed, left holding a scoped per-machine token |
| gh | current upstream release, authenticated, wired into git |
| SSH | your [sshid.io](https://sshid.io) public keys in `authorized_keys` |
| Dev tools | `uv`, `ripgrep`, plus a `git`/`jq`/`curl`/`keyutils`/`tmux` baseline |
| tmux scrolling | Mouse/trackpad scrollback enabled automatically, including in an existing tmux server |
| g2-terminal | installed from its private release |
| Native browser control | `cua_repl`: Mac-first native Chrome control over SSH, local fallback; [setup](docs/native-browser.md) |
| Browser viewer (pilot) | `--with-browser`: optional Linux browser with private noVNC viewing; [operations](docs/browser.md) |

Mouse scrolling uses tmux's normal copy-mode bindings: scroll up to browse
history, then scroll to the bottom or press `q` to return to the application.
The installer keeps other tmux settings and keybindings intact. To apply just
this configuration on an existing host, run `./provision.sh --only mod_tmux`.
Set `DEVTOOLS_TMUX_CONFIG` if you use a custom tmux configuration path.

Mouse scrolling uses tmux's normal copy-mode bindings: scroll up to browse
history, then scroll to the bottom or press `q` to return to the application.
The installer keeps other tmux settings and keybindings intact. To apply just
this configuration on an existing host, run `./provision.sh --only mod_tmux`.
Set `DEVTOOLS_TMUX_CONFIG` if you use a custom tmux configuration path.

## How trust flows

```
tap the Tailscale link   -> machine joins the tailnet (tag:dev), SSH on
tap the Proton Pass link -> full-vault session, briefly
                         -> mint dev-<host>, scoped + expiring
                         -> log out of the full session
                         -> re-auth with the scoped token   <- what persists
                         -> GitHub PAT, Claude token, ... everything else
```

Two approvals, both from a browser you are already signed into. Nothing is typed
and nothing is stored on the phone.

**The full-vault session lasts seconds.** It exists only to mint a scoped token,
then it is explicitly logged out. What remains on the machine is a viewer-role
token limited to the vaults you name, expiring in three months, named after the
host — so `pass-cli pat list` shows which machine each token belongs to, and
revoking one box touches no other.

When that token expires, the next interactive run rotates it automatically:
escalate once, mint a fresh one, drop back down.

There is no secrets server to run. Proton Pass *is* the secret store and
`pass-cli login` is its approve-a-link unlock, so the only server involved is
Proton's.

### Tuning the scope

```sh
DEVTOOLS_PAT_VAULTS="codex infra" # vaults the token may read (default: codex)
DEVTOOLS_PAT_EXPIRATION=1m        # 1d 1w 1m 3m 6m 1y   (default: 3m)
DEVTOOLS_PAT_NAME=laptop          # default: dev-<hostname>
```

Grants are `viewer`. If none succeed the run fails rather than dropping to a
token that cannot read anything.

## Re-running it

Running it again is the point. Each step checks the current state first:

```
  OK       tailscale             Running @ 100.x.y.z, SSH on
  UPDATED  claude code           configured, 2.1.251, token provisioned
  SKIP     g2-terminal           no published asset for aarch64
  FAIL     github cli            token rejected
```

- **OK** — already correct, nothing done.
- **UPDATED** — installed, upgraded, or changed to match.
- **SKIP** — not applicable here (missing prerequisite, wrong arch, no root).
- **FAIL** — went wrong; everything else still ran.

A failing step never stops the others. The script exits non-zero if anything
failed, so it is safe to run from automation. Add a tool to this repo, change an
account, or let a CLI fall behind, and the next run converges the difference —
version bumps take the update path (`claude update`, `codex update`,
`uv self update`) rather than reinstalling.

Files you also own are edited through `# BEGIN dev-tools:<name>` blocks that are
rewritten wholesale, and JSON/TOML configs are merged key-wise. Nothing is
appended twice, and removals propagate.

### Options

```sh
./provision.sh --only "mod_claude mod_codex"   # just these
./provision.sh --skip "mod_g2"                 # all but this
./provision.sh --non-interactive               # never prompt
./provision.sh --list                          # step names
./provision.sh --with-browser                  # pilot: native browser + live viewer
./provision.sh --with-browser --viewer-policy-reviewed  # reviewed tailnet; automatic publication
./provision.sh --only mod_native_browser       # migrate legacy MCPs to native routing
```

## One-time setup

**1. Vault items** matching `config/secrets.map`:

| Item (vault `codex`) | Field | What |
|---|---|---|
| `GitHub PAT` | `API Key` | scopes `repo`, `read:org`, `gist` |
| `Claude Code Token` | `API Key` | output of `claude setup-token` |
| `ElevenLabs` | `API Key` | g2 voice — already exists |
| `openrouter` | `API Key` | optional — already exists |
| `ChatGPT` | `Email` | intended Codex account; read separately via `config/codex/identity.refs` |

Codex accepts an existing login only when its ChatGPT email matches the vault
item. Mismatched or unverifiable identities fail without replacing credentials.
Missing or rejected credentials use the configured recovery path below. A matching login is checked online without a model call and reused without
prompting. A rejected access token gets one supported refresh attempt; a healthy
session does not force refresh. New machines use `codex login --device-auth` and are checked
again after login. The check confirms identity and live account access. Service/network failures
are reported as unverified and do not trigger reauthentication.

Override the target using `DEVTOOLS_CODEX_EXPECTED_EMAIL`, or point
`DEVTOOLS_CODEX_IDENTITY_REFS` at a names-only reference file outside the installed
checkout. Use vault/item IDs in references when names are duplicated. No resolved
identity, password or TOTP is written into shell configuration. The default only
reads `pass://codex/ChatGPT/email`; Password and TOTP are not needed for this check.
Identity verification currently covers Codex; it does not certify the accounts
used by other installed services.

The [official Codex authentication flow](https://learn.chatgpt.com/docs/auth.md)
supports browser/device approval, not direct password/TOTP CLI login. Enable
browser-assisted recovery once with `--with-codex-login` (also installs the browser).
```sh
curl -fsSL https://raw.githubusercontent.com/mojaveai/dev-tools/main/bootstrap.sh | sh -s -- --with-codex-login
```

The preference is saved on this host. When a matching account's token cannot be
refreshed, setup opens Codex's official OAuth flow in a temporary shared browser
and resolves Email, Password and a fresh TOTP from `codex/ChatGPT` only as each
field is needed. It checks the login email against the configured account before
using the password. Values stay in short-lived child processes; they are not
written into shell configuration or logs. Login profiles are deleted after the
attempt. Use `DEVTOOLS_CODEX_LOGIN_REFS_DIR` for names-only login reference files
outside the install tree when using a different vault item.

Automation is bounded and limited to OpenAI login origins. If approval, CAPTCHA,
SSO, or a changed page prevents completion, the existing viewer handoff is used
and waits up to ten minutes; it never bypasses challenges or loops password
attempts. Healthy sessions skip this path entirely. Network failures and wrong
accounts do not initiate a new login. Tests cover synthetic forms; real OpenAI
login pages may change. Codex's saved authentication remains the standard OAuth
cache, with normal refresh handling.

After verified authentication, setup checks matching same-user Codex Unix daemons.
If auth/config files are newer than a supported daemon, it queues a single SIGHUP
reload: Codex drains active turns, then a detached helper restores its launch.
Stdio servers and other users/homes are left alone. Unchanged reruns do not restart
servers, and no forced termination is used. A daemon controlled by another
manager is not duplicated if that manager has already restarted it.

**2. The `codex` vault** is what the scoped token is granted access to. Change it
with `DEVTOOLS_PAT_VAULTS`.

**3. `claude setup-token`** — run once, ever, on any machine. It opens a browser,
prints a ~1-year token, and saves it nowhere. Put it in the vault.

> Why not copy `~/.claude/.credentials.json` between machines? Those hold
> *rotating* refresh tokens. They are bearer credentials with no machine binding,
> so copying works — until two machines refresh, fork the token chain, and
> reuse-detection revokes the whole family, logging out both. `setup-token`
> produces a credential presented directly, with no refresh cycle to collide over.

**4. Tailnet ACL.** Two entries. `tagOwners` must let you apply `tag:dev`, or the
join falls back to an untagged, user-owned node:

```json
"tagOwners": { "tag:dev": ["autogroup:admin"] }
```

And `tailscale up --ssh` advertises an SSH server but writes no policy, so you
need both network *and* SSH rules:

```json
{ "action": "accept", "src": ["autogroup:member"], "dst": ["tag:dev"], "users": ["autogroup:nonroot", "root"] }
```

Avoid `"action": "check"` — it forces periodic re-auth and breaks automation.

**5. Codex login.** ChatGPT-plan login has no non-interactive path, so the script
prompts once per machine, using your subscription rather than API billing.

## Unattended provisioning

Interactive approval blocks CI. For that case supply a Tailscale **OAuth client
secret** (not an auth key — those expire after at most 90 days) and the token:

```sh
curl -fsSL .../bootstrap.sh | \
  TS_OAUTH_SECRET='...' PROTON_PASS_PERSONAL_ACCESS_TOKEN='pst_...' sh -s -- --non-interactive
```

`TS_OAUTH_SECRET` is deliberately *not* in `secrets.map`: Tailscale runs before the
vault is unlocked, so it cannot come from the vault.

Supplying a token skips the escalation entirely — useful in CI, where there is no
one to approve a link.

The two modes store the vault key differently. With a token, each access runs in a
fresh kernel keyring and re-authenticates, so nothing persists. The brief
escalation needs one session to survive across several processes, so it runs on a
file-backed key (`PROTON_PASS_KEY_PROVIDER=fs`); once the scoped token is in
place, accesses go back to the keyring-per-call form.

## Notes on the pieces

**pass-cli and the kernel keyring.** `pass-cli` keeps its database key in the
kernel keyring. A key minted by one login belongs to that login's session keyring
and is simply *gone* in any later shell, surfacing as
`NoStorageAccess(KeyRevoked)` — which looks exactly like a bad credential and is
not. Every vault access runs inside a fresh session keyring via `keyctl`. Without
`keyutils` the script falls back to `PROTON_PASS_KEY_PROVIDER=fs` and says so
loudly: that stores the key beside the data it encrypts.

**Userspace networking.** Without systemd (containers, Coder pods) `tailscaled`
runs in userspace-networking mode. Inbound Tailscale SSH works, but the machine's
own outbound traffic does not transparently route over the tailnet — so the
secrets fetch goes through the SOCKS5 proxy on `localhost:1055`, using `socks5h`
so MagicDNS names resolve through the tunnel.

**Personal preferences are not shipped.** `config/claude/settings.json` carries
only `autoUpdatesChannel`. Things like `permissions.defaultMode`, `theme` or
`effortLevel` are yours to set, and a provisioner that silently overwrote them
would be worse than one that left them alone. The keymap lives in
`keybindings.json`, which is provisioning intent rather than preference.

**Keymaps.** Claude Code reads `~/.claude/keybindings.json` and uses `+` for
modifiers; Codex reads `[tui.keymap.*]` in `config.toml` and uses `-`. A `+` in
the Codex file fails at startup with `data did not match any variant of untagged
enum KeybindingsSpec`. Codex needs a restart to pick up changes.

The Claude `Autocomplete` context is left alone, so Tab still accepts a completion
while the popup is open. For Tab to submit unconditionally, add:

```json
{ "context": "Autocomplete", "bindings": { "tab": null, "enter": "autocomplete:accept" } }
```

**SSH keys.** `https://sshid.io/<handle>` is fetched into a managed block, so keys
revoked upstream disappear here too, while keys you added by other means are
untouched. The response is checked to actually contain public keys first —
otherwise a CDN error page would land in `authorized_keys` verbatim.

**Privileges.** Uses `sudo` when available and non-interactive, otherwise installs
under `~/.local`. Tailscale is the only step that genuinely requires root.

## Layout

```
bootstrap.sh          curl|sh entrypoint: install to ~/.local/share/dev-tools, run it
provision.sh          orchestrator, step runner, summary
lib/common.sh         logging, privilege, managed blocks, JSON/TOML merge
lib/NN-*.sh           one module per concern, run in numeric order
config/               settings, keybindings, keymap, secrets.map (names only)
skills/               agent skills, symlinked into both CLIs
```

To add a tool, drop a `lib/NN-thing.sh` defining `mod_thing`, and add one `step`
line to `provision.sh`. A module returns `0` for OK, `10` for UPDATED, `20` for
SKIP, anything else for FAIL, and calls `note "..."` to add detail to the summary.
