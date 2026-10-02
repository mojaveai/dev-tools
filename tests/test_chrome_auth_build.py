import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]/'shared_browser/safari-auth'
spec=importlib.util.spec_from_file_location('auth_extensions', SOURCE/'build-extensions.py')
builder=importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class AuthExtensionBuildTests(unittest.TestCase):
    def test_chrome_and_safari_builds_embed_private_fleet_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for browser in ('chrome','safari'):
                output=builder.build(SOURCE,'a'*64,root/browser,browser)
                manifest=json.loads((output/'manifest.json').read_text())
                self.assertEqual((output/'config.js').stat().st_mode & 0o777,0o600)
                self.assertIn('"fleetKey": "'+'a'*64+'"',(output/'config.js').read_text())
                for script in ['config.js','background.js','approval.js','password.js','viewer.js','popup.js','popup.html']:
                    self.assertTrue((output/script).is_file())
                self.assertNotIn('webAuthenticationProxy',manifest['permissions'])
                self.assertEqual(manifest['host_permissions'],['https://*/*'])
                self.assertEqual(manifest['content_scripts'][0]['matches'],['https://*.ts.net/*'])
                self.assertNotIn('config.js',(output/'popup.html').read_text())
            self.assertEqual(json.loads((root/'chrome/manifest.json').read_text())['background'],{'service_worker':'worker.js'})
            self.assertEqual(json.loads((root/'safari/manifest.json').read_text())['background']['scripts'],['config.js','background.js'])

    def test_rebuild_removes_stale_files_and_rejects_bad_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'extension'
            builder.build(SOURCE,'b'*64,output,'chrome')
            (output/'old-relay-config.js').write_text('stale')
            builder.build(SOURCE,'b'*64,output,'chrome')
            self.assertFalse((output/'old-relay-config.js').exists())
            for key in ('', 'x'*64, 'a'*63):
                with self.assertRaises(ValueError): builder.build(SOURCE,key,output,'chrome')

if __name__ == '__main__': unittest.main()
