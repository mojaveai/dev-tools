"""Native routing/migration contracts; no real browser, auth or host mutations."""
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import tomllib
import unittest
from unittest.mock import patch

REPO=Path(__file__).resolve().parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,REPO/'native_browser'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
sys.path.insert(0, str(REPO/'native_browser'))
cfg=load('native_config','configure.py');r=load('native_router','router.py');relay=load('native_relay','relay.py')
repair=load('native_repair','repair.py')

class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.codex=self.root/'config.toml';self.claude=self.root/'claude.json'
    def tearDown(self):self.tmp.cleanup()
    def test_upgrade_preserves_credentials_comments_and_unrelated_servers(self):
        self.codex.write_text('''# Keep this comment
model = "example"
[mcp_servers.other]
command = "other"
[mcp_servers."dev-tools-browser"]
command = "old"
[mcp_servers."dev-tools-browser".env]
SAMPLE = "preserve elsewhere only"
[mcp_servers.dev-tools-mac-browser]
command = "old-mac"
[plugins."unified-computer-use@openai-bundled"]
enabled = true
[plugins."unified-computer-use@openai-bundled".mcp_servers.cua_repl]
startup_timeout_sec = 99
''')
        self.claude.write_text(json.dumps({'oauthAccount':{'fixture':'unchanged'},'mcpServers':{'other':{'command':'keep'},'dev-tools-browser':{},'dev-tools-mac-browser':{}}}))
        self.assertTrue(cfg.configure(REPO,self.codex,self.claude))
        c=tomllib.loads(self.codex.read_text());self.assertEqual({'other','cua_repl'},set(c['mcp_servers']))
        self.assertEqual('other',c['mcp_servers']['other']['command']);self.assertIn('# Keep this comment',self.codex.read_text())
        self.assertFalse(c['plugins'][cfg.PLUGIN]['mcp_servers']['cua_repl']['enabled'])
        self.assertTrue(c['plugins'][cfg.PLUGIN]['enabled'])
        self.assertEqual(99,c['plugins'][cfg.PLUGIN]['mcp_servers']['cua_repl']['startup_timeout_sec'])
        self.assertEqual({'oauthAccount':{'fixture':'unchanged'},'mcpServers':{'other':{'command':'keep'}}},json.loads(self.claude.read_text()))
        before=self.codex.read_bytes();self.assertFalse(cfg.configure(REPO,self.codex,self.claude));self.assertEqual(before,self.codex.read_bytes())
    def test_fresh_install_and_custom_socket_survive_rerun(self):
        self.assertTrue(cfg.configure(REPO,self.codex,self.claude,Path('/private/custom.sock')))
        self.assertFalse(cfg.configure(REPO,self.codex,self.claude))
        self.assertFalse(self.claude.exists())
        self.assertIn('/private/custom.sock',tomllib.loads(self.codex.read_text())['mcp_servers']['cua_repl']['args'])
    def test_malformed_configs_leave_both_files_untouched(self):
        for ct,jt in [('[bad','{}'),('[mcp_servers.dev-tools-browser]\ncommand="old"\n','{broken')]:
            self.codex.write_text(ct);self.claude.write_text(jt)
            with self.assertRaises(ValueError):cfg.configure(REPO,self.codex,self.claude)
            self.assertEqual(ct,self.codex.read_text());self.assertEqual(jt,self.claude.read_text())
    def test_unmanaged_native_server_is_not_overwritten(self):
        self.codex.write_text('[mcp_servers.cua_repl]\ncommand="someone-elses-server"\n')
        before=self.codex.read_bytes()
        with self.assertRaises(ValueError):cfg.configure(REPO,self.codex,self.claude)
        self.assertEqual(before,self.codex.read_bytes())
    def test_quoted_headers_and_array_tables_are_preserved(self):
        text='[mcp_servers."dev-tools-browser"] # comment\ncommand="old"\n[[hooks.Stop]]\nmatcher="x"\n'
        self.codex.write_text(text);cfg.configure(REPO,self.codex,self.claude)
        self.assertEqual([{'matcher':'x'}],tomllib.loads(self.codex.read_text())['hooks']['Stop'])

    def test_automatic_repair_restores_orphaned_plugin_override(self):
        self.codex.write_text('model="keep"\n[mcp_servers.other]\ncommand="keep"\n'
                              '[plugins."unified-computer-use@openai-bundled".mcp_servers.cua_repl]\nenabled=false\n')
        self.assertTrue(repair.repair(REPO,self.codex,self.claude,'/private/custom.sock'))
        parsed=tomllib.loads(self.codex.read_text())
        self.assertEqual('keep',parsed['model'])
        self.assertEqual('keep',parsed['mcp_servers']['other']['command'])
        self.assertIn('/private/custom.sock',parsed['mcp_servers']['cua_repl']['args'])
        before=self.codex.stat().st_mtime_ns
        self.assertFalse(repair.repair(REPO,self.codex,self.claude))
        self.assertEqual(before,self.codex.stat().st_mtime_ns)

    def test_automatic_repair_preserves_disabled_or_custom_registration(self):
        for entry in ['enabled=false\n', 'command="custom"\n']:
            text='[mcp_servers.cua_repl]\n'+entry
            self.codex.write_text(text)
            self.assertFalse(repair.repair(REPO,self.codex,self.claude))
            self.assertEqual(text,self.codex.read_text())

    def test_automatic_repair_refuses_malformed_config(self):
        self.codex.write_text('[broken')
        with self.assertRaises(ValueError):repair.repair(REPO,self.codex,self.claude)
        self.assertEqual('[broken',self.codex.read_text())

    def test_installed_watcher_persists_custom_config_and_socket(self):
        units=self.root/'units'
        with patch.object(repair.subprocess,'run') as run:
            self.assertTrue(repair.install(REPO,self.codex,self.claude,units,'/custom/browser.sock'))
            self.assertFalse(repair.install(REPO,self.codex,self.claude,units,'/custom/browser.sock'))
        service=(units/(repair.UNIT+'.service')).read_text()
        self.assertIn(str(self.codex),service)
        self.assertIn('/custom/browser.sock',service)
        self.assertIn('PathChanged='+str(self.codex)+'\n',(units/(repair.UNIT+'.path')).read_text())
        self.assertNotIn('PathChanged='+str(self.codex.parent)+'\n',(units/(repair.UNIT+'.path')).read_text())
        self.assertTrue(any(call.args[0]==['systemctl','--user','enable',repair.UNIT+'.service'] for call in run.call_args_list))

