"""Sandbox preservation, narrow AppArmor policy, and cheap rerun contracts."""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))
import sandbox


class SandboxTests(unittest.TestCase):
    def test_working_browser_needs_no_privileges_or_changes(self):
        with (
            patch.object(sandbox, "probe", return_value={"ready": True}),
            patch.object(sandbox.subprocess, "run") as run,
        ):
            self.assertEqual(sandbox.repair("/unused/chrome"), 0)
            run.assert_not_called()

    def test_profile_uses_literal_executable_and_rejects_policy_injection(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "chrome"
            executable.touch()
            text = sandbox.profile_text(executable, 1000)
            self.assertIn(f'"{executable}"', text)
            self.assertIn("userns,", text)
            self.assertNotIn("**", text)
            for name in [
                "chrome*",
                "chrome{a,b}",
                'chrome"',
                "chrome\nuserns,",
                "chrome@{HOME}",
            ]:
                invalid = Path(directory) / name
                invalid.touch()
                with self.assertRaises(ValueError):
                    sandbox.profile_text(invalid, 1000)

    def test_targeted_repair_then_cheap_rerun(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "chrome"
            executable.touch()
            restriction = root / "restriction"
            restriction.write_text("1")
            commands = []

            def run(command, **kwargs):
                commands.append(command)
                if "install" in command:
                    shutil.copyfile(command[-2], command[-1])
                return subprocess.CompletedProcess(command, 0)

            with (
                patch.object(sandbox, "POLICY_DIR", root),
                patch.object(sandbox, "RESTRICTION", restriction),
                patch.object(
                    sandbox.shutil, "which", side_effect=lambda name: "/usr/bin/" + name
                ),
                patch.object(sandbox.subprocess, "run", side_effect=run),
                patch.object(
                    sandbox,
                    "probe",
                    side_effect=[
                        {"ready": False, "error": "No usable sandbox!"},
                        {"ready": True},
                        {"ready": True},
                    ],
                ),
            ):
                self.assertEqual(sandbox.repair(executable), 10)
                count = len(commands)
                self.assertEqual(sandbox.repair(executable), 0)
                self.assertEqual(len(commands), count)
            self.assertTrue(any("-r" in cmd for cmd in commands))
            self.assertFalse(
                any(
                    "sysctl" in " ".join(cmd) or "--no-sandbox" in cmd
                    for cmd in commands
                )
            )

    def test_other_failures_do_not_change_policy(self):
        with (
            patch.object(
                sandbox,
                "probe",
                return_value={"ready": False, "error": "missing library"},
            ),
            patch.object(sandbox.subprocess, "run") as run,
        ):
            with self.assertRaises(RuntimeError):
                sandbox.repair("/unused/chrome")
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
