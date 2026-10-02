# Fleet management

Run from the development checkout on the controller Mac:

```sh
uv tool install 'ansible-core==2.19.13'
./bin/dev-tools apply --list-hosts
./bin/dev-tools apply --limit coder --check
./bin/dev-tools apply --limit coder
./bin/dev-tools apply
```

`./bin/dev-tools apply --deploy-only` distributes source and applies native
Ansible configuration without running specialized installers or authentication.
It deliberately leaves the previous health record (including its checked release)
untouched; success in this mode does not mean authenticated integrations are healthy.

Inventory lives in `ansible/inventory.yml`. Add a host beneath `servers`,
`coder_pods`, or `macs`; set its Tailscale DNS name and SSH user. SSH host-key
verification stays enabled. New machines require working SSH and Python before
enrollment. Tailscale check-mode approval remains an interactive prerequisite.
Ansible runs as the workspace user; the existing package installer requests
privileges only where needed. macOS uses a local connection.

`apply` creates a SHA-256-addressed snapshot of runtime source from this checkout
and transfers it through Ansible; it does not publish to GitHub or fetch main on
each host. Tracked local runtime edits are included. Docs, tests, dependencies,
and untracked files outside `ansible/` and `fleet/` are excluded. Review the local
diff before deployment. Python bytecode and generated dependencies are excluded.

Ansible owns release deployment, Debian baseline packages and Mosh, launcher
installation, agent skill adoption, tmux configuration, and the final credential
health check. Specialized package,
authentication, configuration-merge, and browser routines remain in the existing
provisioner, called non-interactively. This is an incremental migration: those
routines retain their existing idempotence and platform checks. Bootstrap remains
available for first enrollment and local use.

Installed source lives under `~/.local/share/dev-tools-releases/<hash>` with
`~/.local/share/dev-tools` pointing to the selected release. On first adoption,
the previous directory and standalone skills are renamed with
`.pre-ansible-<timestamp>` suffixes. They are retained for recovery. Later releases
are also retained; no automatic pruning occurs. Changing the source symlink alone
does not undo package upgrades or configuration changes made during provisioning.

Check mode previews native Ansible configuration tasks. It deliberately does not
run installers, authenticate, unpack a new release, or predict the effects of the
specialized provisioner. A successful check is not a full deployment health check.

Proton uses the full user-owned session on macOS. If that session is locked or
inaccessible to a background process, Mac health verification fails and requires
an interactive unlock; it never falls back to a codex-only agent PAT. Linux hosts
continue using their provisioned, codex-scoped PATs.
New bootstrap tokens receive editor access to the configured vaults. Existing
tokens need their current grants upgraded through the controller's full Proton
session; rerunning bootstrap does not change token permissions.

For a focused bootstrap policy rollout, run
`ansible-playbook -i ansible/inventory.yml ansible/proton-policy.yml`.
This overlays only `lib/25-passcli.sh` onto a copy of each host's active release
and atomically activates it. It preserves other installed runtime files and the
previous checked health record, and does not run installers or restart services.

No credentials are stored in inventory
or the release. Raw provisioner and authentication output is suppressed; the
playbook publishes only integration status labels. Final health is recorded in
`~/.local/share/dev-tools-health.json`. Failed authentication produces a failed
deployment result after unrelated configuration completes. Renew the affected
host's enrollment interactively, then reapply to that host; Ansible never copies
one host's refresh tokens onto another.

For Codex ChatGPT enrollment, run `ssh -t HOST 'codex login --device-auth'`, then
reapply. For Proton enrollment, run the host's `dev-tools --only mod_passcli`
interactively. Existing opted-in browser-assisted Codex login remains supported.

If a generated Linux environment needs restoring while host-side Proton login
is unavailable, run this from a controller Terminal with a working Proton session:

```sh
./bin/dev-tools repair-env --limit bolde-b200s,demobox
```

This resolves `config/secrets.map` through the audited Proton helper and runs
`ansible/repair-env.yml`. All four references must resolve before any write. The
playbook restores only the generated environment file, backs up its previous
contents, sets mode 0600, and suppresses secret-bearing task output. It does not
copy Proton PATs or OAuth sessions, or mark an unsuccessful full deployment healthy.
On Macs, Keychain may allow access from Terminal while refusing the same request
from a background agent; use the normal user Terminal in that case.
