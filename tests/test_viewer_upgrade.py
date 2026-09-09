"""Interrupted viewer publication resumes without claiming unrelated routes."""

import copy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))
import upgrade_viewer as u


class UpgradeTests(unittest.TestCase):
    def test_resume_before_or_after_route_mutation(self):
        old = {
            "route": {
                "host": "host:443",
                "path": "/browser/one",
                "port": 443,
                "proxy": "http://127.0.0.1:1000",
            },
            "processes": {"viewer": {"pid": 1}},
        }
        new = copy.deepcopy(old)
        new["route"]["proxy"] = "http://127.0.0.1:2000"
        for current, changes in [
            (old["route"]["proxy"], 1),
            (new["route"]["proxy"], 0),
            ("http://other", 0),
        ]:
            with tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                journal = directory / "viewer-upgrade.json"
                journal.write_text("{}")
                with (
                    patch.object(u.m, "alive", return_value=True),
                    patch.object(u.m, "serve_config", return_value={}),
                    patch.object(u.m, "get_handler", return_value={"Proxy": current}),
                    patch.object(u.m, "ts") as ts,
                ):
                    if current == "http://other":
                        with self.assertRaises(u.m.BrowserError):
                            u.complete_upgrade(directory, {"old": old, "new": new})
                        self.assertTrue(journal.exists())
                    else:
                        u.complete_upgrade(directory, {"old": old, "new": new})
                        self.assertFalse(journal.exists())
                        self.assertTrue((directory / "session.json").exists())
                    self.assertEqual(ts.call_count, changes)


if __name__ == "__main__":
    unittest.main()
