# Shared browser registration recovery

On 2026-09-15, procbox and demobox had running shared-browser services but no
`shared_browser_repl` entry in Codex configuration. The writer that removed the
entries was not identified. The shared-browser installer retired the native
registration watcher without installing a replacement, leaving missing entries
unrepaired.

The shared-browser installer and ordinary dev-tools provisioning now install
`dev-tools-shared-browser-repair.path` and a one-minute fallback timer. They
restore only an absent registration. Existing custom or disabled entries,
unrelated settings, and invalid TOML are left untouched. Repairs never restart
Chrome or Codex. Existing agent connections may need an MCP reconnect or a
graceful Codex daemon reload to discover restored tools.

To install/reinstall protection on an existing Linux shared-browser host:

```sh
python3 ~/.local/share/dev-tools/shared_browser/repair.py --node "$(command -v node)"
systemctl --user status dev-tools-shared-browser-repair.path dev-tools-shared-browser-repair.timer
```

Use `--runtime` for a non-default shared-browser runtime. To intentionally retire
the integration, disable the path and timer before removing the registration;
alternatively retain the registration with `enabled = false`.

Deployment: procbox and demobox have the shared registration watcher enabled.
Bolde-b200s has the earlier native browser router, whose existing registration
watcher was enabled and missing `cua_repl` entry restored. It does not host the
shared-browser runtime. The Mac's SSH-backed procbox registration was verified
and left intact. These are registration checks, not a claim of end-to-end native
browser availability on bolde.
