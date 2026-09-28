import importlib.util
import json
from pathlib import Path
import tempfile
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


settings = module('claude_settings', 'config/claude/apply_settings.py')
browser = module('local_browser', 'shared_browser/local_host.py')


class FleetPreferences(unittest.TestCase):
    def test_latest_preserves_preferences_and_enables_auto_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'settings.json'
            target.write_text(json.dumps({'theme': 'dark', 'autoUpdatesChannel': 'stable',
                                          'env': {'DISABLE_AUTOUPDATER': '1', 'OTHER': 'yes'}}))
            self.assertTrue(settings.apply(target))
            self.assertFalse(settings.apply(target))
            self.assertEqual(json.loads(target.read_text()),
                             {'theme': 'dark', 'autoUpdatesChannel': 'latest', 'env': {'OTHER': 'yes'}})

    def test_remote_browser_removed_without_touching_local_or_other_servers(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            codex, claude = home / 'config.toml', home / 'claude.json'
            codex.write_text('model="example"\n[mcp_servers.other]\ncommand="other"\n'
                             '[mcp_servers.shared_browser_repl]\ncommand="ssh"\n'
                             'args=["procbox","/home/manbir/.local/share/dev-tools-shared-browser/mcp.mjs"]\n')
            claude.write_text(json.dumps({'mcpServers': {'other': {'command': 'other'},
                'shared_browser_repl': {'command': 'ssh', 'args': ['procbox', '/runtime/shared_browser/mcp.mjs']}}}))
            self.assertTrue(browser.remove_remote(codex, claude))
            self.assertFalse(browser.remove_remote(codex, claude))
            self.assertEqual(tomllib.loads(codex.read_text())['mcp_servers'], {'other': {'command': 'other'}})
            self.assertEqual(json.loads(claude.read_text())['mcpServers'], {'other': {'command': 'other'}})


if __name__ == '__main__':
    unittest.main()
