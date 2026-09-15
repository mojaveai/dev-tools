"""Build secret-free iOS extension resources and optionally Apple's Xcode wrapper."""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import zipfile
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument('--xcode', action='store_true')
parser.add_argument('--site', choices=['https://cryptoagent-1-1.agent-trace.ts.net:3581', 'https://demo.yubico.com'], action='append', help='Repeat to enable specific approved sites; defaults to both sites')
args = parser.parse_args()
sites = args.site or ['https://cryptoagent-1-1.agent-trace.ts.net:3581', 'https://demo.yubico.com']
root = Path(__file__).resolve().parent
output = root / 'local/ios'
resources = output / 'extension'
resources.mkdir(parents=True, exist_ok=True)
for name in ('background.js', 'approval.js', 'viewer.js', 'popup.js', 'popup.html'):
    shutil.copy2(root / 'extension' / name, resources / name)
manifest = json.loads((root / 'extension/manifest.json').read_text())
manifest.update(name='Dev Tools Auth', version='0.6.0', description='Approve your procbox shared browser sign-in with a passkey on this device.')
site_patterns = ['https://' + urlsplit(site).hostname + '/*' for site in sites]
manifest['host_permissions'] = ['https://procbox.agent-trace.ts.net/*', *site_patterns]
manifest['content_scripts'] = [
    {'matches': site_patterns, 'js': ['approval.js'], 'run_at': 'document_idle', 'all_frames': False},
    {'matches': ['https://procbox.agent-trace.ts.net/*'], 'js': ['viewer.js'], 'run_at': 'document_idle', 'all_frames': False},
]
(resources / 'manifest.json').write_text(json.dumps(manifest, indent=2))
(resources / 'config.js').write_text('const AUTH_CONFIG = ' + json.dumps({
    'mobile': True, 'relay': 'https://procbox.agent-trace.ts.net:8443/auth-companion',
    'sites': sites, 'label': 'procbox shared browser',
}) + ';\n')
archive = output / 'Dev-Tools-Auth-iOS.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for file in sorted(resources.iterdir()):
        if file.name in ('manifest.json', 'config.js', 'background.js', 'approval.js', 'viewer.js', 'popup.js', 'popup.html'):
            bundle.write(file, file.name)
print('Secret-free extension archive:', archive)
if args.xcode:
    env = dict(os.environ)
    developer = Path('/Applications/Xcode.app/Contents/Developer')
    if 'DEVELOPER_DIR' not in env and developer.exists():
        env['DEVELOPER_DIR'] = str(developer)
    tool = None
    diagnostic = ''
    for candidate in ('safari-web-extension-packager', 'safari-web-extension-converter'):
        result = subprocess.run(['xcrun', '--find', candidate], capture_output=True, text=True, env=env)
        diagnostic = result.stderr.strip() or diagnostic
        if result.returncode == 0:
            tool = result.stdout.strip()
            break
    if not tool:
        raise SystemExit(diagnostic or 'Install full Xcode and complete its first-run setup, then rerun with --xcode.')
    subprocess.run([tool, str(resources), '--project-location', str(output / 'Xcode'),
        '--app-name', 'Dev Tools Auth', '--bundle-identifier', 'com.mojaveai.devtools.auth',
        '--swift', '--ios-only', '--copy-resources', '--no-open', '--no-prompt'], check=True, env=env)
    # Xcode 27's packager can derive the app ID from the display name while
    # keeping the requested ID for the extension, which fails bundle validation.
    project = output / 'Xcode/Dev Tools Auth/Dev Tools Auth.xcodeproj/project.pbxproj'
    text = project.read_text()
    text = re.sub(r'PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);',
        lambda match: 'PRODUCT_BUNDLE_IDENTIFIER = com.mojaveai.devtools.auth' +
        ('.Extension' if '.Extension' in match.group(1) else '') + ';', text)
    project.write_text(text)
