"""Install the shared-browser MCP while preserving unrelated agent settings."""
import json, os, sys, tomllib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'native_browser'))
from configure import rewrite, atomic_write, PLUGIN

def configure(repo, runtime, node, codex, claude):
    text = codex.read_text() if codex.exists() else ''
    current = tomllib.loads(text)
    other = json.loads(claude.read_text()) if claude.exists() else {}
    server = {'command':str(node), 'args':[str(runtime/'mcp.mjs')]}
    removals = [('mcp_servers', k) for k in ('dev-tools-browser','dev-tools-mac-browser')]
    old = current.get('mcp_servers', {}).get('cua_repl', {})
    if any(str(a).endswith('/native_browser/router.py') for a in old.get('args', [])):
        removals.append(('mcp_servers','cua_repl'))
    output = rewrite(text, {
        ('mcp_servers','shared_browser_repl'):{**server,'startup_timeout_sec':30,'tool_timeout_sec':120},
        ('plugins',PLUGIN,'mcp_servers','cua_repl'):{**current.get('plugins',{}).get(PLUGIN,{}).get('mcp_servers',{}).get('cua_repl',{}),'enabled':False},
    }, removals)
    servers = other.setdefault('mcpServers', {})
    for name in ('dev-tools-browser','dev-tools-mac-browser'):
        servers.pop(name, None)
    old = servers.get('cua_repl', {})
    if any(str(a).endswith('/native_browser/router.py') for a in old.get('args', [])):
        servers.pop('cua_repl',None)
    servers['shared_browser_repl'] = {**server,'type':'stdio'}
    atomic_write(codex, output)
    atomic_write(claude,json.dumps(other,indent=2)+'\n')
    for agent in ('.codex','.claude'):
        target=Path.home()/agent/'skills/shared-browser'
        target.parent.mkdir(parents=True,exist_ok=True)
        if target.is_symlink(): target.unlink()
        if not target.exists(): target.symlink_to(repo/'skills/shared-browser',target_is_directory=True)
    print('Shared browser configured for Codex and Claude; reconnect MCP or start a new agent session.')

if __name__ == '__main__':
    repo,runtime,node=map(Path,sys.argv[1:4]);home=Path.home()
    configure(repo,runtime,node,Path(os.environ.get('CODEX_HOME',home/'.codex'))/'config.toml',home/'.claude.json')
