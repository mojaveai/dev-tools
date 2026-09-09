"""Serve operator convergence without modifying other users' privileges."""

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class OperatorTests(unittest.TestCase):
    def test_operator_convergence(self):
        script = """
. "$REPO_DIR/lib/55-browser.sh"
have() { return 0; }
ts_state() { echo Running; }
id() { echo browser-user; }
note() { :; }
can_privileged() { return "$TEST_SUDO"; }
tailscale() { printf '{"OperatorUser":"%s"}\\n' "$TEST_OPERATOR"; }
run_privileged() { printf '%s\\n' "$*"; }
browser_serve_operator
"""
        for operator, sudo, code, changed in [
            ("browser-user", "1", 0, False),
            ("", "0", 0, True),
            ("", "1", 1, False),
            ("another-user", "0", 1, False),
        ]:
            with self.subTest(operator=operator, sudo=sudo):
                result = subprocess.run(
                    ["sh", "-c", script],
                    capture_output=True,
                    text=True,
                    check=False,
                    env=dict(
                        os.environ,
                        REPO_DIR=str(ROOT),
                        TEST_OPERATOR=operator,
                        TEST_SUDO=sudo,
                    ),
                )
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(
                    "tailscale set --operator=browser-user" in result.stdout, changed
                )


if __name__ == "__main__":
    unittest.main()
