"""Build the local passkey approval extensions (Chrome and Safari) from the fleet key."""
import json
import os
from pathlib import Path
import re
import shutil

SCRIPTS = ['background.js', 'approval.js', 'viewer.js', 'popup.js', 'popup.html']


def build(source, key_hex, output, browser):
    if not re.fullmatch(r'[a-f0-9]{64}', key_hex or ''):
        raise ValueError('Expected a 64-character hex fleet key')
    if browser not in ('chrome', 'safari'):
        raise ValueError('browser must be chrome or safari')
    # Rebuild from scratch so no stale relay capability or script survives.
    shutil.rmtree(output, ignore_errors=True)
    output.mkdir(parents=True, mode=0o700)
    os.chmod(output, 0o700)
    for name in SCRIPTS:
        shutil.copy2(source/'extension'/name, output/name)
    config = output/'config.js'
    config.write_text('const AUTH_CONFIG = '+json.dumps({'fleetKey': key_hex})+';\n')
    os.chmod(config, 0o600)
    if browser == 'chrome':
        (output/'worker.js').write_text("importScripts('config.js', 'background.js');\n")
        background = {'service_worker': 'worker.js'}
    else:
        background = {'scripts': ['config.js', 'background.js'], 'persistent': False}
    manifest = dict(
        manifest_version=3, name='Dev Tools Auth', version='1.0.0',
        description='Approve passkey sign-ins for your dev-tools shared browsers.',
        permissions=['storage', 'scripting'],
        # Approval runs on the requesting site's real origin; viewers are Tailscale hosts.
        host_permissions=['https://*/*'],
        background=background,
        action={'default_popup': 'popup.html', 'default_title': 'Dev Tools Auth'},
        content_scripts=[{'matches': ['https://*.ts.net/*'], 'js': ['viewer.js'],
                          'run_at': 'document_idle', 'all_frames': False}])
    if browser == 'chrome':
        manifest['minimum_chrome_version'] = '132'
    (output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    return output
