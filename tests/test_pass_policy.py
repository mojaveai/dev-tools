import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pass_policy', ROOT / 'fleet/update_pass_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class PassPolicyTests(unittest.TestCase):
    def test_overlay_preserves_base_other_files_and_health_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            base = home / '.local/share/dev-tools-releases' / ('a' * 64)
            (base / 'lib').mkdir(parents=True)
            (base / 'lib/25-passcli.sh').write_text('viewer')
            (base / '.release-id').write_text(base.name + '\n')
            (base / 'other').write_text('existing runtime edits')
            (base / 'alias').symlink_to('other')
            active = home / '.local/share/dev-tools'
            active.symlink_to(base)
            health = home / '.local/share/dev-tools-health.json'
            health.write_text('previous checked release')
            result = policy.update(home, b'editor')
            self.assertTrue(result['changed'])
            self.assertNotEqual(active.resolve(), base)
            self.assertEqual((base / 'lib/25-passcli.sh').read_text(), 'viewer')
            self.assertEqual((active / 'lib/25-passcli.sh').read_text(), 'editor')
            self.assertEqual((active / 'other').read_text(), 'existing runtime edits')
            self.assertTrue((active / 'alias').is_symlink())
            self.assertEqual(health.read_text(), 'previous checked release')
            self.assertFalse(policy.update(home, b'editor')['changed'])

    def test_unmanaged_installation_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):
                policy.update(Path(temp), b'editor')


if __name__ == '__main__':
    unittest.main()
