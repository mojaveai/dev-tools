"""Valid, refreshable, revoked and offline credentials have distinct outcomes."""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "live_account", ROOT / "auth/codex_account.py"
)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class LiveAuthTests(unittest.TestCase):
    def test_live_validation_and_conditional_refresh(self):
        for scenario, expected, refresh_count in [
            ("healthy", 0, 0),
            ("refreshable", 0, 1),
            ("revoked", 2, 1),
            ("offline", 4, 0),
            ("unauthorized", 4, 1),
            ("wrong", 3, 0),
        ]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temp:
                fake = Path(temp) / "codex"
                fake.write_text("""#!/usr/bin/env python3
import json,os,sys
scenario=os.environ['SCENARIO']; checks=0
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r:continue
 method=r['method']; result={}; error=None
 if method=='account/read':
  result={'account':{'type':'chatgpt','email':'other@example.test' if scenario=='wrong' else 'owner@example.test'}}
  if r['params']['refreshToken']:
   with open(os.environ['LOG'],'a') as f:f.write('refresh\\n')
 elif method=='account/rateLimits/read':
  checks+=1
  if scenario=='revoked' or scenario=='refreshable' and checks==1:error={'code':-32000,'message':'HTTP 401 token_revoked'}
  elif scenario=='offline':error={'code':-32000,'message':'network timeout'}
  elif scenario=='unauthorized':error={'code':-32000,'message':'HTTP 401 Unauthorized'}
 print(json.dumps({'id':r['id'],**({'error':error} if error else {'result':result})}),flush=True)
""")
                fake.chmod(0o755)
                log = Path(temp) / "log"
                with patch.dict(
                    os.environ,
                    {
                        "PATH": temp + os.pathsep + os.environ["PATH"],
                        "DEVTOOLS_CODEX_EXPECTED_EMAIL": "owner@example.test",
                        "SCENARIO": scenario,
                        "LOG": str(log),
                    },
                ):
                    self.assertEqual(a.main(), expected)
                self.assertEqual(
                    len(log.read_text().splitlines()) if log.exists() else 0,
                    refresh_count,
                )
