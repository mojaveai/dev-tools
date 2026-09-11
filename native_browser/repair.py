"""Keep an installed native router registered after external config rewrites."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

from configure import atomic_write, configure

UNIT = 'dev-tools-native-browser-repair'


def repair(repo, codex, claude, socket_path=None):
    codex.parent.mkdir(parents=True, exist_ok=True)
    with (codex.parent / '.dev-tools-native-browser-repair.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = tomllib.loads(codex.read_text()) if codex.exists() else {}
        # An existing entry, including an explicitly disabled or custom one,
        # belongs to the user. Only restore an entry that has disappeared.
        if 'cua_repl' in current.get('mcp_servers', {}):
            return False
        return configure(repo, codex, claude, socket_path)


def quote(value):
    # systemd expands percent specifiers and dollar variables inside quotes.
    return json.dumps(str(value).replace('%', '%%').replace('$', '$$'))


def install(repo, codex, claude, units, socket_path=None):
    args = [sys.executable, str(repo/'native_browser/repair.py'), '--once',
            '--repo', str(repo), '--config', str(codex), '--claude', str(claude)]
    if socket_path: args += ['--socket', str(socket_path)]
    service = ('[Unit]\nDescription=Restore missing dev-tools native browser MCP registration\n'
               '[Service]\nType=oneshot\nExecStart=' + ' '.join(map(quote, args)) + '\n'
               '[Install]\nWantedBy=default.target\n')
    # Watching the directory also catches atomic config replacement/deletion.
    path = ('[Unit]\nDescription=Watch Codex configuration for missing browser registration\n'
            '[Path]\nPathChanged=' + str(codex.parent).replace('%', '%%') + '\n'
            'Unit=' + UNIT + '.service\n[Install]\nWantedBy=default.target\n')
    changed = atomic_write(units/(UNIT+'.service'), service)
    changed = atomic_write(units/(UNIT+'.path'), path) or changed
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', UNIT+'.path'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', UNIT+'.service'], check=True)
    if changed:
        subprocess.run(['systemctl', '--user', 'restart', UNIT+'.path'], check=True)
    subprocess.run(['systemctl', '--user', 'start', UNIT+'.service'], check=True)
    return changed


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--once', action='store_true')
    p.add_argument('--repo', type=Path, required=True)
    p.add_argument('--config', type=Path)
    p.add_argument('--claude', type=Path)
    p.add_argument('--socket')
    a = p.parse_args()
    home = Path.home()
    codex = a.config or Path(os.environ.get('DEVTOOLS_CODEX_CONFIG', str(Path(os.environ.get('CODEX_HOME', str(home/'.codex')))/'config.toml')))
    claude = a.claude or Path(os.environ.get('DEVTOOLS_CLAUDE_CONFIG', str(home/'.claude.json')))
    try:
        if a.once:
            changed = repair(a.repo, codex, claude, a.socket)
            if changed: print('Restored missing cua_repl registration; reconnect existing MCP sessions.')
        else:
            current = tomllib.loads(codex.read_text())
            args = current.get('mcp_servers', {}).get('cua_repl', {}).get('args', [])
            socket_path = a.socket
            if socket_path is None and '--socket' in args:
                socket_path = args[args.index('--socket')+1]
            units = Path(os.environ.get('XDG_CONFIG_HOME', str(home/'.config')))/'systemd/user'
            changed = install(a.repo, codex, claude, units, socket_path)
        return 10 if changed and not a.once else 0
    except (OSError, ValueError, subprocess.SubprocessError):
        print('Native browser automatic repair failed; inspect the user service journal and configuration syntax.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
