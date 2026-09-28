import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('ansible-playbook'), 'Ansible controller required')
class RepairEnvironmentTests(unittest.TestCase):
    def test_restore_quotes_values_and_rejects_unresolved_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inventory = root / 'inventory.json'
            inventory.write_text(json.dumps({'linux': {'hosts': {'fixture': {
                'ansible_connection': 'local', 'devtools_state_dir': str(root)}}}}))
            names = ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ELEVENLABS_API_KEY', 'OPENROUTER_API_KEY']
            environment = {**os.environ, **{name: "synthetic ' quoted $value" for name in names},
                           'ANSIBLE_CONFIG': str(ROOT / 'ansible/ansible.cfg')}
            command = ['ansible-playbook', '-i', str(inventory), str(ROOT / 'ansible/repair-env.yml')]
            result = subprocess.run(command, env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            target = root / 'env.sh'
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            expected = target.read_bytes()
            check = subprocess.run(['sh', '-c', '. "$1"; [ "$GH_TOKEN" = "$EXPECTED_TOKEN" ]',
                                    'sh', str(target)], env={**os.environ,
                                    'EXPECTED_TOKEN': environment['GH_TOKEN']})
            self.assertEqual(check.returncode, 0)
            environment['GH_TOKEN'] = 'pass://unresolved/item/field'
            result = subprocess.run(command, env=environment, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(target.read_bytes(), expected)


if __name__ == '__main__':
    unittest.main()
