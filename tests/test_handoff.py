"""Human completion is explicit, request-scoped and shared between viewers."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))
import handoff


class HandoffTests(unittest.TestCase):
    def test_done_only_completes_current_request(self):
        with tempfile.TemporaryDirectory() as directory:
            a = handoff.request(directory, "Please sign in")
            self.assertEqual(handoff.read(directory)["status"], "pending")
            with self.assertRaises(ValueError):
                handoff.request(directory, "Another request")
            self.assertEqual(handoff.finish(directory, a["id"])["status"], "completed")
            b = handoff.request(directory, "Please confirm")
            with self.assertRaises(ValueError):
                handoff.finish(directory, a["id"])
            self.assertEqual(handoff.read(directory)["id"], b["id"])
            self.assertEqual(handoff.read(directory)["status"], "pending")
            self.assertEqual(
                handoff.finish(directory, b["id"], "cancelled")["status"], "cancelled"
            )

    def test_idle_and_invalid_messages(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(handoff.read(directory)["status"], "idle")
            for message in ["", " ", "a" * 1001]:
                with self.assertRaises(ValueError):
                    handoff.request(directory, message)
            self.assertEqual(handoff.read(directory)["status"], "idle")


if __name__ == "__main__":
    unittest.main()
