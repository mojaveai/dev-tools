"""Container service lifecycle and safe viewer publication contracts."""
import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'shared_browser' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


services, publication = load('services'), load('publish')


class InstallTests(unittest.TestCase):
    def test_provisioner_defaults_to_shared_browser(self):
        with tempfile.TemporaryDirectory() as temp:
            repo=Path(temp); (repo/'lib').mkdir(); (repo/'bin').mkdir()
            shutil.copy(ROOT/'lib/common.sh', repo/'lib/common.sh')
            names='base mosh tmux tailscale passcli secrets shell github claude codex keymaps desktop_shell skills sshid uv ripgrep g2 shared_browser native_browser browser'.split()
            (repo/'lib/01-fixture.sh').write_text('\n'.join(
                'mod_'+name+'() { echo '+name+' >> "$CALLS"; }' for name in names))
            (repo/'bin/uname').write_text('#!/bin/sh\ncase "$1" in -s) echo Linux;; *) echo x86_64;; esac\n')
            (repo/'bin/uname').chmod(0o755)
            log=repo/'calls'
            env=dict(os.environ, REPO_DIR=str(repo), CALLS=str(log),
                     PATH=str(repo/'bin')+os.pathsep+os.environ['PATH'], DEVTOOLS_BROWSER_ENABLED='0')
            result=subprocess.run(['sh',str(ROOT/'provision.sh'),'--non-interactive'],
                                  env=env,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            calls=log.read_text().splitlines()
            self.assertIn('shared_browser',calls)
            self.assertNotIn('native_browser',calls)
            self.assertNotIn('browser',calls)

    def test_private_supervisor_and_independent_browser(self):
        config = services.configuration('/state', '/runtime', '/node', '/chrome',
                                        'https://host:8443', 'owner@example.test', '/Xvfb', 'native')
        self.assertIn('chmod=0700', config)
        self.assertIn('umask=0077', config)
        self.assertNotIn('inet_http_server', config)
        self.assertIn('--no-fork /state/browser-host.lock', config)
        self.assertIn('[program:chrome]', config)
        self.assertIn('[program:receiver]', config)
        self.assertIn('[program:registration]', config)
        self.assertIn('autorestart=true', config)

    def test_supervisor_attaches_to_existing_chrome_without_launching_a_host(self):
        with patch.dict(os.environ, {'SHARED_BROWSER_CDP_PORT_FILE': '/desktop/DevToolsActivePort'}):
            config = services.configuration('/state', '/runtime', '/node', '',
                                            'https://host:8443', 'owner@example.test', '', 'attached')
        self.assertIn('/runtime/attach-external-chrome.sh', config)
        self.assertIn('SHARED_BROWSER_CDP_PORT_FILE="/desktop/DevToolsActivePort"', config)
        self.assertIn('SHARED_BROWSER_NODE="/node"', config)
        self.assertNotIn('[program:chrome]', config)

    def test_update_restarts_receiver_only(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            with patch.object(services, 'start') as start, patch.object(services, 'control') as control:
                services.install(state, 'fixture')
            start.assert_called_once_with(state)
            self.assertEqual([c.args[1:] for c in control.call_args_list],
                             [('reread',), ('update',), ('restart', 'receiver')])
            self.assertEqual((state / 'supervisor.conf').stat().st_mode & 0o777, 0o600)

    def test_start_reuses_running_supervisor(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            with patch.object(services, 'control', return_value=subprocess.CompletedProcess([], 0)) as control, \
                 patch.object(services.subprocess, 'run') as run:
                services.start(state)
            run.assert_not_called()
            self.assertEqual([c.args[1:] for c in control.call_args_list], [('pid',), ('start', 'all')])

    def test_publish_preserves_occupied_listener(self):
        import json
        for current in ({'TCP': {'8443': {'TCPForward': 'elsewhere:22'}}},
                        {'Web': {'host:8443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:9000'}}}}}):
            calls = []
            def run(args, **kwargs):
                calls.append(args)
                return subprocess.CompletedProcess(args, 0, stdout=json.dumps(current))
            with self.assertRaisesRegex(RuntimeError, 'occupied'):
                publication.publish(run)
            self.assertEqual(len(calls), 1)

    def test_publish_is_idempotent_and_leaves_other_ports(self):
        import json
        for matching in (False, True):
            current = {'TCP': {'443': {'HTTPS': True}}, 'Web': {}}
            if matching:
                current['Web']['host:8443'] = {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:8791'}}}
            calls = []
            def run(args, **kwargs):
                calls.append(args)
                return subprocess.CompletedProcess(args, 0, stdout=json.dumps(current))
            publication.publish(run)
            self.assertEqual(len(calls), 1 if matching else 2)
            if not matching:
                self.assertEqual(calls[1], ['tailscale', 'serve', '--bg', '--https=8443', 'http://127.0.0.1:8791'])


if __name__ == '__main__':
    unittest.main()
