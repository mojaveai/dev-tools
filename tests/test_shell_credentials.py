import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ShellCredentialPreservation(unittest.TestCase):
    def test_failed_refresh_keeps_previous_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state'
            state.mkdir()
            env_file = state / 'env.sh'
            original = 'export GH_TOKEN=synthetic-test-only\n'
            env_file.write_text(original)
            command = '''
. "$TEST_REPO/lib/common.sh"
. "$TEST_REPO/lib/90-shell.sh"
DEVTOOLS_SECRETS_READY=0
mod_shell
[ "$?" -eq "$RC_SKIP" ]
'''
            result = subprocess.run(['sh', '-c', command], env={**os.environ,
                'TEST_REPO': str(ROOT), 'DEVTOOLS_STATE_DIR': str(state),
                'DEVTOOLS_BIN_DIR': str(Path(tmp) / 'bin')}, capture_output=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(env_file.read_text(), original)


if __name__ == '__main__':
    unittest.main()
