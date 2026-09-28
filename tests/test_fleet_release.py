import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fleet_deploy', ROOT / 'fleet/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class ReleaseTests(unittest.TestCase):
    def test_runtime_release_excludes_local_experiments_and_dependencies(self):
        paths = [p.relative_to(ROOT).as_posix() for p in deploy.runtime_files(ROOT)]
        self.assertIn('skills/proton-pass/scripts/access.py', paths)
        self.assertIn('ansible/inventory.yml', paths)
        self.assertFalse(any('/node_modules/' in p or '/test/' in p for p in paths))
        self.assertNotIn('docs/captcha-investigation.md', paths)
        self.assertNotIn('shared_browser/test/captcha-acceptance-session.mjs', paths)

    def test_content_hash_and_archive_agree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in deploy.RUNTIME:
                path = root / name
                if '.' in path.name:
                    path.write_text('test')
                else:
                    path.mkdir()
            source = root / 'lib/example.sh'
            source.write_text('first')
            archive = root / 'release.tar.gz'
            first = deploy.build(root, archive)
            self.assertEqual(first, deploy.build(root, archive))
            source.write_text('second')
            self.assertNotEqual(first, deploy.build(root, archive))
            with tarfile.open(archive) as bundle:
                self.assertEqual(bundle.extractfile('lib/example.sh').read(), b'second')


if __name__ == '__main__':
    unittest.main()
