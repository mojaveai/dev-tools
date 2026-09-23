"""Exercise a built bridge against an owned disposable blank Chrome, never shared tabs."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--bundle',type=Path,required=True)
p.add_argument('--chrome',default='/usr/bin/google-chrome')
p.add_argument('--node',default='/usr/local/bin/node')
a=p.parse_args()
with tempfile.TemporaryDirectory(prefix='canonical-blank-chrome-') as directory:
    root=Path(directory)
    with (root/'chrome.log').open('wb') as log:
        chrome=subprocess.Popen([a.chrome,'--headless=new','--disable-gpu','--disable-background-networking','--disable-default-apps','--no-first-run','--remote-debugging-port=0','--user-data-dir='+directory,'about:blank'],stdout=log,stderr=log)
        try:
            deadline=time.monotonic()+20
            while not (root/'DevToolsActivePort').exists():
                if chrome.poll() is not None or time.monotonic()>=deadline:raise RuntimeError('Disposable Chrome failed to become ready')
                time.sleep(.1)
            port,path=(root/'DevToolsActivePort').read_text().splitlines()
            if not port.isdecimal() or not path.startswith('/devtools/browser/'):raise RuntimeError('Invalid owned Chrome endpoint')
            subprocess.run([a.node,str(a.bundle/'portal-passkey-bridge.mjs'),'--check-browser-bundle','ws://127.0.0.1:'+port+path],check=True,timeout=20)
            print(json.dumps({'disposable_browser_connection':'passed','shared_browser_contacted':False}))
        finally:
            chrome.terminate()
            try:chrome.wait(timeout=10)
            except subprocess.TimeoutExpired:chrome.kill();chrome.wait(timeout=5)
