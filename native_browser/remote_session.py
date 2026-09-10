"""Executed over the forwarding SSH connection; publishes only its own lease."""
import json
import os
from pathlib import Path
import select
import socket
import stat
import subprocess
import sys


def publish(cfg):
    endpoint = Path(cfg['remote_socket'])
    generation = Path(cfg['generation'])
    if Path(str(endpoint) + '.owner').read_text() != cfg['owner']:
        raise RuntimeError('Remote relay belongs to another installation')
    if not stat.S_ISSOCK(generation.lstat().st_mode):
        raise RuntimeError('Forwarded listener is absent')
    if cfg['repair_root_socket'] and generation.stat().st_uid != cfg['uid']:
        subprocess.run(['sudo', '-n', 'chown', f"{cfg['uid']}:{cfg['gid']}", str(generation)], check=True, timeout=5)
    probe = socket.socket(socket.AF_UNIX)
    try:
        probe.settimeout(3)
        probe.connect(str(generation))
    finally:
        probe.close()
    # Refuse ordinary files. The legacy socket is migrated on first publication.
    if endpoint.exists() and not endpoint.is_symlink() and not stat.S_ISSOCK(endpoint.lstat().st_mode):
        raise RuntimeError('Refusing to replace a non-socket endpoint')
    temporary = Path(str(generation) + '.link')
    temporary.symlink_to(generation.name)
    os.replace(temporary, endpoint)
    return endpoint, generation


def run(cfg):
    endpoint, generation = publish(cfg)
    try:
        while True:
            # Both peers enforce a deadline: half-open SSH sessions cannot hold
            # a published listener indefinitely after a tailnet change.
            ready, _, _ = select.select([sys.stdin], [], [], 15)
            if not ready or not os.read(sys.stdin.fileno(), 1):
                break
            os.write(sys.stdout.fileno(), b'.')
    finally:
        if endpoint.is_symlink() and os.readlink(endpoint) == generation.name:
            endpoint.unlink()
        generation.unlink(missing_ok=True)


if __name__ == '__main__':
    run(json.loads(sys.argv[1]))
