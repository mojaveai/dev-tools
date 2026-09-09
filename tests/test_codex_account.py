"""Identity boundaries and the no-reauth provisioning contract."""

import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "codex_account", ROOT / "auth/codex_account.py"
)
account = importlib.util.module_from_spec(spec)
spec.loader.exec_module(account)


class AccountTests(unittest.TestCase):
    def test_identity_boundaries(self):
        expected = "owner@example.test"
        for payload, code in [
            (None, account.ABSENT),
            ({"type": "chatgpt", "email": "OWNER@example.test"}, account.MATCH),
            ({"type": "chatgpt", "email": "someone@example.test"}, account.MISMATCH),
            ({"type": "apiKey"}, account.MISMATCH),
            ({"type": "chatgpt", "email": None}, account.UNVERIFIED),
            ({"type": "chatgpt"}, account.UNVERIFIED),
        ]:
            with self.subTest(payload=payload):
                self.assertEqual(account.classify(payload, expected), code)
        for target in ["", "pass://codex/ChatGPT/email", "not-an-email"]:
            self.assertEqual(account.classify(None, target), account.UNVERIFIED)

    def test_missing_target_does_not_start_codex(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(account, "read_account") as read,
        ):
            self.assertEqual(account.main(), account.UNVERIFIED)
            read.assert_not_called()

    def test_explicit_target_wins_over_vault(self):
        with (
            patch.dict(
                os.environ,
                {
                    "DEVTOOLS_CODEX_EXPECTED_EMAIL": "owner@example.test",
                    "DEVTOOLS_CODEX_VAULT_EMAIL": "other@example.test",
                },
                clear=True,
            ),
            patch.object(
                account,
                "read_account",
                return_value={
                    "type": "chatgpt",
                    "email": "other@example.test",
                },
            ),
        ):
            self.assertEqual(account.main(), account.MISMATCH)

    def test_app_server_protocol_and_no_refresh(self):
        with tempfile.TemporaryDirectory() as temp:
            fake = Path(temp) / "codex"
            fake.write_text("""#!/usr/bin/env python3
import json, sys
assert sys.argv[1:] == ['app-server', '--listen', 'stdio://']
a = json.loads(input()); assert a['method'] == 'initialize'
print(json.dumps({'id': a['id'], 'result': {}}), flush=True)
assert json.loads(input())['method'] == 'initialized'
a = json.loads(input()); assert a['method'] == 'account/read'
assert a['params'] == {'refreshToken': False}
print(json.dumps({'method': 'notification', 'params': {}}), flush=True)
print(json.dumps({'id': a['id'], 'result': {'account': {'type': 'chatgpt', 'email': 'owner@example.test'}}}), flush=True)
sys.stdin.read()
""")
            fake.chmod(0o755)
            with patch.dict(
                os.environ, {"PATH": temp + os.pathsep + os.environ["PATH"]}
            ):
                self.assertEqual(account.read_account()["email"], "owner@example.test")
            fake.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(60)\n")
            with (
                patch.dict(
                    os.environ, {"PATH": temp + os.pathsep + os.environ["PATH"]}
                ),
                self.assertRaises((TimeoutError, account.queue.Empty)),
            ):
                account.read_account(timeout=0.1)

    def test_provisioning_reuses_match_and_preserves_mismatch(self):
        # Fake only installation/configuration, exercise the real shell control flow.
        script = """
. "$REPO_DIR/lib/45-codex.sh"
RC_OK=0; RC_UPDATED=10; RC_SKIP=20
have() { return 0; }
toml_merge() { return 0; }
info() { :; }; note() { :; }; warn() { :; }
codex() {
    case "$*" in
        --version) echo 'codex 1.0' ;;
        update) return 0 ;;
        *) echo 'unexpected login/auth mutation' >&2; exit 99 ;;
    esac
}
codex_account_check() { return "$TEST_ACCOUNT_RESULT"; }
mod_codex
"""
        with tempfile.TemporaryDirectory() as temp:
            for status, expected_exit in [(0, 0), (2, 1), (3, 1), (4, 1)]:
                env = dict(
                    os.environ,
                    REPO_DIR=str(ROOT),
                    CODEX_HOME=temp,
                    DEVTOOLS_NONINTERACTIVE="1",
                    TEST_ACCOUNT_RESULT=str(status),
                )
                result = subprocess.run(
                    ["sh", "-c", script], env=env, capture_output=True, check=False
                )
                self.assertEqual(result.returncode, expected_exit, result.stderr)
                self.assertNotIn(b"unexpected", result.stderr)


if __name__ == "__main__":
    unittest.main()
