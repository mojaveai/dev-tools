"""Only supported same-user daemons receive one graceful signal."""

import importlib.util
import os
import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "reconcile", ROOT / "auth/reconcile_server.py"
)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class ReconcileTests(unittest.TestCase):
    def test_restart_uses_graceful_signal_only(self):
        target = {"pid": 123, "start": "10", "boot": "boot"}
        with (
            patch.object(r, "identity", side_effect=[target, target, None]),
            patch.object(
                r,
                "daemon",
                return_value=(
                    ["/codex", "app-server", "--listen", "unix://"],
                    {},
                    "/tmp",
                ),
            ),
            patch.object(r.os, "kill") as kill,
            patch.object(r.Path, "iterdir", return_value=[]),
            patch.object(r.subprocess, "Popen") as launch,
        ):
            r.worker("123", "10", "boot", "/tmp/.codex")
            kill.assert_called_once_with(123, signal.SIGHUP)
            launch.assert_called_once()

    def test_fingerprint_ignores_timestamp_only_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "config.toml"
            config.write_text("model = 'test'\n")
            before = r.fingerprint(temp)
            os.utime(config, (1, 1))
            self.assertEqual(r.fingerprint(temp), before)
            config.write_text("model = 'changed'\n")
            self.assertNotEqual(r.fingerprint(temp), before)

    def test_reused_pid_is_not_signalled(self):
        with (
            patch.object(
                r, "identity", return_value={"pid": 123, "start": "99", "boot": "boot"}
            ),
            patch.object(r.os, "kill") as kill,
        ):
            r.worker("123", "10", "boot", "/tmp/.codex")
            kill.assert_not_called()
