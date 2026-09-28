---
name: proton-pass
description: Securely authenticate to Proton Pass and discover, inject, or run commands with Proton Pass secrets through pass-cli. Use when a task needs a credential stored in Proton Pass, including checking vault metadata, supplying a secret to a command without displaying it, or managing the scoped Proton Pass session.
---

# Proton Pass

Use Proton Pass only for a user-authorized, task-scoped credential need. Keep the value out of chat, tool output, source control, logs, command strings, and persistent application configuration.

## Access contract

1. State a one-sentence purpose in commentary before each operation that authenticates, reads credential metadata, injects a secret, or runs a command with a secret.
2. Use `scripts/access.py` for every `pass-cli` operation. It requires a non-empty `--reason`, sets Proton Pass's required `PROTON_PASS_AGENT_REASON` for the child process, and appends an audit entry containing only the time, operation class, reason, and success/failure—never a secret, item name, command arguments, or account identity.
3. Use the agent credential only through this helper; never print, copy, `cat`, commit, or pass the PAT through a shell command line. An explicit `PROTON_PASS_PERSONAL_ACCESS_TOKEN_FILE` takes precedence. On macOS the default is the full user session established by dev-tools bootstrap, with no PAT fallback. On Linux the default is `${DEVTOOLS_STATE_DIR:-~/.config/dev-tools}/proton-pass.pat`, with the old `~/.codex/agent-credentials/proton-pass.pat` used only when no provisioned file or state override exists. Files must be owner-only, regular, and non-symlinked. A rejected selected credential never falls back to another credential.
4. Treat vault and item lists as metadata. Do not run `pass-cli item view`, password, or TOTP commands through this skill because they can disclose values to the terminal.
5. Do not use `--no-masking`. Do not include a secret in the explanation, audit reason, URL, command argument, or environment dump.

This is an auditable workflow guardrail, not an operating-system boundary: processes running as the same workspace user can technically read the credential file. Do not bypass the helper.

## Session recovery

On user-facing Macs, the helper uses a persistent, full user-owned Pass CLI login
in `~/.config/dev-tools/proton-pass-session`. It does not log out, replace,
or copy that login. The desktop app's PIN unlock is separate from the CLI login.
If the CLI session is unavailable, run `provision.sh --only mod_passcli`
interactively and complete Proton's authorization. Do not fall back to the
codex-only agent PAT. An explicit PAT-file override opts into a scoped session
for a specific operation.

Prefer `authenticated-exec` for agent operations. On Linux or scoped fallback it authenticates and executes in
one temporary session using a file-backed encryption key, then removes the
temporary store. This also works in containers without kernel keyring support;
no external `keyctl session` wrapper is needed. Separate `authenticate` and `exec`
commands retain compatibility with an existing helper session, but that session
may be unavailable across shells or keyrings.

Authentication prints `pass_cli_authenticated=true` only on success. Check the
session with `info`, not `test` (removed in pass-cli 2.2.4). An online `vault list`
can verify API access; suppress its metadata output when only checking health.
Check the
exit code: a silent failure does not prove token expiry. `KeyRevoked` indicates
local key storage trouble; retry through `authenticated-exec`. If a fresh session
still rejects the provisioned token, host enrollment must be renewed. Do not
retry the older fallback token or rotate credentials without authorization.

## Secret references

The reference scheme is **`pass://`**, and the resolver is `run --env-file`, not `--env`
(`pass-cli run` takes a dotenv file whose values are references):

```bash
printf 'MY_TOKEN=pass://<vault-name>/<item-name>/<field-name>\n' > "$TMP/secrets.env"
python3 ~/.codex/skills/proton-pass/scripts/access.py authenticated-exec \
  --reason "<purpose>" -- run --env-file "$TMP/secrets.env" -- ./script-that-reads-MY_TOKEN
```

An unresolved reference is passed through **verbatim** rather than erroring, so a wrong scheme
yields an environment variable containing the literal string `op://…`. Check the resolved length
before trusting it — that is the only signal you get.

Field names come from `field-names` (labels only). `vault list` gives vault ids, but
`item list` wants `--vault-name`, not `--vault`.

## Authenticate

Authenticate only when the current Pass session is absent or expired:

```bash
python ~/.codex/skills/proton-pass/scripts/access.py authenticate \
  --reason "Need Proton Pass access to supply the approved weather-provider credential."
```

The helper validates the credential, suppresses login output, verifies the session,
and records the result. The PAT is supplied only in the login child environment,
not command arguments. macOS Keychain values are never copied into PAT files.

## Discover credential metadata

Use lists to find the right vault or item without showing fields:

```bash
python3 ~/.codex/skills/proton-pass/scripts/access.py authenticated-exec \
  --reason "Need to locate the approved Open-Meteo credential entry." \
  -- vault list

python3 ~/.codex/skills/proton-pass/scripts/access.py authenticated-exec \
  --reason "Need to locate the approved Open-Meteo credential entry." \
  -- item list --vault-name <vault-name>
```

Do not open an item into the terminal. If its structure is unclear, ask the user for the intended item/field rather than exposing it.

When the field name is unknown, use the helper's metadata-only inspection. It captures the item
response privately and emits field labels only:

```bash
python ~/.codex/skills/proton-pass/scripts/access.py field-names \
  --reason "Need to identify the approved credential field without disclosing its value." \
  --share-id <vault-share-id> --item-id <item-id>
```

## Use a secret without printing it

Prefer `pass-cli run` when the receiving program can consume a secret-reference-aware environment. It keeps the resolved value scoped to the child process and Pass masks command output by default:

```bash
python3 ~/.codex/skills/proton-pass/scripts/access.py authenticated-exec \
  --reason "Need to validate the provider credential with its authorized endpoint." \
  -- run -- <approved-command>
```

Use `pass-cli inject` only when a tool strictly requires a file. Supply `--out-file` (the helper rejects stdout injection), keep the file mode at `0600`, use an explicitly scoped temporary target, and remove it after the authorized task. Prefer `run` whenever it can avoid storing a resolved secret at all.

## Boundaries

- Do not create, rotate, share, delete, or export a credential without explicit user authorization.
- Do not save a resolved secret in `.env`, a repository, database, issue, PR, chat message, or a durable log.
- Use the audit log only to answer who/why/when an access occurred; never put secret material or sensitive user content in the reason.
- If the requested operation cannot be completed through a masked child process or a `0600` temporary file, stop and explain the limitation before exposing a value.
