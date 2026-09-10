"""Migrate only owned browser MCP registrations, preserving other user settings."""
import argparse
import copy
import json
import os
import re
import sys
import tempfile
import tomllib
from pathlib import Path

LEGACY = ('dev-tools-browser', 'dev-tools-mac-browser')
PLUGIN = 'unified-computer-use@openai-bundled'

def table_path(header):
    try:
        obj = tomllib.loads(header + '\n__devtools_table_marker__ = true\n')
        path = []
        while isinstance(obj, dict) and len(obj) == 1:
            key, obj = next(iter(obj.items()))
            if key == '__devtools_table_marker__': return tuple(path)
            path.append(key)
    except tomllib.TOMLDecodeError:
        pass
    return None

def rewrite(text, replacements, removals):
    """Edit conventional TOML tables; verify the complete parsed result afterward."""
    expected = tomllib.loads(text)
    for path in removals:
        parent = expected
        for key in path[:-1]: parent = parent.get(key, {})
        parent.pop(path[-1], None)
    for path, value in replacements.items():
        parent = expected
        for key in path[:-1]: parent = parent.setdefault(key, {})
        parent[path[-1]] = copy.deepcopy(value)
    result = []; skip = False
    targets = set(removals) | set(replacements)
    for line in text.splitlines(keepends=True):
        if re.match(r'^\s*\[', line):
            path = table_path(line.strip())
            # Even array-table headers end a previous section. Parsed equality
            # catches ambiguous/multiline-string syntax before any write.
            skip = path is not None and any(path[:len(t)] == t for t in targets)
        if not skip: result.append(line)
    output = ''.join(result).rstrip() + '\n'
    for path, value in replacements.items():
        output += '\n[' + '.'.join(json.dumps(k) for k in path) + ']\n'
        for key, item in value.items():
            encoded = str(item).lower() if isinstance(item, bool) else json.dumps(item)
            output += f'{key} = {encoded}\n'
    if tomllib.loads(output) != expected:
        raise ValueError('Nonstandard browser TOML layout; refusing to alter unrelated settings')
    return output

def atomic_write(path, data):
    if path.exists() and path.read_text() == data: return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name+'.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f: f.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    return True

def configure(repo, codex_path, claude_path, socket_path=None):
    # Parse both before modifying either. Do not log credential-bearing configs.
    text = codex_path.read_text() if codex_path.exists() else ''
    cur = tomllib.loads(text)
    claude = json.loads(claude_path.read_text()) if claude_path.exists() else {}
    if not isinstance(claude, dict) or not isinstance(claude.get('mcpServers', {}), dict):
        raise ValueError('Invalid Claude MCP configuration')
    router = str(repo/'native_browser/router.py')
    old = cur.get('mcp_servers', {}).get('cua_repl')
    if old and not any(str(arg).endswith(('/native_browser/router.py', '/mac-native-browser/router.py')) for arg in old.get('args', [])):
        raise ValueError('An unmanaged cua_repl registration exists; refusing to replace it')
    if socket_path is None and old and '--socket' in old.get('args', []):
        socket_path = old['args'][old['args'].index('--socket')+1]
    args = [router]
    if socket_path: args += ['--socket', str(socket_path)]
    replacements = {
        ('mcp_servers','cua_repl'): {
            'command':sys.executable, 'args':args,
            'enabled_tools':['js','js_reset','turn_ended'],
            'startup_timeout_sec':120, 'tool_timeout_sec':120,
        },
        ('plugins',PLUGIN,'mcp_servers','cua_repl'):{**cur.get('plugins',{}).get(PLUGIN,{}).get('mcp_servers',{}).get('cua_repl',{}),'enabled':False},
    }
    removals = [('mcp_servers', k) for k in LEGACY]
    # Remove the earlier Mac-only prototype alias only when it uses our relay.
    alias = cur.get('mcp_servers', {}).get('mac_native_browser', {})
    if any('mac-native-browser/relay.py' in str(a) for a in alias.get('args', [])):
        removals.append(('mcp_servers','mac_native_browser'))
    output = rewrite(text, replacements, removals)
    servers = claude.get('mcpServers', {})
    claude_changed = False
    for name in LEGACY:
        if name in servers: del servers[name]; claude_changed = True
    changed = atomic_write(codex_path, output)
    if claude_changed:
        changed = atomic_write(claude_path, json.dumps(claude, indent=2)+'\n') or changed
    return changed

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('repo',type=Path);p.add_argument('--socket',type=Path);a=p.parse_args()
    home=Path.home();codex=Path(os.environ.get('DEVTOOLS_CODEX_CONFIG',str(Path(os.environ.get('CODEX_HOME',str(home/'.codex')))/'config.toml')))
    claude=Path(os.environ.get('DEVTOOLS_CLAUDE_CONFIG',str(home/'.claude.json')))
    try:
        changed=configure(a.repo.resolve(),codex,claude,a.socket)
        print('Native cua_repl configured (Mac preferred, local fallback)' if changed else 'Native cua_repl already configured')
        sys.exit(10 if changed else 0)
    except (OSError,ValueError) as e:
        print(f'Native browser migration failed: {type(e).__name__}; check config syntax and conflicting cua_repl registration',file=sys.stderr);sys.exit(1)
