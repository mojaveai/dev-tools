"""Canonical dev-only same-origin passkey edge; never substitutes the QA app."""
import argparse
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import re
from pathlib import Path
import ssl
import subprocess
import threading

HOST = 'procbox.agent-trace.ts.net:3581'
BIND = ('100.89.85.103', 3581)
BACKEND = ('127.0.0.1', 3581)
BRIDGE = ('127.0.0.1', 8798)
PREFIX = '/_shared-browser-passkey/'
PIN = '47a89c795ff00ba781309f4f862e938f26fab38efbfaa6bb16bbdb002c43894b'
CERT_ROOT = Path('/data/agent-trace-live-dev/stack/certs')
HOP = {'connection', 'transfer-encoding', 'keep-alive', 'proxy-authenticate',
       'proxy-authorization', 'te', 'trailer', 'upgrade', 'content-length'}


def configuration(value):
    if (not isinstance(value, dict) or set(value) != {'schema', 'allowed_tailnet_user_ids'}
            or value['schema'] != 'agent-trace-dev-canonical-passkey-config-v1'
            or not isinstance(value['allowed_tailnet_user_ids'], list)
            or not value['allowed_tailnet_user_ids']
            or any(type(v) is not int or v <= 0 for v in value['allowed_tailnet_user_ids'])):
        raise ValueError('invalid canonical dev edge configuration')
    return value


def admit(peer, host_values, allowed, whois):
    if host_values != [HOST]:
        raise PermissionError('wrong canonical host')
    address = ipaddress.ip_address(peer)
    if address not in ipaddress.ip_network('100.64.0.0/10'):
        raise PermissionError('tailnet peer required')
    identity = whois(str(address))['UserProfile']['ID']
    if type(identity) is not int or identity not in allowed:
        raise PermissionError('tailnet user not admitted')


def body_length(headers, helper):
    lengths = headers.get_all('Content-Length', [])
    if headers.get_all('Transfer-Encoding') or len(lengths) > 1:
        raise ValueError('ambiguous request framing')
    if lengths and not re.fullmatch(r'[0-9]+', lengths[0]):
        raise ValueError('invalid content length')
    size = int(lengths[0]) if lengths else 0
    if size < 0 or size > (100000 if helper else 256000000):
        raise ValueError('request size exceeded')
    return size


def verify_pin(der):
    if hashlib.sha256(der).hexdigest() != PIN:
        raise ValueError('canonical backend certificate pin mismatch')


class LimitedBody:
    """Stream exactly Content-Length bytes, never the next request."""
    def __init__(self, source, remaining):
        self.source, self.remaining = source, remaining
    def read(self, size=65536):
        if not self.remaining:
            return b''
        data = self.source.read(min(size, 65536, self.remaining))
        if not data:
            raise ValueError('incomplete request body')
        self.remaining -= len(data)
        return data


class Server(ThreadingHTTPServer):
    daemon_threads = True
    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def finish_request(self, request, address):
        request.settimeout(10)
        try:
            with self.tls.wrap_socket(request, server_side=True) as connection:
                self.RequestHandlerClass(connection, address, self)
        except (ssl.SSLError, OSError):
            pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log URLs containing pending handoff identifiers or bodies.

    def handle_proxy(self):
        upstream, sent = None, False
        try:
            def whois(address):
                return json.loads(subprocess.check_output(
                    ['/usr/bin/tailscale', 'whois', '--json', address],
                    timeout=5, stderr=subprocess.DEVNULL))
            admit(self.client_address[0], self.headers.get_all('Host', []),
                  self.server.allowed, whois)
            if not self.path.startswith('/') or self.path.startswith('//') or '\\' in self.path:
                raise ValueError('invalid request target')
            helper = self.path.startswith(PREFIX)
            if helper and self.command not in ('GET', 'POST'):
                raise PermissionError('unsupported helper method')
            size = body_length(self.headers, helper)
            body = self.rfile.read(size) if helper else LimitedBody(self.rfile, size)
            if helper and len(body) != size:
                raise ValueError('incomplete request body')
            removed = HOP | {h.strip().lower() for h in self.headers.get('Connection', '').split(',')}
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in removed | {'host', 'x-shared-browser-edge'}
                       and not k.lower().startswith(('x-forwarded-', 'cf-'))}
            headers.update({'Host': HOST, 'Content-Length': str(size)})
            if helper:
                headers['X-Shared-Browser-Edge'] = 'canonical-dev-dashboard'
                upstream = http.client.HTTPConnection(*BRIDGE, timeout=10)
            else:
                upstream = http.client.HTTPSConnection(*BACKEND, context=self.server.upstream_tls, timeout=660)
                upstream.connect()
                verify_pin(upstream.sock.getpeercert(binary_form=True))
            upstream.request(self.command, self.path, body=body, headers=headers)
            response = upstream.getresponse()
            if not helper and body.remaining:
                raise ValueError('incomplete upstream request')
            data = response.read(500001) if helper else None
            if helper and len(data) > 500000:
                raise ValueError('helper response too large')
            content_length = response.getheader('Content-Length')
            if content_length is not None and not re.fullmatch(r'[0-9]+', content_length):
                raise ValueError('invalid upstream content length')
            if helper and self.command != 'HEAD':
                content_length = str(len(data))
            self.send_response(response.status)
            sent = True
            removed = HOP | {h.strip().lower() for h in response.getheader('Connection', '').split(',')}
            for key, value in response.getheaders():
                if key.lower() not in removed:
                    self.send_header(key, value)
            if content_length is not None:
                self.send_header('Content-Length', content_length)
            self.end_headers()
            if self.command != 'HEAD':
                if helper:
                    self.wfile.write(data)
                else:
                    while True:
                        chunk = response.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
        except Exception as error:
            if not sent:
                data = b'{"error":"Canonical dev edge unavailable"}'
                self.send_response(403 if isinstance(error, PermissionError) else 502)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        finally:
            if upstream is not None:
                upstream.close()
            self.close_connection = True

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = handle_proxy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--tls-cert', type=Path, required=True)
    parser.add_argument('--tls-key', type=Path, required=True)
    args = parser.parse_args()
    config = configuration(json.loads(args.config.read_text()))
    certificate = CERT_ROOT / 'dashboard-web-server-cert.pem'
    verify_pin(ssl.PEM_cert_to_DER_cert(certificate.read_text()))
    server = Server(BIND, Handler)
    server.allowed = config['allowed_tailnet_user_ids']
    server.slots = threading.BoundedSemaphore(32)
    server.upstream_tls = ssl.create_default_context(cafile=str(CERT_ROOT / 'dashboard-web-ca.pem'))
    server.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.tls.minimum_version = ssl.TLSVersion.TLSv1_2
    server.tls.load_cert_chain(args.tls_cert, args.tls_key)
    server.serve_forever()


if __name__ == '__main__':
    main()
