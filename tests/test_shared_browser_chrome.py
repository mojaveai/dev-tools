"""Browser selection must not silently reuse Playwright Chrome for Testing."""

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("shared_browser_chrome", ROOT / "shared_browser/chrome.py")
chrome = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chrome)


class ChromeSelectionTests(unittest.TestCase):
    def test_official_package_metadata_requires_digest_and_expected_path(self):
        record = "\n".join(("Package: google-chrome-stable", "Version: 154.0.1-1",
                            "Filename: pool/main/g/google-chrome-stable/google-chrome-stable_154.0.1-1_amd64.deb",
                            "SHA256: " + "a" * 64, "Size: 100"))
        self.assertEqual(chrome.package_record(record),
                         ("154.0.1-1", "pool/main/g/google-chrome-stable/google-chrome-stable_154.0.1-1_amd64.deb", "a" * 64, 100))
        with self.assertRaises(ValueError):
            chrome.package_record(record.replace("a" * 64, "bad"))

    def test_x86_rejects_testing_and_installs_regular_chrome(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / ".config/dev-tools/shared-browser.json"
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({"chrome": "/testing", "stateDir": "/state"}))
            with patch.dict(os.environ, {"SHARED_BROWSER_CHROME": ""}), \
                 patch.object(chrome.platform, "machine", return_value="x86_64"), \
                 patch.object(chrome, "product", side_effect=lambda p: "testing" if str(p) == "/testing" else "chrome"), \
                 patch.object(chrome.shutil, "which", return_value=None):
                selected = chrome.resolve(home, installer=lambda _: Path("/regular"))
            self.assertEqual(selected, Path("/regular"))
            self.assertEqual(json.loads(config.read_text()), {"chrome": "/regular", "stateDir": "/state"})
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)

    def test_arm_uses_standard_chromium_and_never_testing(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch.dict(os.environ, {"SHARED_BROWSER_CHROME": ""}), \
                 patch.object(chrome.platform, "machine", return_value="aarch64"), \
                 patch.object(chrome, "product", side_effect=lambda p: "chromium" if str(p) == "/snap/bin/chromium" else "testing"), \
                 patch.object(chrome.shutil, "which", return_value=None):
                selected = chrome.resolve(home, arm_installer=lambda: Path("/snap/bin/chromium"))
            self.assertEqual(selected, Path("/snap/bin/chromium"))
            self.assertEqual(json.loads((home / ".config/dev-tools/shared-browser.json").read_text())["chrome"],
                             "/snap/bin/chromium")

    def test_explicit_testing_browser_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"SHARED_BROWSER_CHROME": "/testing"}), \
                 patch.object(chrome, "product", return_value="testing"):
                with self.assertRaisesRegex(RuntimeError, "never Chrome for Testing"):
                    chrome.resolve(Path(directory))


if __name__ == "__main__":
    unittest.main()
