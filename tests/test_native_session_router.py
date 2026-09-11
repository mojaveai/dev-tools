"""Exercise reconnect decisions, protocol transparency and no-action replay."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'native_browser'))
from session_router import SessionRouter


def call(ident, name='js'):
    return {'jsonrpc':'2.0','id':ident,'method':'tools/call','params':{
        'name':name,'arguments':{'code':'await cua.getState();'} if name=='js' else {},
        '_meta':{'x-codex-turn-metadata':{'session_id':'actual-client-session','turn_id':'actual-client-turn'}}}}


def ready(route):
    return {'route':route,'mac':{'ready':route=='mac','reason':'browser_connected' if route=='mac' else 'no_connected_browser'},
            'local':{'ready':route=='local','reason':'browser_connected' if route=='local' else 'no_connected_browser'}}


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.output=[]
        self.router=SessionRouter('/fixture.sock',Mock(),self.output.append)
        self.backend=Mock(route='local')
        self.router.backend=self.backend
        self.router.initialize_params={'capabilities':{'elicitation':{'form':{}}},'clientInfo':{'name':'real-client','version':'1'}}

    def test_no_browser_then_mac_appears_without_mcp_reconnect(self):
        with patch.object(self.router,'health',return_value=ready(None)):
            self.router.client(call(1))
        self.backend.send.assert_not_called()
        self.assertIsNone(self.router.pinned)
        self.assertTrue(self.output[-1]['result']['isError'])
        mac=Mock(route='mac')
        def connect(route,restore=False):
            self.assertEqual('mac',route); self.assertTrue(restore)
            self.router.backend=mac
        with patch.object(self.router,'health',return_value=ready('mac')),patch.object(self.router,'connect',side_effect=connect):
            request=call(2);self.router.client(request)
        mac.send.assert_called_once_with(request)
        self.assertEqual('mac',self.router.pinned)

    def test_runtime_presence_does_not_claim_local_browser_is_ready(self):
        with patch('session_router.mac_health',return_value={'ready':False,'reason':'relay_socket_missing'}),patch('session_router.local_health',return_value={'ready':False,'reason':'no_connected_browser'}):
            self.assertIsNone(self.router.health()['route'])

    def test_pinned_session_does_not_switch_when_mac_appears(self):
        self.router.pinned='local'
        with patch.object(self.router,'health') as health:
            self.router.client(call(1))
            health.assert_not_called()
        self.backend.send.assert_called_once()

    def test_reset_releases_selection_only_after_native_success(self):
        self.router.pinned='local'
        self.router.client(call(1,'js_reset'))
        self.assertEqual('local',self.router.pinned)
        self.router.downstream(self.backend,{'jsonrpc':'2.0','id':1,'result':{'isError':True,'content':[]}})
        self.assertEqual('local',self.router.pinned)
        self.router.client(call(2,'js_reset'))
        self.router.downstream(self.backend,{'jsonrpc':'2.0','id':2,'result':{'content':[]}})
        self.assertIsNone(self.router.pinned)

    def test_drop_after_dispatch_never_replays_and_requires_reset(self):
        self.router.pinned='local'
        self.router.client(call(1))
        self.router.disconnected(self.backend)
        self.assertTrue(self.router.lost)
        self.assertIn('unknown',self.output[-1]['result']['content'][0]['text'])
        with patch.object(self.router,'health') as health:
            self.router.client(call(2));health.assert_not_called()
        self.backend.send.assert_called_once()
        self.router.client(call(3,'js_reset'))
        self.assertFalse(self.router.lost)
        self.assertFalse(self.output[-1]['result'].get('isError',False))

    def test_late_messages_from_old_runtime_are_ignored(self):
        old=Mock()
        self.router.downstream(old,{'jsonrpc':'2.0','id':1,'result':{'content':[]}})
        self.router.disconnected(old)
        self.assertIs(self.backend,self.router.backend)
        self.assertEqual([],self.output)

    def test_capabilities_metadata_approvals_and_images_survive(self):
        init={'jsonrpc':'2.0','id':1,'method':'initialize','params':copy.deepcopy(self.router.initialize_params)}
        self.router.client(init)
        self.backend.send.assert_called_with(init)
        self.router.downstream(self.backend,{'jsonrpc':'2.0','id':1,'result':{'serverInfo':{},'protocolVersion':'2025-06-18'}})
        self.router.pinned='local'
        request=call(2); self.router.client(request)
        self.backend.send.assert_called_with(request)
        approval={'jsonrpc':'2.0','id':'approval-1','method':'elicitation/create','params':{'message':'Allow?'}}
        self.router.downstream(self.backend,approval);self.assertEqual(approval,self.output[-1])
        cancellation={'jsonrpc':'2.0','id':'approval-1','result':{'action':'cancel'}}
        self.router.client(cancellation);self.backend.send.assert_called_with(cancellation)
        image={'type':'image','data':'a'*150000,'mimeType':'image/png'}
        self.router.downstream(self.backend,{'jsonrpc':'2.0','id':2,'result':{'content':[image]}})
        self.assertEqual(image,self.output[-1]['result']['content'][1])
        self.assertEqual({},self.router.pending)

    def test_no_switch_while_another_request_is_pending(self):
        self.router.pending[1]={'method':'tools/list','id':1}
        with patch.object(self.router,'health') as health:
            self.router.client(call(2));health.assert_not_called()
        self.backend.send.assert_not_called()

    def test_tools_remain_discoverable_after_backend_disconnect(self):
        self.router.tools={'tools':[{'name':'js'}]}
        self.router.backend=None
        self.router.client({'jsonrpc':'2.0','id':3,'method':'tools/list'})
        self.assertEqual(self.router.tools,self.output[-1]['result'])

    def test_failed_new_initialization_does_not_dispatch_js(self):
        with patch.object(self.router,'health',return_value=ready('mac')),patch.object(self.router,'connect',side_effect=RuntimeError('closed')):
            self.router.client(call(1))
        self.backend.send.assert_not_called()
        self.assertIsNone(self.router.pinned)


if __name__=='__main__':unittest.main()
