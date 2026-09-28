#!/usr/bin/env python3
"""Build a content-addressed runtime release and deploy it through Ansible."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ('lib', 'skills', 'config', 'auth', 'browser', 'native_browser',
           'shared_browser', 'bin', 'fleet', 'ansible', 'provision.sh', 'bootstrap.sh')


def runtime_files(root):
    # A checkout may contain ignored credentials or local experiments. Only
    # tracked runtime files and the explicitly owned migration directories ship.
    tracked = None
    if (root / '.git').exists():
        tracked = set(subprocess.check_output(
            ['git', '-C', str(root), 'ls-files', '-z']).decode().split('\0'))
    for name in RUNTIME:
        entry = root / name
        paths = sorted(entry.rglob('*')) if entry.is_dir() else [entry]
        for path in paths:
            relative = path.relative_to(root)
            if tracked is not None and relative.as_posix() not in tracked and relative.parts[0] not in {'fleet', 'ansible'}:
                continue
            if any(p in {'node_modules', '__pycache__', 'test', 'tests', '.git'} for p in relative.parts):
                continue
            if path.is_file() and path.suffix != '.pyc' and path.name != '.DS_Store':
                if path.is_symlink():
                    raise ValueError(f'Runtime source must not be a symlink: {relative}')
                yield path


def build(root, archive):
    digest = hashlib.sha256()
    with tarfile.open(archive, 'w:gz') as bundle:
        for path in runtime_files(root):
            relative = path.relative_to(root).as_posix()
            payload = path.read_bytes()
            digest.update(relative.encode() + b'\0' + str(path.stat().st_mode & 0o777).encode() + b'\0')
            digest.update(hashlib.sha256(payload).digest())
            info = bundle.gettarinfo(str(path), arcname=relative)
            info.size = len(payload)
            bundle.addfile(info, io.BytesIO(payload))
    return digest.hexdigest()


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if '--deploy-only' in args:
        args.remove('--deploy-only')
        args.extend(['-e', 'devtools_deploy_only=true'])
    executable = shutil.which('ansible-playbook')
    if executable is None:
        sys.exit("Install controller dependencies: uv tool install 'ansible-core==2.19.13'")
    with tempfile.TemporaryDirectory(prefix='devtools-release-') as directory:
        archive = Path(directory) / 'runtime.tar.gz'
        release = build(ROOT, archive)
        variables = Path(directory) / 'release.json'
        variables.write_text(json.dumps({'release_id': release, 'release_archive': str(archive)}))
        print(f'dev-tools release: {release}', flush=True)
        environment = os.environ.copy()
        environment['ANSIBLE_CONFIG'] = str(ROOT / 'ansible/ansible.cfg')
        return subprocess.call([executable, '-i', str(ROOT / 'ansible/inventory.yml'),
                                str(ROOT / 'ansible/site.yml'), '-e', '@' + str(variables), *args],
                               env=environment)


if __name__ == '__main__':
    raise SystemExit(main())
