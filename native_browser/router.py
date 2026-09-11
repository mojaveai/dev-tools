#!/usr/bin/env python3
"""Select Mac native Chrome when healthy, otherwise the local native runtime.
Discovery retries before first JS dispatch; explicit reset permits reselection.
"""
import argparse,json,os,signal
from pathlib import Path

def mac_available(path, timeout=6):
    from health import mac_health
    return mac_health(path, timeout)['ready']

def local_runtime():
    root=Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'plugins/cache/openai-bundled/unified-computer-use'
    candidates=list(root.glob('*/.mcp.json'))
    if not candidates:raise RuntimeError('Local native CUA runtime is not installed')
    cfg=json.loads(max(candidates,key=lambda p:p.stat().st_mtime).read_text())['mcpServers']['cua_repl']
    return [cfg['command'],*cfg['args']],{**os.environ,**cfg.get('env',{})}

def main():
    def stop(*_): raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', default=os.environ.get('DEVTOOLS_NATIVE_BROWSER_SOCKET', str(Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'run/mac-native-browser.sock')))
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    from session_router import SessionRouter, run
    if args.check:
        health = SessionRouter(args.socket, local_runtime, lambda message: None).health()
        print(json.dumps(health) if args.json else health['route'] or 'unavailable')
        return
    run(args.socket, local_runtime)

if __name__ == '__main__': main()
