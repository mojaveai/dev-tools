"""Build a reviewable immutable canonical adapter bundle. Does not install or activate."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

SCHEMA = 'agent-trace-dev-canonical-adapter-v1'
BANNER = 'import {createRequire as canonicalCreateRequire,builtinModules as canonicalBuiltins} from "node:module"; const canonicalNativeRequire=canonicalCreateRequire(import.meta.url); const require=id=>{if(!canonicalBuiltins.includes(id)&&!id.startsWith("node:"))throw Error("External dependency forbidden");return canonicalNativeRequire(id);};'
BACKEND_PIN = '47a89c795ff00ba781309f4f862e938f26fab38efbfaa6bb16bbdb002c43894b'

def unit_files(base, python, node):
    common = 'Restart=on-failure\nRestartSec=3\nNoNewPrivileges=yes\nProtectSystem=strict\nPrivateTmp=yes\nUMask=0077\nLimitCORE=0\nTasksMax=64\nMemoryMax=256M\nRestrictAddressFamilies=AF_INET AF_UNIX\n'
    edge = '[Unit]\nDescription=Canonical actual-dev dashboard passkey edge\nAfter=network-online.target agent-trace-dashboard-web.service\n\n[Service]\nUser=agent-trace-dashboard-web\nWorkingDirectory='+base+'\n'+common+'LoadCredential=TLS_CERT:/etc/agent-trace-qa/procbox.crt\nLoadCredential=TLS_KEY:/etc/agent-trace-qa/procbox.key\nExecStart='+python+' -I -B '+base+'/canonical-dashboard-edge.py --config /etc/agent-trace/dev-canonical-passkey.json --tls-cert %d/TLS_CERT --tls-key %d/TLS_KEY\n\n[Install]\nWantedBy=multi-user.target\n'
    bridge = '[Unit]\nDescription=Canonical actual-dev shared browser passkey bridge\nAfter=network-online.target\n\n[Service]\nUser=manbir\nWorkingDirectory='+base+'\n'+common+'Environment=PORTAL_PROFILE=canonical-dev\nEnvironment=HOME=/home/manbir\nEnvironment=NODE_ENV=production\nExecStart='+node+' '+base+'/portal-passkey-bridge.mjs\n\n[Install]\nWantedBy=multi-user.target\n'
    return {'dev-tools-canonical-dashboard-edge.service':edge,'dev-tools-canonical-passkey.service':bridge}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--python',required=True)
    parser.add_argument('--node',required=True)
    parser.add_argument('--allowed-tailnet-user-id',type=int,action='append',required=True)
    parser.add_argument('--ingress-certificate-sha256',required=True,help='Public observed leaf evidence, not a renewal prohibition')
    args=parser.parse_args()
    source=Path(__file__).resolve().parent
    repo=source.parent
    sha=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
    if subprocess.check_output(['git','-C',str(repo),'status','--porcelain'],text=True).strip():raise SystemExit('Build requires a clean reviewed source commit')
    if args.output.exists() or not re.fullmatch('[0-9a-f]{64}',args.ingress_certificate_sha256):raise SystemExit('Fresh output and public SHA256 required')
    if any(v<=0 for v in args.allowed_tailnet_user_id):raise SystemExit('Positive tailnet user IDs required')
    for value in [args.python,args.node]:
        if not re.fullmatch(r'/[A-Za-z0-9_./+-]+',value):raise SystemExit('Absolute interpreter paths required')
    base='/usr/local/lib/dev-tools-shared-browser/canonical/'+sha
    with tempfile.TemporaryDirectory(prefix='canonical-adapter-build-') as temporary:
        staged=Path(temporary)/'source'
        shutil.copytree(source,staged,ignore=shutil.ignore_patterns('node_modules','dist','__pycache__'))
        subprocess.run(['npm','ci','--no-audit','--no-fund'],cwd=staged,check=True)
        subprocess.run(['npm','run','build'],cwd=staged,check=True)
        # Bundle the bridge with all npm dependencies, eliminating mutable module lookup.
        subprocess.run([str(staged/'node_modules/.bin/esbuild'),'portal-passkey-bridge.mjs','--bundle','--platform=node','--format=esm','--packages=bundle','--banner:js='+BANNER,'--outfile=canonical-bridge.mjs'],cwd=staged,check=True)
        args.output.mkdir(parents=True)
        for name in ['canonical-dashboard-edge.py','portal-passkey-hook.js']:
            shutil.copyfile(staged/name,args.output/name)
        shutil.copyfile(staged/'canonical-bridge.mjs',args.output/'portal-passkey-bridge.mjs')
        (args.output/'dist').mkdir()
        for name in ['portal-passkey-client.js','portal-passkey.html']:
            shutil.copyfile(staged/'dist'/name,args.output/'dist'/name)
        subprocess.run(['node',str(args.output/'portal-passkey-bridge.mjs'),'--check-bundle'],check=True)
        config={'schema':'agent-trace-dev-canonical-passkey-config-v1','allowed_tailnet_user_ids':sorted(set(args.allowed_tailnet_user_id))}
        (args.output/'config.json').write_text(json.dumps(config,sort_keys=True,indent=2)+'\n')
        (args.output/'systemd').mkdir()
        for name,value in unit_files(base,args.python,args.node).items():(args.output/'systemd'/name).write_text(value)
        files={str(p.relative_to(args.output)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(args.output.rglob('*')) if p.is_file()}
        manifest={'schema':SCHEMA,'source_sha':sha,'files':files,'public_origin':'https://procbox.agent-trace.ts.net:3581','backend_origin':'https://127.0.0.1:3581','bridge_origin':'http://127.0.0.1:8798','backend_certificate_sha256':BACKEND_PIN,'ingress_certificate_sha256':args.ingress_certificate_sha256,'ingress_certificate_path':'/etc/agent-trace-qa/procbox.crt'}
        (args.output/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
        for p in args.output.rglob('*'):p.chmod(0o555 if p.is_dir() else 0o444)
        args.output.chmod(0o555)
    print(json.dumps({'source_sha':sha,'bundle':str(args.output),'manifest_sha256':hashlib.sha256((args.output/'manifest.json').read_bytes()).hexdigest()}))

if __name__=='__main__':main()
