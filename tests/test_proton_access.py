import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('proton_access', ROOT / 'skills/proton-pass/scripts/access.py')
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)


class CredentialSelection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.home_patch = patch.object(access.Path, 'home', return_value=self.home)
        self.home_patch.start()
        self.platform = patch.object(access.sys, 'platform', 'linux')
        self.platform.start()
        self.legacy = self.home / 'legacy.pat'
        self.legacy_patch = patch.object(access, '_PAT_PATH', self.legacy)
        self.legacy_patch.start()
        self.user_session_patch = patch.object(access, '_USER_SESSION_PATH', self.home / 'user-session')
        self.user_session_patch.start()

    def tearDown(self):
        self.user_session_patch.stop()
        self.legacy_patch.stop()
        self.platform.stop()
        self.home_patch.stop()
        self.env.stop()
        self.tmp.cleanup()

    def token(self, path, value='pst_synthetic::testkey'):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        path.chmod(0o600)
        return value

    def test_provisioned_wins_without_shell_environment(self):
        self.token(self.legacy, 'pst_old::testkey')
        expected = self.token(self.home / '.config/dev-tools/proton-pass.pat')
        self.assertEqual(access._read_pat(), expected)

    def test_explicit_path_wins(self):
        path = self.home / 'custom.pat'
        expected = self.token(path)
        os.environ['PROTON_PASS_PERSONAL_ACCESS_TOKEN_FILE'] = str(path)
        self.assertEqual(access._read_pat(), expected)

    def test_missing_explicit_does_not_fall_back(self):
        self.token(self.legacy)
        os.environ['PROTON_PASS_PERSONAL_ACCESS_TOKEN_FILE'] = str(self.home / 'missing')
        with self.assertRaises(access.AccessError):
            access._read_pat()

    def test_legacy_fallback(self):
        self.token(self.legacy)
        self.assertEqual(access._read_pat(), 'pst_synthetic::testkey')

    def test_custom_state_without_shell_pat_variable(self):
        os.environ['DEVTOOLS_STATE_DIR'] = str(self.home / 'custom')
        expected = self.token(self.home / 'custom/proton-pass.pat')
        self.assertEqual(access._read_pat(), expected)

    def test_permissions_and_symlinks_rejected(self):
        path = self.home / '.config/dev-tools/proton-pass.pat'
        self.token(path)
        path.chmod(0o644)
        with self.assertRaises(access.AccessError):
            access._read_pat()
        path.unlink()
        self.token(self.legacy)
        path.symlink_to(self.legacy)
        with self.assertRaises(access.AccessError):
            access._read_pat()

    def test_mac_requires_user_session_or_explicit_override(self):
        with patch.object(access.sys, 'platform', 'darwin'):
            with self.assertRaises(access.AccessError):
                access._read_pat()
            path = self.home / 'explicit.pat'
            self.token(path)
            os.environ['PROTON_PASS_PERSONAL_ACCESS_TOKEN_FILE'] = str(path)
            self.assertEqual(access._read_pat(), 'pst_synthetic::testkey')

    def test_isolated_operation_cleans_store_and_uses_same_session(self):
        sessions = []
        def authenticate(reason):
            sessions.append(access._SESSION_PATH)
            self.assertTrue(access._SESSION_PATH.is_dir())
            self.assertEqual(os.environ['PROTON_PASS_KEY_PROVIDER'], 'fs')
            return 0
        def execute(reason, command):
            self.assertEqual(access._SESSION_PATH, sessions[0])
            return 0
        with patch.object(access, 'authenticate', side_effect=authenticate), patch.object(access, 'execute', side_effect=execute):
            self.assertEqual(access.main(['authenticated-exec', '--reason', 'Test isolated credential use', '--', 'test']), 0)
        self.assertFalse(sessions[0].exists())

    def test_mac_reuses_user_session_without_reading_pat_or_logging_out(self):
        with patch.object(access.sys, 'platform', 'darwin'), \
             patch.object(access, '_USE_USER_SESSION', False), \
             patch.object(access, '_audit'), \
             patch.object(access, '_pass_cli', return_value='pass-cli'), \
             patch.object(access, '_read_pat') as read, \
             patch.object(access.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(access.main(['authenticated-exec', '--reason', 'Verify existing Mac login', '--', 'test']), 0)
            read.assert_not_called()
            self.assertEqual([c.args[0][1] for c in run.call_args_list], ['info', 'test'])
            self.assertEqual(run.call_args.kwargs['env']['PROTON_PASS_SESSION_DIR'], str(self.home / 'user-session'))
            self.assertEqual(run.call_args.kwargs['env']['PROTON_PASS_KEY_PROVIDER'], 'fs')

    def test_mac_unavailable_user_session_never_falls_back_to_pat(self):
        with patch.object(access.sys, 'platform', 'darwin'), \
             patch.object(access, '_USE_USER_SESSION', False), \
             patch.object(access, '_audit'), \
             patch.object(access, '_pass_cli', return_value='pass-cli'), \
             patch.object(access, '_read_pat') as read, \
             patch.object(access.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)) as run:
            self.assertEqual(access.main(['authenticated-exec', '--reason', 'Check Mac user login', '--', 'vault', 'list']), 2)
            read.assert_not_called()
            self.assertEqual([c.args[0][1] for c in run.call_args_list], ['info'])

    def test_unhealthy_user_session_is_never_logged_out(self):
        with patch.object(access, '_USE_USER_SESSION', True), \
             patch.object(access, '_audit'), \
             patch.object(access, '_pass_cli', return_value='pass-cli'), \
             patch.object(access, '_read_pat') as read, \
             patch.object(access.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)) as run:
            self.assertEqual(access.authenticate('Check existing user login'), 1)
            read.assert_not_called()
            self.assertEqual([c.args[0][1] for c in run.call_args_list], ['info'])

    def test_login_verification_works_without_removed_test_command(self):
        with patch.object(access, '_USE_USER_SESSION', False), \
             patch.object(access, '_audit'), \
             patch.object(access, '_pass_cli', return_value='pass-cli'), \
             patch.object(access, '_read_pat', return_value='pst_synthetic::testkey'), \
             patch.object(access.subprocess, 'run', side_effect=[
                 subprocess.CompletedProcess([], 1),
                 subprocess.CompletedProcess([], 0),
                 subprocess.CompletedProcess([], 0),
                 subprocess.CompletedProcess([], 0),
             ]) as run:
            self.assertEqual(access.authenticate('Verify compatible session checks'), 0)
            self.assertEqual([c.args[0][1] for c in run.call_args_list],
                             ['info', 'logout', 'login', 'info'])
            self.assertNotIn('pst_synthetic::testkey', str([c.args for c in run.call_args_list]))


if __name__ == '__main__':
    unittest.main()
