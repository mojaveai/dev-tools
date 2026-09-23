"""Owned loopback TLS fixture; never contacts the deployed app or browser."""
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('edge',Path(__file__).parents[1]/'canonical-dashboard-edge.py')
e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)

class TLSFixture(unittest.TestCase):
    def test_large_stream_and_cookie_forwarding_with_verified_tls(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);cert=root/'cert.pem';key=root/'key.pem'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(cert,key)
            client_tls=ssl.create_default_context(cafile=str(cert))
            class Backend(BaseHTTPRequestHandler):
                def log_message(self,*_):pass
                def do_POST(self):
                    remaining=int(self.headers['Content-Length']);digest=hashlib.sha256();total=remaining
                    while remaining:
                        block=self.rfile.read(min(65536,remaining));digest.update(block);remaining-=len(block)
                    result=json.dumps({'bytes':total,'sha256':digest.hexdigest(),'origin':self.headers['Origin']}).encode()
                    self.send_response(200);self.send_header('Content-Length',str(len(result)))
                    self.send_header('Set-Cookie','one=fixture; Secure');self.send_header('Set-Cookie','two=fixture; Secure')
                    self.end_headers();self.wfile.write(result)
                def do_HEAD(self):
                    self.send_response(200);self.send_header('Content-Length','1234');self.end_headers()
            class BackendServer(ThreadingHTTPServer):
                def handle_error(self,*_):pass # Expected peer close on rejected TLS pin.
            backend=BackendServer(('127.0.0.1',0),Backend)
            backend.socket=tls.wrap_socket(backend.socket,server_side=True)
            class TestEdge(e.Server):
                def get_request(self):
                    sock,_=super().get_request();return sock,('100.64.0.1',123)
            edge=TestEdge(('127.0.0.1',0),e.Handler)
            edge.allowed=[42];edge.slots=threading.BoundedSemaphore(32);edge.tls=tls;edge.upstream_tls=client_tls
            for server in [backend,edge]:threading.Thread(target=server.serve_forever,daemon=True).start()
            try:
                pin=hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
                with patch.object(e,'BACKEND',backend.server_address),patch.object(e,'PIN',pin),patch.object(e.subprocess,'check_output',return_value=b'{"UserProfile":{"ID":42}}'):
                    body=b'x'*(33*1024*1024)
                    connection=http.client.HTTPSConnection(*edge.server_address,context=client_tls,timeout=10)
                    connection.request('POST','/fixture',body,{'Host':e.HOST,'Origin':'https://'+e.HOST})
                    response=connection.getresponse();result=json.loads(response.read())
                    self.assertEqual(response.status,200);self.assertEqual(result['bytes'],len(body))
                    self.assertEqual(result['sha256'],hashlib.sha256(body).hexdigest())
                    self.assertEqual(result['origin'],'https://'+e.HOST)
                    self.assertEqual([v for k,v in response.getheaders() if k.lower()=='set-cookie'],['one=fixture; Secure','two=fixture; Secure'])
                    connection.close()
                    connection=http.client.HTTPSConnection(*edge.server_address,context=client_tls,timeout=10)
                    connection.request('HEAD','/fixture',headers={'Host':e.HOST})
                    response=connection.getresponse();self.assertEqual(response.getheader('Content-Length'),'1234');self.assertEqual(response.read(),b'');connection.close()
                    with patch.object(e,'PIN','0'*64):
                        connection=http.client.HTTPSConnection(*edge.server_address,context=client_tls,timeout=10)
                        connection.request('HEAD','/fixture',headers={'Host':e.HOST})
                        self.assertEqual(connection.getresponse().status,502);connection.close()
            finally:
                for server in [edge,backend]:server.shutdown();server.server_close()

if __name__=='__main__':unittest.main()
