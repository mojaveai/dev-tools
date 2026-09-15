"""Build secret-free iOS extension resources and optionally Apple's Xcode wrapper."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--xcode', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parent
output = root / 'local/ios'
resources = output / 'extension'
resources.mkdir(parents=True, exist_ok=True)
for name in ('background.js', 'approval.js', 'viewer.js', 'popup.js', 'popup.html'):
    shutil.copy2(root / 'extension' / name, resources / name)
manifest = json.loads((root / 'extension/manifest.json').read_text())
manifest.update(name='Dev Tools Auth', version='0.5.0', description='Approve your procbox shared browser sign-in with a passkey on this device.')
manifest['host_permissions'] = ['https://procbox.agent-trace.ts.net/*', 'https://cryptoagent-1-1.agent-trace.ts.net/*']
manifest['content_scripts'] = [
    {'matches': ['https://cryptoagent-1-1.agent-trace.ts.net/*'], 'js': ['approval.js'], 'run_at': 'document_idle', 'all_frames': False},
    {'matches': ['https://procbox.agent-trace.ts.net/*'], 'js': ['viewer.js'], 'run_at': 'document_idle', 'all_frames': False},
]
(resources / 'manifest.json').write_text(json.dumps(manifest, indent=2))
(resources / 'config.js').write_text('const AUTH_CONFIG = ' + json.dumps({
    'mobile': True, 'relay': 'https://procbox.agent-trace.ts.net:8443/auth-companion',
    'site': 'https://cryptoagent-1-1.agent-trace.ts.net:3581', 'label': 'procbox shared browser',
}) + ';\n')
archive = output / 'Dev-Tools-Auth-iOS.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for file in sorted(resources.iterdir()):
        if file.name in ('manifest.json', 'config.js', 'background.js', 'approval.js', 'viewer.js', 'popup.js', 'popup.html'):
            bundle.write(file, file.name)
print('Secret-free extension archive:', archive)
if args.xcode:
    tool = None
    for candidate in ('safari-web-extension-packager', 'safari-web-extension-converter'):
        result = subprocess.run(['xcrun', '--find', candidate], capture_output=True, text=True)
        if result.returncode == 0:
            tool = result.stdout.strip()
            break
    if not tool:
        raise SystemExit('Install full Xcode, then rerun with --xcode. Command Line Tools alone are insufficient.')
    subprocess.run([tool, str(resources), '--project-location', str(output / 'Xcode'),
        '--app-name', 'Dev Tools Auth', '--bundle-identifier', 'com.mojaveai.devtools.auth',
        '--swift', '--ios-only', '--copy-resources', '--no-open', '--no-prompt'], check=True)
