"""Build this Mac's passkey approval extensions and retire the old Mac relay.

Each dev-tools host now runs its own relay inside the shared browser, reached
through its Tailscale viewer, so the Mac needs only the Chrome and Safari
extensions. They share the fleet key that the deployment gives every host.
"""
import importlib.util
import os
from pathlib import Path
import plistlib
import re
import secrets
import subprocess

SOURCE = Path(__file__).resolve().parent
KEY = Path(os.environ.get('DEVTOOLS_AUTH_FLEET_KEY', Path.home()/'.config/dev-tools/auth-fleet.key'))
CHROME = Path.home()/'.local/share/dev-tools-chrome-auth/extension'
SAFARI = Path.home()/'.local/share/dev-tools-safari-auth/local/extension'
AGENTS = Path.home()/'Library/LaunchAgents'
DASHBOARD = 'cryptoagent-1-1.agent-trace.ts.net'


def fleet_key():
    # The controller Mac owns the key; the deployment copies it to every host.
    if not KEY.exists():
        KEY.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(KEY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(secrets.token_hex(32)+'\n')
    value = KEY.read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', value):
        raise SystemExit(f'Invalid fleet key at {KEY}')
    return value


def launch_agent(label, program=None):
    domain = f'gui/{os.getuid()}'
    target = AGENTS/(label+'.plist')
    subprocess.run(['launchctl', 'bootout', domain+'/'+label], capture_output=True)
    if program is None:
        target.unlink(missing_ok=True)
        return
    log = SAFARI.parent/(label+'.log')
    target.write_bytes(plistlib.dumps({'Label': label, 'ProgramArguments': program, 'RunAtLoad': True,
                                       'KeepAlive': True, 'ThrottleInterval': 10,
                                       'StandardOutPath': str(log), 'StandardErrorPath': str(log)}))
    subprocess.run(['launchctl', 'bootstrap', domain, str(target)], check=True)


def main():
    spec = importlib.util.spec_from_file_location('build_extensions', SOURCE/'build-extensions.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    key = fleet_key()
    builder.build(SOURCE, key, CHROME, 'chrome')
    builder.build(SOURCE, key, SAFARI, 'safari')
    # Hosts no longer reach a relay on this Mac.
    launch_agent('com.dev-tools.auth-companion')
    # The cryptoagent dashboard is reachable from this Mac only through procbox;
    # keep that forward while /etc/hosts points the dashboard at loopback.
    hosts = Path('/etc/hosts').read_text(errors='replace')
    if re.search(r'^\s*127\.0\.0\.1\s+'+re.escape(DASHBOARD)+r'\b', hosts, re.M):
        launch_agent('com.dev-tools.auth-tunnel', ['/usr/bin/ssh', '-NT', '-o', 'BatchMode=yes',
                     '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
                     '-L', f'127.0.0.1:3581:{DASHBOARD}:3581', 'procbox'])
    else:
        launch_agent('com.dev-tools.auth-tunnel')
    print('Chrome extension:', CHROME)
    print('Safari extension:', SAFARI)


if __name__ == '__main__':
    main()
