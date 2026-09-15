"""Install the explicitly enabled Mac companion and its loopback-only SSH tunnel."""
import os
import argparse
from pathlib import Path
import plistlib
import json
import secrets
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--site', choices=['https://cryptoagent-1-1.agent-trace.ts.net:3581', 'https://demo.yubico.com'], default='https://cryptoagent-1-1.agent-trace.ts.net:3581')
args = parser.parse_args()
source = Path(__file__).resolve().parent
runtime = Path.home() / '.local/share/dev-tools-safari-auth'
runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(runtime, 0o700)
for item in source.iterdir():
    if item.name in ('local', '.gitignore'):
        continue
    target = runtime / item.name
    if item.is_dir():
        shutil.copytree(item, target, dirs_exist_ok=True)
    else:
        shutil.copy2(item, target)
local = runtime / 'local'
(local / 'extension').mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(local, 0o700)
pairing = local / 'extension/config.js'
if not pairing.exists():
    previous = source / 'local/extension/config.js'
    if previous.exists():
        shutil.copy2(previous, pairing)
    else:
        pairing.write_text('const AUTH_CONFIG = ' + json.dumps({'token': secrets.token_hex(32)}) + ';\n')
    os.chmod(pairing, 0o600)
host_token = local / 'host-token'
if not host_token.exists() and (source / 'local/host-token').exists():
    shutil.copy2(source / 'local/host-token', host_token)
    os.chmod(host_token, 0o600)
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js is required')
env = {'AUTH_SITE': args.site}
subprocess.run([node, str(runtime / 'yubico.mjs')], env={**os.environ, **env, 'AUTH_SETUP_ONLY': '1'}, check=True)
agents = Path.home() / 'Library/LaunchAgents'
agents.mkdir(parents=True, exist_ok=True)
jobs = {
    'com.dev-tools.auth-companion': [node, str(runtime / 'yubico.mjs')],
    'com.dev-tools.auth-tunnel': ['/usr/bin/ssh', '-NT', '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=20',
        '-o', 'ServerAliveCountMax=3',
        '-R', '127.0.0.1:8811:127.0.0.1:8811',
        '-L', '127.0.0.1:3581:cryptoagent-1-1.agent-trace.ts.net:3581', 'procbox'],
}
domain = f'gui/{os.getuid()}'
for label, args in jobs.items():
    config = {'Label': label, 'ProgramArguments': args, 'RunAtLoad': True,
              'KeepAlive': True, 'ThrottleInterval': 10,
              'WorkingDirectory': str(runtime), 'EnvironmentVariables': env,
              'StandardOutPath': str(local / (label + '.log')),
              'StandardErrorPath': str(local / (label + '.error.log'))}
    target = agents / (label + '.plist')
    target.write_bytes(plistlib.dumps(config))
    subprocess.run(['launchctl', 'bootout', domain + '/' + label], capture_output=True)
    subprocess.run(['launchctl', 'bootstrap', domain, str(target)], check=True)
print('Companion installed. Safari extension folder:', local / 'extension')
print('Required local hostname entry: 127.0.0.1 cryptoagent-1-1.agent-trace.ts.net')
