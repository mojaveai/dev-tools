import importlib.util
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('shared_repair', ROOT/'shared_browser/repair.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SharedRepairTests(unittest.TestCase):
    def test_restore_after_external_rewrite_and_preserve_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp)/'config.toml'
            original = '# preserved\nmodel="example"\n[mcp_servers.other]\ncommand="other"\n'
            server = {'command':'node','args':['/runtime/mcp.mjs']}
            config.write_text(original)
            self.assertTrue(module.repair(config, server))
            self.assertFalse(module.repair(config, server))
            parsed = tomllib.loads(config.read_text())
            self.assertEqual(parsed['mcp_servers']['other'], {'command':'other'})
            self.assertEqual(parsed['mcp_servers']['shared_browser_repl'],server)
            self.assertIn('# preserved', config.read_text())
            config.write_text(original)
            self.assertTrue(module.repair(config, server))

    def test_user_overrides_and_invalid_files_are_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp)/'config.toml'
            for text in ['[mcp_servers.shared_browser_repl]\nenabled=false\n',
                         '[mcp_servers.shared_browser_repl]\ncommand="custom"\n']:
                config.write_text(text)
                self.assertFalse(module.repair(config, {'command':'node'}))
                self.assertEqual(config.read_text(), text)
            config.write_text('[invalid')
            with self.assertRaises(tomllib.TOMLDecodeError):
                module.repair(config, {'command':'node'})
            self.assertEqual(config.read_text(), '[invalid')

if __name__ == '__main__': unittest.main()
