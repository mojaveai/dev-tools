"""Fault injection for path pauses and tunnel replacement without a browser."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'native_browser'))
from session_router import SessionRouter

class RecoveryTests(unittest.TestCase):
    def test_transient_discovery_recovers_without_local_fallback(self):
        router=SessionRouter('/missing',Mock(),Mock())
        with patch('session_router.mac_health',side_effect=[{'ready':False,'reason':'discovery_timeout'},{'ready':True,'reason':'browser_connected'}]) as probe, patch('session_router.local_health') as local, patch('session_router.time.sleep'):
            self.assertEqual('ready',router.health()['state'])
            self.assertEqual(2,probe.call_count)
            local.assert_not_called()

    def test_timeout_is_unconfirmed_not_browser_absent(self):
        router=SessionRouter('/missing',Mock(),Mock())
        with patch('session_router.mac_health',return_value={'ready':False,'reason':'discovery_timeout'}),patch('session_router.local_health',return_value={'ready':False,'reason':'no_connected_browser'}),patch('session_router.time.sleep'):
            self.assertEqual('unconfirmed',router.health()['state'])

    def test_idle_disconnect_does_not_claim_uncertain_action(self):
        output=[];router=SessionRouter('/missing',Mock(),output.append)
        backend=Mock();router.backend=backend;router.pinned='mac'
        router.disconnected(backend)
        router.client({'id':1,'method':'tools/call','params':{'name':'js'}})
        self.assertIn('while idle',output[-1]['result']['content'][0]['text'])
        backend.send.assert_not_called()

    def test_twenty_second_pause_survives_and_failed_tunnel_keeps_relay(self):
        with tempfile.TemporaryDirectory(prefix='nb-',dir='/tmp') as directory:
            root=Path(directory);fake=root/'ssh'
            fake.write_text('#!'+sys.executable+'\nimport sys,time\nfirst=True\nwhile sys.stdin.buffer.read(1):\n if first: time.sleep(20);first=False\n sys.stdout.buffer.write(b".");sys.stdout.buffer.flush()\n')
            fake.chmod(0o700)
            config=root/'config.json';config.write_text(json.dumps({'local_socket':str(root/'local.sock'),'remote_socket':'/tmp/remote.sock','host':'fixture'}))
            log=root/'events'
            with log.open('w') as stream:
                child=subprocess.Popen([sys.executable,str(ROOT/'native_browser/mac.py'),'supervise',str(config)],env={**os.environ,'PATH':str(root)+os.pathsep+os.environ['PATH']},stderr=stream)
                def events():
                    return [json.loads(line) for line in log.read_text().splitlines() if line.startswith('{')]
                def wait_for(name,count=1):
                    deadline=time.monotonic()+30
                    while time.monotonic()<deadline:
                        found=[e for e in events() if e['event']==name]
                        if len(found)>=count:return found[-1]
                        time.sleep(.1)
                    self.fail(log.read_text())
                try:
                    wait_for('tunnel_connected')
                    self.assertEqual(1,len([e for e in events() if e['event']=='tunnel_connecting']))
                    relay_pid=wait_for('relay_started')['pid']
                    # Kill only the fake SSH child, leaving the relay process alive.
                    import signal
                    pids=subprocess.check_output(['pgrep','-P',str(child.pid)],text=True).split()
                    for pid in pids:
                        if int(pid)!=relay_pid:os.kill(int(pid),signal.SIGTERM)
                    wait_for('tunnel_connecting',2)
                    os.kill(relay_pid,0)
                    self.assertEqual(1,len([e for e in events() if e['event']=='relay_started']))
                finally:
                    child.terminate();child.wait(timeout=10)

if __name__=='__main__':unittest.main()
