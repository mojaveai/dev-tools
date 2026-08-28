# dev-tools

One command to take any Linux machine to a working development environment —
and to keep it there.

```sh
curl -fsSL https://raw.githubusercontent.com/mojaveai/dev-tools/main/bootstrap.sh | sh
```

The first run on a machine also needs the Proton Pass token, once:

```sh
curl -fsSL https://raw.githubusercontent.com/mojaveai/dev-tools/main/bootstrap.sh \
  | PROTON_PASS_PERSONAL_ACCESS_TOKEN='pst_...::...' sh
```

It is then stored at `~/.config/dev-tools/proton-pass.pat` (mode 0600), so every
later run is the bare one-liner again.

**This repository is public and contains no secrets** — only the *names* of vault
items to look up. Every credential is fetched at run time from Proton Pass.

## What it sets up

| | |
|---|---|
| Tailscale | joined, tagged, with **Tailscale SSH** enabled |
| Claude Code | native install, settings, keybindings, long-lived OAuth token |
| Codex | standalone install, keymap, login |
| Keymaps | **Enter inserts a newline, Tab submits** — in both CLIs |
| Agent skills | everything in `skills/`, linked into both CLIs |
| pass-cli | installed and authenticated with a scoped PAT |
| gh | current upstream release, authenticated, wired into git |
| SSH | your [sshid.io](https://sshid.io) public keys in `authorized_keys` |
| Dev tools | `uv`, `ripgrep`, plus `git`/`jq`/`curl`/`keyutils` baseline |
| g2-terminal | installed from its private release |

## Re-running it

Running it again is the point. Each step checks the current state first and
reports one of:

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

Five things the script cannot do for you.

**1. Vault items.** Create these in Proton Pass to match `config/secrets.map`:

| Reference | What |
|---|---|
| `pass://dev/tailscale/oauth-client-secret` | Tailscale **OAuth client** secret with `auth_keys` scope, tagged `tag:dev` |
| `pass://dev/github/pat` | GitHub PAT, scopes `repo`, `read:org`, `gist` |
| `pass://dev/anthropic/claude-code-token` | output of `claude setup-token` |
| `pass://dev/g2/elevenlabs` | ElevenLabs key (g2 voice) |
| `pass://dev/g2/openrouter` | OpenRouter key (optional) |

**2. A Proton Pass PAT** — `pass-cli pat create --name dev-bootstrap --expiration ...`.
This is the one credential that must reach each machine out-of-band; everything
else comes from the vault.

**3. `claude setup-token`** — run once, ever, on any machine. It opens a browser,
prints a ~1-year token, and saves it nowhere. Put it in the vault.

> Why not just copy `~/.claude/.credentials.json`? Those hold *rotating* refresh
> tokens. They are bearer credentials with no machine binding, so copying works
> — until two machines refresh, fork the token chain, and reuse-detection revokes
> the whole family, logging out both. `setup-token` produces a credential that is
> presented directly, with no refresh cycle to collide over.

**4. A Tailscale ACL rule.** `tailscale up --ssh` advertises an SSH server but
writes no policy. Your tailnet policy file needs both network *and* SSH rules:

```json
{ "action": "accept", "src": ["autogroup:member"], "dst": ["tag:dev"], "users": ["autogroup:nonroot", "root"] }
```

Avoid `"action": "check"` — it forces periodic re-auth and breaks automation.

**5. Codex login.** ChatGPT-plan login has no non-interactive path, so the script
prompts once per machine. (It uses your subscription rather than API billing;
that was a deliberate choice.)

## Notes on the pieces

**pass-cli and the kernel keyring.** `pass-cli` keeps its database key in the
kernel keyring. A key minted by one login belongs to that login's session keyring
and is simply *gone* in any later shell, surfacing as
`NoStorageAccess(KeyRevoked)` — which looks exactly like a bad credential and is
not. Every vault access runs inside a fresh session keyring via `keyctl`. If
`keyutils` is unavailable the script falls back to
`PROTON_PASS_KEY_PROVIDER=fs` and says so loudly: that stores the key beside the
data it encrypts.

**Tailscale auth.** Uses an **OAuth client secret**, not an auth key — auth keys
expire after at most 90 days and would break this bootstrap quarterly. OAuth
clients require a tag, and register nodes as *ephemeral* by default, so the
script passes `?ephemeral=false&preauthorized=true`. Without systemd (containers,
Coder pods) `tailscaled` starts in userspace-networking mode: inbound Tailscale
SSH works, outbound traffic needs the SOCKS5 proxy on `localhost:1055`.

**Keymaps.** Claude Code reads `~/.claude/keybindings.json` and uses `+` for
modifiers; Codex reads `[tui.keymap.*]` in `config.toml` and uses `-`. A `+` in
the Codex file fails at startup with `data did not match any variant of untagged
enum KeybindingsSpec`. Codex needs a restart to pick up changes.

In Claude Code the `Autocomplete` context is left alone, so Tab still accepts a
completion while the popup is open. For Tab to submit unconditionally, add:

```json
{ "context": "Autocomplete", "bindings": { "tab": null, "enter": "autocomplete:accept" } }
```

**SSH keys.** `https://sshid.io/<handle>` is fetched into a managed block, so
keys revoked upstream disappear here too, while keys you added by other means are
untouched. The response is checked to actually contain public keys first —
otherwise a CDN error page would land in `authorized_keys` verbatim.

**Privileges.** Uses `sudo` when it is available and non-interactive, otherwise
installs everything under `~/.local`. Tailscale is the only step that genuinely
requires root; it reports SKIP without it.

## Layout

```
bootstrap.sh          curl|sh entrypoint: fetch this repo, run provision.sh
provision.sh          orchestrator, step runner, summary
lib/common.sh         logging, privilege, managed blocks, JSON/TOML merge
lib/NN-*.sh           one module per concern, run in numeric order
config/               settings, keybindings, keymap, secrets.map (names only)
skills/               agent skills, symlinked into both CLIs
```

To add a tool, drop a `lib/NN-thing.sh` defining `mod_thing`, and add one `step`
line to `provision.sh`. A module returns `0` for OK, `10` for UPDATED, `20` for
SKIP, anything else for FAIL, and calls `note "..."` to add detail to the summary.
