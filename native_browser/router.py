#!/usr/bin/env python3
"""Select Mac native Chrome when healthy, otherwise the local native runtime.
Selection occurs once, before forwarding client traffic; never replay UI calls.
"""
import argparse,json,os,signal,socket,subprocess,sys,threading,time,uuid
from pathlib import Path

def mac_available(path, timeout=6):
    """Probe only browser discovery, with a separate probe session. No approvals."""
    s=socket.socket(socket.AF_UNIX);s.settimeout(timeout)
    try:
        s.connect(path);f=s.makefile('rwb',buffering=0)
        deadline=time.monotonic()+timeout
        def request(ident,method,params):
            f.write((json.dumps({'jsonrpc':'2.0','id':ident,'method':method,'params':params})+'\n').encode())
            while True:
                if time.monotonic() >= deadline:raise TimeoutError("Mac health probe timed out")
                s.settimeout(max(.01,deadline-time.monotonic()))
                line=f.readline()
                if not line:raise ConnectionError('Mac closed probe')
                v=json.loads(line)
                if v.get('id')==ident and 'method' not in v:return v
                if 'method' in v and 'id' in v:
                    # Health checks never approve requests.
                    f.write((json.dumps({'jsonrpc':'2.0','id':v['id'],'error':{'code':-32601,'message':'Health probe does not handle approvals'}})+'\n').encode())
        v=request(1,'initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'native-browser-health-probe','version':'0.1'}})
        if 'error' in v:return False
        f.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        v=request(2,'tools/call',{'name':'js','arguments':{'code':'await cua.listBrowsers();','title':'Check Mac Chrome availability'},'_meta':{'x-codex-turn-metadata':{'session_id':str(uuid.uuid4()),'turn_id':str(uuid.uuid4())}}})
        if v.get('result',{}).get('isError'):return False
        for c in v.get('result',{}).get('content',[]):
            try:items=json.loads(c.get('text',''))
            except (ValueError,TypeError):continue
            if isinstance(items,list) and any(isinstance(x,dict) and x.get('type')=='extension' and x.get('family')=='chrome' for x in items):return True
        return False
    except (OSError,ValueError,ConnectionError):return False
    finally:s.close()

def local_runtime():
    root=Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'plugins/cache/openai-bundled/unified-computer-use'
    candidates=list(root.glob('*/.mcp.json'))
    if not candidates:raise RuntimeError('Local native CUA runtime is not installed')
    cfg=json.loads(max(candidates,key=lambda p:p.stat().st_mtime).read_text())['mcpServers']['cua_repl']
    return [cfg['command'],*cfg['args']],{**os.environ,**cfg.get('env',{})}

def forward(reader,writer,target,on_eof=None):
    def upload():
        try:
            while True:
                data=sys.stdin.buffer.read1(65536)
                if not data:break
                remaining=memoryview(data)
                while remaining:
                    count=writer.write(remaining)
                    if not count:raise OSError("MCP stream closed during write")
                    remaining=remaining[count:]
                writer.flush()
        except (OSError,ValueError):pass
        finally:
            try:writer.close()
            except OSError:pass
            if on_eof is not None:
                try:on_eof()
                except OSError:pass
    threading.Thread(target=upload,daemon=True).start()
    while True:
        line=reader.readline()
        if not line:break
        # Surface actual destination without altering tools, metadata, or approvals.
        try:
            v=json.loads(line);r=v.get('result')
            if isinstance(r,dict) and 'serverInfo' in r and 'protocolVersion' in r:
                r['instructions']=r.get('instructions','')+'\nNative CUA routing: this connection controls '+target+'. The destination is pinned until reconnection. Do not switch machines or replay actions after a disconnect.'
                line=(json.dumps(v)+'\n').encode()
        except (ValueError,TypeError):pass
        sys.stdout.buffer.write(line);sys.stdout.buffer.flush()

def main():
    def stop(*_):raise SystemExit(0)
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    a=argparse.ArgumentParser();a.add_argument('--socket',default=os.environ.get('DEVTOOLS_NATIVE_BROWSER_SOCKET', str(Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'run/mac-native-browser.sock')));a.add_argument('--check',action='store_true');args=a.parse_args()
    available=mac_available(args.socket)
    if args.check:print('mac' if available else 'local');return
    s=None;p=None
    if available:
        try:s=socket.socket(socket.AF_UNIX);s.settimeout(3);s.connect(args.socket);s.settimeout(None)
        except OSError:
            if s:s.close()
            s=None
    try:
        if s is not None:
            print('Native CUA destination: Mac Chrome (SSH relay)',file=sys.stderr)
            forward(s.makefile('rb'),s.makefile('wb'),'Chrome on the Mac through the SSH relay',lambda:s.shutdown(socket.SHUT_WR))
        else:
            cmd,env=local_runtime();p=subprocess.Popen(cmd,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,bufsize=0)
            print('Native CUA destination: local native runtime (Mac unavailable)',file=sys.stderr)
            forward(p.stdout,p.stdin,'the local native browser runtime')
    finally:
        if s:s.close()
        if p is not None:
            if p.poll() is None:p.terminate()
            try:p.wait(timeout=3)
            except subprocess.TimeoutExpired:p.kill();p.wait()
if __name__=='__main__':main()
