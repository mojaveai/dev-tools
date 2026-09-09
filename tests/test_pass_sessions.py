"""Exercise Pass session lifetimes with a fake encrypted-store CLI; no credentials."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PassSessionTests(unittest.TestCase):
    def run_case(self, commands):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            stale = base / "existing-session"
            stale.mkdir()
            (stale / "database").write_text("unreadable-old-key")
            binary = base / "pass-cli"
            binary.write_text("""#!/bin/sh
case "$1" in
    info) [ "$(cat "$PROTON_PASS_SESSION_DIR/database" 2>/dev/null)" = current-key ] ;;
    login)
        # Like SQLCipher: refuse to open an existing DB with a different key.
        [ ! -e "$PROTON_PASS_SESSION_DIR/database" ] || exit 42
        echo current-key > "$PROTON_PASS_SESSION_DIR/database"
        printf '%s\\n' "$PROTON_PASS_SESSION_DIR" >> "$TEST_LOG"
        ;;
    logout) rm -f "$PROTON_PASS_SESSION_DIR/database" ;;
    *) exit 99 ;;
esac
""")
            binary.chmod(0o755)
            env = dict(
                os.environ,
                PATH=temp + ":" + os.environ["PATH"],
                STATE_DIR=temp,
                TMPDIR=temp,
                TEST_LOG=str(base / "calls"),
                PROTON_PASS_SESSION_DIR=str(stale),
                REPO_DIR=str(ROOT),
            )
            env.pop("PROTON_PASS_PERSONAL_ACCESS_TOKEN", None)
            script = (
                """
. "$REPO_DIR/lib/25-passcli.sh"
keyctl_usable() { return 1; }
info() { :; }; err() { :; }; warn() { :; }
"""
                + commands
            )
            result = subprocess.run(
                ["sh", "-c", script], env=env, capture_output=True, check=False
            )
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual((stale / "database").read_text(), "unreadable-old-key")
            for pattern in ["devtools-pass-human.*", "devtools-pass-pat.*"]:
                self.assertEqual(list(base.glob(pattern)), [])
            log = base / "calls"
            return log.read_text().splitlines() if log.exists() else []

    def test_repeated_pat_operations_use_fresh_stores(self):
        paths = self.run_case("""
PROTON_PASS_PERSONAL_ACCESS_TOKEN=synthetic-test-token
export PROTON_PASS_PERSONAL_ACCESS_TOKEN
printf 'pass-cli info\\n' | pass_session_run || exit 1
printf 'pass-cli info\\n' | pass_session_run || exit 2
""")
        self.assertEqual(len(paths), 2)
        self.assertEqual(len(set(paths)), 2)

    def test_human_to_pat_transition_and_token_persistence(self):
        paths = self.run_case("""
pass_login_interactive() { PROTON_PASS_KEY_PROVIDER=fs pass-cli login; }
pass_mint_scoped_token() {
    PROTON_PASS_KEY_PROVIDER=fs pass-cli info || return 1
    MINTED_TOKEN=synthetic-test-token
    MINTED_ID=synthetic-test-id
}
pass_escalate_then_drop || exit 1
[ "$(cat "$PAT_FILE")" = synthetic-test-token ] || exit 2
[ -z "${PROTON_PASS_PERSONAL_ACCESS_TOKEN:-}" ] || exit 3
""")
        self.assertEqual(len(paths), 2)
        self.assertIn("devtools-pass-human.", paths[0])
        self.assertIn("devtools-pass-pat.", paths[1])

    def test_failed_approval_cleans_only_temporary_store(self):
        self.run_case("""
pass_login_interactive() { pass-cli login && return 7; }
pass_escalate_then_drop
[ "$?" = 1 ] || exit 1
[ ! -e "$PAT_FILE" ] || exit 2
""")

    def test_failed_child_cleans_pat_store(self):
        self.run_case("""
PROTON_PASS_PERSONAL_ACCESS_TOKEN=synthetic-test-token
export PROTON_PASS_PERSONAL_ACCESS_TOKEN
printf 'exit 17\\n' | pass_session_run
[ "$?" = 17 ]
""")


if __name__ == "__main__":
    unittest.main()
