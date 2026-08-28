# dev-tools

One command to take any Linux machine to a working development environment —
and to keep it there.

```sh
curl -fsSL https://raw.githubusercontent.com/mojaveai/dev-tools/main/bootstrap.sh | sh
```

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

    updated  vault unlocked (interactive)
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
| pass-cli | installed, vault unlocked by approving a link |
| gh | current upstream release, authenticated, wired into git |
| SSH | your [sshid.io](https://sshid.io) public keys in `authorized_keys` |
| Dev tools | `uv`, `ripgrep`, plus a `git`/`jq`/`curl`/`keyutils`/`tmux` baseline |
| g2-terminal | installed from its private release |

## How trust flows

```
tap the Tailscale link   -> machine joins the tailnet (tag:dev), SSH on
tap the Proton Pass link -> vault unlocked
                         -> GitHub PAT, Claude token, ElevenLabs, ... everything else
```

Two approvals, both from a browser you are already signed into. Nothing is typed,
nothing is stored on the phone, and no credential is committed here.

There is no secrets server to run. Proton Pass *is* the secret store, and
`pass-cli login` is its approve-a-link unlock — so the only server involved is
Proton's. Revoking a machine is removing the Tailscale device and, if you want to
be thorough, its Proton session.

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
```

## One-time setup

**1. Vault items** matching `config/secrets.map`:

| Reference | What |
|---|---|
| `pass://dev/github/pat` | GitHub PAT, scopes `repo`, `read:org`, `gist` |
| `pass://dev/anthropic/claude-code-token` | output of `claude setup-token` |
| `pass://dev/g2/elevenlabs` | ElevenLabs key (g2 voice) |
| `pass://dev/g2/openrouter` | OpenRouter key (optional) |

**2. Nothing.** The vault unlocks by approving a link. A scoped
`pass-cli pat create` token is only needed for unattended runs (below).

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

A token also changes how the vault key is stored. With a token, each access runs
in a fresh kernel keyring and re-authenticates — nothing persists. An interactive
login has no token to replay, so its session is kept on a file-backed key
(`PROTON_PASS_KEY_PROVIDER=fs`) that survives between runs: you approve once per
machine rather than once per run, at the cost of the key sitting beside the data
it encrypts.

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
