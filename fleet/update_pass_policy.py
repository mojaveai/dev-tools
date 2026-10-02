#!/usr/bin/env python3
"""Apply only the Pass bootstrap module, preserving the installed runtime."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile


def update(home, payload):
    active = home / '.local/share/dev-tools'
    if not active.is_symlink():
        raise ValueError('Expected a managed dev-tools release symlink')
    current = active.resolve(strict=True)
    releases = (home / '.local/share/dev-tools-releases').resolve(strict=True)
    if current.parent != releases or not (current / '.release-id').is_file():
        raise ValueError('Active runtime is not a complete managed release')
    relative = Path('lib/25-passcli.sh')
    if (current / relative).read_bytes() == payload:
        return {'changed': False, 'release': current.name}
    # Derivative release: bind this single-module overlay to its exact base.
    release = hashlib.sha256(
        b'devtools-pass-policy-v1\0' + current.name.encode() + b'\0' + payload
    ).hexdigest()
    target = releases / release
    if not target.exists():
        with tempfile.TemporaryDirectory(prefix='.pass-policy-', dir=releases) as temp:
            staged = Path(temp) / 'runtime'
            shutil.copytree(current, staged, symlinks=True)
            module = staged / relative
            module.unlink()
            module.write_bytes(payload)
            module.chmod(0o644)
            (staged / '.release-id').write_text(release + '\n')
            staged.rename(target)
    if (target / relative).read_bytes() != payload or (target / '.release-id').read_text().strip() != release:
        raise ValueError('Existing policy release is incomplete or inconsistent')
    # Atomic activation; the original runtime and checked health record remain.
    with tempfile.TemporaryDirectory(prefix='.pass-policy-link-', dir=active.parent) as temp:
        link = Path(temp) / 'active'
        link.symlink_to(target)
        link.replace(active)
    return {'changed': True, 'release': release}


if __name__ == '__main__':
    print(json.dumps(update(Path.home(), base64.b64decode(sys.argv[1], validate=True))))
