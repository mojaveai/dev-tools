#!/usr/bin/env python3
"""Transparent stdio MCP relay to the installed native CUA runtime."""
import argparse,json,os,signal,socket,subprocess,sys,threading,time
from pathlib import Path

def write_all(dst, data):
    """Raw subprocess pipes may accept only part of a large MCP message."""
    remaining = memoryview(data)
    while remaining:
        count = dst.write(remaining)
        if not count: raise OSError("MCP stream closed during write")
        remaining = remaining[count:]
    dst.flush()

def pump(src,dst):
    try:
        while True:
            data=(src.read1(65536) if hasattr(src,'read1') else src.read(65536)) if hasattr(src,'read') else src.recv(65536)
            if not data: break
            if hasattr(dst,'write'): write_all(dst,data)
            else: dst.sendall(data)
    except (OSError,ValueError): pass

def client(path):
    s=socket.socket(socket.AF_UNIX);s.connect(path)
    def upload():
        pump(sys.stdin.buffer,s)
        try:s.shutdown(socket.SHUT_WR)
        except OSError:pass
    threading.Thread(target=upload,daemon=True).start()
    pump(s,sys.stdout.buffer);s.close()

def runtime_config():
    root=Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'plugins/cache/openai-bundled/unified-computer-use'
    candidates=list(root.glob('*/.mcp.json'))
    if not candidates:raise RuntimeError('Install/enable native Computer Use in the desktop app first')
    cfg=json.loads(max(candidates,key=lambda p:p.stat().st_mtime).read_text())['mcpServers']['cua_repl']
    env={**os.environ,**cfg.get('env',{})}
    env['CUA_REPL_ENABLED_SURFACES']='browser'
    env['BROWSER_USE_AVAILABLE_BACKENDS']='chrome'
    return [cfg['command'],*cfg['args']],env

def server(path):
    os.umask(0o077)
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if path.exists():
        probe=socket.socket(socket.AF_UNIX)
        try:probe.connect(str(path))
        except (ConnectionRefusedError,FileNotFoundError):path.unlink(missing_ok=True)
        else:raise RuntimeError('Relay already listening')
        finally:probe.close()
    listener=socket.socket(socket.AF_UNIX);listener.bind(str(path));os.chmod(path,0o600);listener.listen(8)
    children=set();lock=threading.Lock()
    def stop(*_):
        listener.close()
        with lock:
            for child in children:child.terminate()
        path.unlink(missing_ok=True);sys.exit(0)
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    def session(conn):
        p=None
        try:
            command,env=runtime_config()
            p=subprocess.Popen(command,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,bufsize=0)
            with lock:children.add(p)
            def upload():
                pump(conn,p.stdin)
                try:p.stdin.close()
                except OSError:pass
            t=threading.Thread(target=upload,daemon=True);t.start()
            pump(p.stdout,conn)
        finally:
            conn.close()
            if p is not None:
                if p.poll() is None:p.terminate()
                try:p.wait(timeout=3)
                except subprocess.TimeoutExpired:p.kill();p.wait()
                with lock:children.discard(p)
    try:
        while True:
            conn,_=listener.accept();threading.Thread(target=session,args=(conn,),daemon=True).start()
    finally:path.unlink(missing_ok=True)

if __name__=='__main__':
    a=argparse.ArgumentParser();a.add_argument('mode',choices=['serve','connect']);a.add_argument('socket');args=a.parse_args()
    (server if args.mode=='serve' else client)(args.socket)
