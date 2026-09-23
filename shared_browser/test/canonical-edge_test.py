import importlib.util
import io
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('edge', Path(__file__).parents[1] / 'canonical-dashboard-edge.py')
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)

class EdgeTests(unittest.TestCase):
    def test_admission(self):
        whois = lambda _: {'UserProfile': {'ID': 42}}
        e.admit('100.89.85.1', [e.HOST], [42], whois)
        for peer, hosts, ids in [('127.0.0.1',[e.HOST],[42]), ('100.89.85.1',[e.HOST,e.HOST],[42]), ('100.89.85.1',[e.HOST+'.evil'],[42]), ('100.89.85.1',[e.HOST],[43])]:
            with self.assertRaises(PermissionError):e.admit(peer, hosts, ids, whois)

    def test_framing(self):
        for items in [[('Content-Length','1'),('Content-Length','1')],[('Transfer-Encoding','chunked')],[('Content-Length','-1')],[('Content-Length','+1')],[('Content-Length','100001')]]:
            headers=Message()
            for k,v in items:headers[k]=v
            with self.assertRaises(ValueError):e.body_length(headers,True)
        headers=Message();headers['Content-Length']='123'
        self.assertEqual(e.body_length(headers,False),123)

    def test_pin_and_configuration(self):
        with self.assertRaises(ValueError):e.verify_pin(b'wrong certificate')
        valid={'schema':'agent-trace-dev-canonical-passkey-config-v1','allowed_tailnet_user_ids':[42]}
        self.assertEqual(e.configuration(valid),valid)
        for value in [{**valid,'upstream':'https://evil'}, {**valid,'allowed_tailnet_user_ids':[True]}, {**valid,'allowed_tailnet_user_ids':[]}]:
            with self.assertRaises(ValueError):e.configuration(value)

    def test_bounded_stream_never_consumes_next_request(self):
        source=io.BytesIO(b'x'*100000+b'NEXT')
        stream=e.LimitedBody(source,100000)
        self.assertEqual(len(stream.read(999999)),65536)
        self.assertEqual(len(stream.read(999999)),34464)
        self.assertEqual(stream.read(),b'')
        self.assertEqual(source.read(),b'NEXT')
        with self.assertRaises(ValueError):e.LimitedBody(io.BytesIO(b''),1).read()

    def test_actual_handler_preserves_body_cookie_and_origin(self):
        body=b'{"response":{"clientDataJSON":"unaltered-base64"}}'
        class Response:
            status=200
            def __init__(self):self.body=io.BytesIO(b'{"unchanged":true}')
            def read(self,n):return self.body.read(n)
            def getheader(self,k,d=None):return d
            def getheaders(self):return [('Set-Cookie','session=fixture; Secure; HttpOnly'),('Set-Cookie','csrf=fixture; Secure'),('Content-Type','application/json')]
        class Upstream:
            def __init__(self,*args,**kwargs):self.sock=self
            def connect(self):pass
            def getpeercert(self,**kwargs):return b'fixture'
            def request(self,*args,**kwargs):
                body=kwargs['body'];parts=[]
                while chunk:=body.read(8192):parts.append(chunk)
                calls.append((args,{**kwargs,'body':b''.join(parts)}))
            def getresponse(self):return Response()
            def close(self):pass
        class State:allowed=[42];upstream_tls=object()
        handler=object.__new__(e.Handler)
        handler.server=State();handler.client_address=('100.89.85.1',123)
        handler.headers=Message()
        for k,v in [('Host',e.HOST),('Origin','https://'+e.HOST),('Content-Length',str(len(body))),('X-Forwarded-For','spoof'),('X-Shared-Browser-Edge','spoof')]:handler.headers[k]=v
        handler.path='/auth/finish';handler.command='POST';handler.rfile=io.BytesIO(body);handler.wfile=io.BytesIO()
        headers=[];calls=[]
        handler.send_response=lambda status:headers.append(('status',status))
        handler.send_header=lambda k,v:headers.append((k,v))
        handler.end_headers=lambda:None
        with patch.object(e.subprocess,'check_output',return_value=b'{"UserProfile":{"ID":42}}'),patch.object(e.http.client,'HTTPSConnection',Upstream),patch.object(e,'verify_pin') as pin:
            handler.handle_proxy()
        pin.assert_called_once_with(b'fixture')
        self.assertEqual(calls[0][1]['body'],body)
        sent=calls[0][1]['headers']
        self.assertEqual(sent['Host'],e.HOST);self.assertEqual(sent['Origin'],'https://'+e.HOST)
        self.assertNotIn('X-Forwarded-For',sent);self.assertNotIn('X-Shared-Browser-Edge',sent)
        self.assertIn(('Set-Cookie','session=fixture; Secure; HttpOnly'),headers)
        self.assertIn(('Set-Cookie','csrf=fixture; Secure'),headers)
        self.assertEqual(handler.wfile.getvalue(),b'{"unchanged":true}')

if __name__=='__main__':unittest.main()
