"""Add only a same-origin passkey handoff route to the existing QA dashboard edge."""
import http.client
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

source = Path(sys.argv.pop(1))
sys.path.insert(0, str(source.parent))
spec = importlib.util.spec_from_file_location('qa_identity', source)
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)
original_edge = identity.Handler.edge


def edge(self):
    if not self.path.startswith('/_shared-browser-passkey/'):
        return original_edge(self)
    upstream = None
    try:
        if self.server.mode != 'dashboard' or self.headers.get('Host') != 'procbox.agent-trace.ts.net:23581':
            raise PermissionError('Wrong portal')
        def whois(address):
            return json.loads(subprocess.check_output(['/usr/bin/tailscale', 'whois', '--json', address], timeout=5, stderr=subprocess.DEVNULL))
        identity.admitted_identity(self.client_address[0], self.server.config['allowed_tailnet_user_ids'], whois)
        if self.command not in ('GET', 'POST') or self.headers.get('Transfer-Encoding'):
            raise PermissionError('Unsupported request')
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 <= size <= 100000:
            raise ValueError('Request too large')
        body = self.rfile.read(size)
        if len(body) != size:
            raise ValueError('Incomplete request')
        headers = {'X-Shared-Browser-Edge':'qa-dashboard', 'Content-Length':str(size),
                   'Content-Type':self.headers.get('Content-Type', 'application/json'),
                   'Origin':self.headers.get('Origin', '')}
        upstream = http.client.HTTPConnection('127.0.0.1', 8797, timeout=10)
        upstream.request(self.command, self.path, body, headers)
        response = upstream.getresponse()
        data = response.read(500001)
        if len(data) > 500000:
            raise ValueError('Response too large')
        self.send_response(response.status)
        for name, value in response.getheaders():
            if name.lower() not in ('connection', 'transfer-encoding', 'content-length'):
                self.send_header(name, value)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    except PermissionError:
        self.reply(403, b'{"error":"QA access denied"}')
    except Exception:
        self.reply(502, b'{"error":"Passkey handoff unavailable"}')
    finally:
        if upstream is not None:
            upstream.close()


identity.Handler.edge = edge
identity.main()
