import importlib.util
import json
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('shared_config', ROOT/'shared_browser/configure.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SharedConfigurationTests(unittest.TestCase):
    def test_migration_preserves_other_settings_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp); codex=home/'config.toml'; claude=home/'claude.json'
            codex.write_text('model="example"\n[mcp_servers.other]\ncommand="other"\n[mcp_servers.cua_repl]\ncommand="python3"\nargs=["/repo/native_browser/router.py"]\n')
            claude.write_text(json.dumps({'preference':True,'mcpServers':{'other':{'command':'other'},'dev-tools-browser':{'command':'legacy'}}}))
            with patch.object(module.Path,'home',return_value=home):
                module.configure(ROOT,home/'runtime',Path('/node'),codex,claude)
                first=codex.read_text(),claude.read_text()
                module.configure(ROOT,home/'runtime',Path('/node'),codex,claude)
            self.assertEqual(first,(codex.read_text(),claude.read_text()))
            d=tomllib.loads(codex.read_text());self.assertEqual(d['model'],'example')
            self.assertEqual(d['mcp_servers']['other'],{'command':'other'})
            self.assertNotIn('cua_repl',d['mcp_servers'])
            self.assertEqual(d['mcp_servers']['shared_browser_repl']['args'],[str(home/'runtime/mcp.mjs')])
            c=json.loads(claude.read_text());self.assertTrue(c['preference'])
            self.assertIn('other',c['mcpServers']);self.assertNotIn('dev-tools-browser',c['mcpServers'])

if __name__ == '__main__': unittest.main()
