"""Build a locally paired Chrome MV3 client without changing Safari or the relay."""
import argparse
import json
import os
from pathlib import Path
import shutil


def build(source, pairing, output):
    config = pairing.read_text()
    data = json.loads(config.removeprefix('const AUTH_CONFIG = ').strip().removesuffix(';'))
    sites = data.get('sites', [data.get('site')])
    allowed = {'https://cryptoagent-1-1.agent-trace.ts.net:3581', 'https://demo.yubico.com'}
    if not sites or not set(sites) <= allowed or data.get('relay') != 'http://localhost:8811':
        raise ValueError('Expected the paired Mac companion with approved sites')
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output, 0o700)
    for name in ['background.js', 'approval.js', 'viewer.js', 'popup.js', 'popup.html']:
        shutil.copy2(source / 'extension' / name, output / name)
    (output/'config.js').write_text(config)
    os.chmod(output/'config.js', 0o600)
    (output/'worker.js').write_text("importScripts('config.js', 'background.js');\n")
    patterns = ['https://' + site.split('/')[2].split(':')[0] + '/*' for site in sites]
    viewer = 'https://procbox.agent-trace.ts.net/*'
    manifest = dict(manifest_version=3, name='Dev Tools Auth', version='0.7.0',
                    description='Approve procbox shared-browser sign-ins with a local passkey or security key.',
                    minimum_chrome_version='132', permissions=['storage'],
                    host_permissions=['http://localhost/*', viewer, *patterns],
                    background={'service_worker':'worker.js'},
                    action={'default_popup':'popup.html','default_title':'Dev Tools Auth'},
                    content_scripts=[{'matches':patterns,'js':['approval.js'],'run_at':'document_idle','all_frames':False},
                                     {'matches':[viewer],'js':['viewer.js'],'run_at':'document_idle','all_frames':False}])
    (output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    return output


if __name__ == '__main__':
    p=argparse.ArgumentParser()
    runtime=Path.home()/'.local/share/dev-tools-safari-auth'
    p.add_argument('--pairing', type=Path, default=runtime/'local/extension/config.js')
    p.add_argument('--output', type=Path, default=Path.home()/'.local/share/dev-tools-chrome-auth/extension')
    a=p.parse_args()
    print('Chrome extension built:', build(Path(__file__).resolve().parent, a.pairing, a.output))
