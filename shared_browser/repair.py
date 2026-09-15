"""Restore a missing shared-browser registration without changing user overrides."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'native_browser'))
from configure import atomic_write, rewrite

UNIT = 'dev-tools-shared-browser-repair'


def repair(config, server):
    config.parent.mkdir(parents=True, exist_ok=True)
    with (config.parent / '.dev-tools-shared-browser-repair.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        text = config.read_text() if config.exists() else ''
        current = tomllib.loads(text)
        if 'shared_browser_repl' in current.get('mcp_servers', {}):
            return False
        return atomic_write(config, rewrite(text, {('mcp_servers', 'shared_browser_repl'): server}, []))


def quote(value):
    return json.dumps(str(value).replace('%', '%%').replace('$', '$$'))


def install(repo, config, server, units):
    args = [sys.executable, str(repo / 'shared_browser/repair.py'), '--once',
            '--config', str(config), '--server', json.dumps(server)]
    atomic_write(units / (UNIT + '.service'),
                 '[Unit]\nDescription=Restore missing shared browser MCP registration\n'
                 '[Service]\nType=oneshot\nExecStart=' + ' '.join(map(quote, args)) +
                 '\n[Install]\nWantedBy=default.target\n')
    atomic_write(units / (UNIT + '.path'),
                 '[Unit]\nDescription=Watch shared browser MCP registration\n'
                 '[Path]\nPathChanged=' + str(config).replace('%', '%%') +
                 '\nUnit=' + UNIT + '.service\n[Install]\nWantedBy=default.target\n')
    # A periodic check also recovers from a path unit rate limit after rapid
    # external rewrites. Neither repair path restarts Chrome or Codex.
    atomic_write(units / (UNIT + '.timer'),
                 '[Unit]\nDescription=Recheck shared browser MCP registration\n'
                 '[Timer]\nOnBootSec=1min\nOnUnitActiveSec=1min\n'
                 '[Install]\nWantedBy=timers.target\n')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'reset-failed', UNIT + '.path', UNIT + '.service'], check=False, stderr=subprocess.DEVNULL)
    subprocess.run(['systemctl', '--user', 'enable', '--now', UNIT + '.path', UNIT + '.timer'], check=True)
    subprocess.run(['systemctl', '--user', 'restart', UNIT + '.path', UNIT + '.timer'], check=True)
    subprocess.run(['systemctl', '--user', 'start', UNIT + '.service'], check=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--once', action='store_true')
    p.add_argument('--config', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'config.toml')
    p.add_argument('--server', help='Explicit MCP launch configuration for remote deployments')
    p.add_argument('--runtime', type=Path, default=Path.home()/'.local/share/dev-tools-shared-browser')
    p.add_argument('--node', default='/usr/local/bin/node')
    a = p.parse_args()
    server = json.loads(a.server) if a.server else dict(command=a.node, args=[str(a.runtime/'mcp.mjs')], startup_timeout_sec=30, tool_timeout_sec=120)
    if not a.server and not (a.runtime/'mcp.mjs').is_file():
        p.error('Shared browser runtime is not installed')
    if a.once:
        if repair(a.config, server):
            print('Restored shared_browser_repl; reconnect existing MCP sessions.')
    else:
        install(Path(__file__).resolve().parent.parent, a.config, server,
                Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home()/'.config')))/'systemd/user')


if __name__ == '__main__':
    main()
