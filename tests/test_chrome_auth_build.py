import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]/'shared_browser/safari-auth'
spec=importlib.util.spec_from_file_location('chrome_auth_build', SOURCE/'build-chrome.py')
builder=importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class ChromeAuthBuildTests(unittest.TestCase):
    def test_packaged_worker_permissions_and_private_pairing(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); pairing=root/'config.js'
            pairing.write_text('const AUTH_CONFIG = '+json.dumps({'relay':'http://localhost:8811','sites':['https://demo.yubico.com','https://cryptoagent-1-1.agent-trace.ts.net:3581'],'token':'a'*64})+';\n')
            output=builder.build(SOURCE,pairing,root/'extension')
            manifest=json.loads((output/'manifest.json').read_text())
            self.assertEqual(manifest['background'],{'service_worker':'worker.js'})
            self.assertNotIn('<all_urls>',manifest['host_permissions'])
            self.assertEqual((output/'config.js').stat().st_mode & 0o777,0o600)
            for script in ['config.js','background.js','approval.js','viewer.js','popup.js']:
                self.assertTrue((output/script).is_file())
            self.assertNotIn('webAuthenticationProxy',manifest['permissions'])
            pairing.write_text('const AUTH_CONFIG = '+json.dumps({'relay':'https://untrusted.example','sites':['https://demo.yubico.com']})+';')
            with self.assertRaises(ValueError): builder.build(SOURCE,pairing,output)

if __name__ == '__main__': unittest.main()
