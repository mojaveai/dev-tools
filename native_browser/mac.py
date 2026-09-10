"""Install or run a user-owned Mac native-browser relay to an SSH agent host."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import signal
import socket
import subprocess
import sys
import time

LABEL_PREFIX='ai.mojave.dev-tools.native-browser.'

def ssh(host, command, **kwargs):
    return subprocess.run(['ssh','-x','-o','BatchMode=yes','-o','ConnectTimeout=10',host,command], **kwargs)

def remote_identity(host):
    script="import os,json,pathlib; print(json.dumps({'home':str(pathlib.Path.home()),'uid':os.getuid(),'gid':os.getgid(),'codex_home':os.environ.get('CODEX_HOME',str(pathlib.Path.home()/'.codex'))}))"
    r=ssh(host,'python3 -c '+shlex.quote(script),capture_output=True,text=True,check=True)
    return json.loads(r.stdout)

def install(host, repair_root_socket=False):
    if sys.platform!='darwin':raise RuntimeError('Run install-mac on the Mac containing Chrome')
    if not host or host.startswith('-') or any(c.isspace() for c in host):raise ValueError('Use a configured SSH host alias')
    from relay import runtime_config
    runtime_config()  # Fail before installing if native browser runtime is absent.
    identity=remote_identity(host)
    remote_socket=str(Path(identity['codex_home'])/'run/mac-native-browser.sock')
    prepare="import os,pathlib; p=pathlib.Path("+repr(str(Path(remote_socket).parent))+ "); p.mkdir(parents=True,exist_ok=True,mode=0o700)"
    ssh(host,'python3 -c '+shlex.quote(prepare),check=True)
    suffix=hashlib.sha256(host.encode()).hexdigest()[:12]
    label=LABEL_PREFIX+suffix
    root=Path.home()/'.local/share/dev-tools-native-browser'
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    local_socket=str(Path.home()/'.codex/run'/('native-'+suffix+'.sock'))
    for path in (remote_socket,local_socket):
        if len(os.fsencode(path))>=100:raise ValueError('Native socket path too long; use a shorter home/CODEX_HOME')
    settings={'host':host,'remote_socket':remote_socket,'local_socket':local_socket,'uid':identity['uid'],'gid':identity['gid'],'repair_root_socket':repair_root_socket}
    config_path=root/(suffix+'.json')
    from state import atomic_write
    changed=atomic_write(config_path,json.dumps(settings,indent=2)+'\n')
    plist=Path.home()/'Library/LaunchAgents'/(label+'.plist')
    spec={'Label':label,'ProgramArguments':[sys.executable,str(Path(__file__).resolve()),'supervise',str(config_path)],'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,'StandardOutPath':str(root/(suffix+'.log')),'StandardErrorPath':str(root/(suffix+'.err'))}
    data=plistlib.dumps(spec)
    changed=changed or not plist.exists() or plist.read_bytes()!=data
    plist.parent.mkdir(parents=True,exist_ok=True)
    plist.write_bytes(data);plist.chmod(0o600)
    running=subprocess.run(['launchctl','print',f'gui/{os.getuid()}/{label}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    if changed and running:
        subprocess.run(['launchctl','bootout',f'gui/{os.getuid()}',str(plist)],check=True);running=False
    if not running:subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],check=True)
    print(f'Native relay installed for {host}. Keep ChatGPT and Chrome running on this Mac.')
    print(f'LaunchAgent: {plist}')
    print(f'Remote socket: {remote_socket}')
    print('On the agent host, run dev-tools native-browser check to verify Chrome discovery.')

def supervise(config_path):
    cfg=json.loads(Path(config_path).read_text());children=[];running=True
    def stop(*_):
        nonlocal running
        running=False
        for p in children:
            if p.poll() is None:p.terminate()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    def cleanup():
        for p in children:
            if p.poll() is None:p.terminate()
        for p in children:
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill();p.wait()
        children.clear()
    try:
        while running:
            server=subprocess.Popen([sys.executable,str(Path(__file__).with_name('relay.py')),'serve',cfg['local_socket']]);children.append(server)
            for _ in range(100):
                if not running or server.poll() is not None or Path(cfg['local_socket']).exists():break
                time.sleep(.1)
            if not running:break
            if server.poll() is not None:cleanup();time.sleep(5);continue
            # Refuse an already live remote socket: never steal another relay.
            probe="import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(1)\ntry: s.connect("+repr(cfg['remote_socket'])+"); sys.exit(0)\nexcept (FileNotFoundError,ConnectionRefusedError): sys.exit(1)\nexcept OSError: sys.exit(2)"
            if ssh(cfg['host'],'python3 -c '+shlex.quote(probe),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=1:
                print('Remote relay socket is in use or could not be safely checked; stop the previous relay before replacing it.',file=sys.stderr,flush=True)
                cleanup();time.sleep(10);continue
            tunnel=subprocess.Popen(['ssh','-x','-N','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','StreamLocalBindUnlink=yes','-R',cfg['remote_socket']+':'+cfg['local_socket'],cfg['host']]);children.append(tunnel)
            if cfg['repair_root_socket']:
                command='test -S '+shlex.quote(cfg['remote_socket'])+' && sudo -n chown '+shlex.quote(f"{cfg['uid']}:{cfg['gid']}")+' '+shlex.quote(cfg['remote_socket'])
                for _ in range(15):
                    if not running or tunnel.poll() is not None:break
                    if ssh(cfg['host'],command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
                    time.sleep(1)
                else:print('Could not assign the forwarded socket to the agent user; check SSH/sudo setup.',file=sys.stderr,flush=True)
            while running and server.poll() is None and tunnel.poll() is None:time.sleep(1)
            cleanup()
            if running:time.sleep(5)
    finally:stop();cleanup()

def main(argv=None):
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='command',required=True)
    i=sub.add_parser('install-mac');i.add_argument('--ssh-host',required=True);i.add_argument('--repair-root-socket',action='store_true',help='Use sudo to assign root-created reverse sockets to the remote user (Tailscale SSH)')
    s=sub.add_parser('supervise');s.add_argument('config')
    a=p.parse_args(argv)
    if a.command=='install-mac':install(a.ssh_host,a.repair_root_socket)
    else:supervise(a.config)
if __name__=='__main__':main()