class RoutingTests(unittest.TestCase):
    def fake_peer(self,path,browsers=None,stall=False):
        server=socket.socket(socket.AF_UNIX);server.bind(path);server.listen()
        def serve():
            conn,_=server.accept()
            try:
                if stall:time.sleep(.25);return
                f=conn.makefile('rwb',buffering=0)
                while line:=f.readline():
                    v=json.loads(line)
                    if v.get('method')=='initialize':result={'protocolVersion':'2024-11-05','serverInfo':{'name':'fixture','version':'1'},'capabilities':{}}
                    elif v.get('method')=='tools/call':
                        self.assertEqual('await cua.listBrowsers();',v['params']['arguments']['code'])
                        result={'content':[{'type':'text','text':json.dumps(browsers)}]}
                    else:continue
                    f.write((json.dumps({'jsonrpc':'2.0','id':v['id'],'result':result})+'\n').encode())
            finally:conn.close();server.close()
        t=threading.Thread(target=serve,daemon=True);t.start();return t
    def test_mac_probe_requires_connected_chrome(self):
        for browsers,expected in [([{'family':'chrome','type':'extension'}],True),([],False),([{'type':'iab'}],False)]:
            with tempfile.TemporaryDirectory() as d:
                path=d+'/s';t=self.fake_peer(path,browsers)
                self.assertEqual(expected,r.mac_available(path));t.join(1)
    def test_dead_and_hung_tunnels_fall_back_with_deadline(self):
        self.assertFalse(r.mac_available('/nonexistent-native-test.sock',.1))
        with tempfile.TemporaryDirectory() as d:
            t=self.fake_peer(d+'/s',stall=True);start=time.monotonic()
            self.assertFalse(r.mac_available(d+'/s',.1));self.assertLess(time.monotonic()-start,.5);t.join(1)
    def test_relay_handles_partial_pipe_writes(self):
        class PartialWriter(io.BytesIO):
            def write(self, data):return super().write(data[:17])
        out=PartialWriter();payload=b'large MCP payload'*10000
        relay.pump(io.BytesIO(payload),out)
        self.assertEqual(payload,out.getvalue())



remote=load('native_remote','remote_session.py')
class RecoveryTests(unittest.TestCase):
    def test_stale_live_listener_is_replaced_and_owner_is_enforced(self):
        with tempfile.TemporaryDirectory() as d:
            endpoint=Path(d)/'browser.sock'; generation=Path(d)/'new.sock'
            old=socket.socket(socket.AF_UNIX);new=socket.socket(socket.AF_UNIX)
            try:
                old.bind(str(endpoint));old.listen();new.bind(str(generation));new.listen()
                Path(str(endpoint)+'.owner').write_text('mine')
                cfg={'remote_socket':str(endpoint),'generation':str(generation),'owner':'other','repair_root_socket':False}
                with self.assertRaises(RuntimeError):remote.publish(cfg)
                self.assertFalse(endpoint.is_symlink())
                cfg['owner']='mine';remote.publish(cfg)
                self.assertEqual(generation.name,os.readlink(endpoint))
                client=socket.socket(socket.AF_UNIX);client.connect(str(endpoint));client.close()
            finally:old.close();new.close()
    def test_old_session_cleanup_preserves_new_generation(self):
        with tempfile.TemporaryDirectory() as d:
            endpoint=Path(d)/'browser.sock'; generation=Path(d)/'new.sock';latest=Path(d)/'latest.sock'
            listener=socket.socket(socket.AF_UNIX)
            try:
                listener.bind(str(generation));listener.listen()
                Path(str(endpoint)+'.owner').write_text('mine')
                cfg={'remote_socket':str(endpoint),'generation':str(generation),'owner':'mine','repair_root_socket':False}
                def disconnected(*args):
                    endpoint.unlink();endpoint.symlink_to(latest.name)
                    return [],[],[]
                with patch.object(remote.select,'select',side_effect=disconnected):remote.run(cfg)
                self.assertEqual(latest.name,os.readlink(endpoint));self.assertFalse(generation.exists())
            finally:listener.close()

if __name__=='__main__':unittest.main()
