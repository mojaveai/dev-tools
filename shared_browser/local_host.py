"""Remove an old SSH shared-browser registration from a local desktop host."""
import json
import os
from pathlib import Path
import sys
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'native_browser'))
from configure import atomic_write, rewrite


def remote_browser(server):
    return (isinstance(server, dict) and server.get('command') == 'ssh'
            and any(str(arg).endswith(('/shared_browser/mcp.mjs', '/dev-tools-shared-browser/mcp.mjs'))
                    for arg in server.get('args', [])))


def remove_remote(codex, claude):
    text = codex.read_text() if codex.exists() else ''
    current = tomllib.loads(text)
    data = json.loads(claude.read_text()) if claude.exists() else {}
    if not isinstance(data, dict) or not isinstance(data.get('mcpServers', {}), dict):
        raise ValueError('Invalid Claude MCP configuration')
    changed = False
    if remote_browser(current.get('mcp_servers', {}).get('shared_browser_repl')):
        changed = atomic_write(codex, rewrite(text, {}, [('mcp_servers', 'shared_browser_repl')]))
    if remote_browser(data.get('mcpServers', {}).get('shared_browser_repl')):
        del data['mcpServers']['shared_browser_repl']
        changed = atomic_write(claude, json.dumps(data, indent=2) + '\n') or changed
    return changed


if __name__ == '__main__':
    home = Path.home()
    codex = Path(os.environ.get('CODEX_HOME', str(home / '.codex'))) / 'config.toml'
    try:
        print('Removed remote shared-browser registration' if remove_remote(codex, home / '.claude.json')
              else 'Local browser registration already selected')
    except (OSError, ValueError, tomllib.TOMLDecodeError) as exc:
        print(f'Local browser migration failed: {type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
