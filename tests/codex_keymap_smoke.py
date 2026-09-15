"""Run the real interactive keymap validator, including inherited/reserved keys.

python3 tests/codex_keymap_smoke.py /path/to/codex
Add --installed to check the current user's config without keymap overrides.
No prompt is submitted. Fixture maps use per-process CLI overrides; config is not edited.
"""
import argparse
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tomllib
import json
import termios
import time


def startup(binary, keymap=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
    env = {**os.environ, 'TERM': 'xterm-256color'}
    command = [binary, '--no-alt-screen']
    if keymap is not None:
        def inline(value):
            if isinstance(value, dict):
                return '{' + ','.join(json.dumps(k) + '=' + inline(v) for k, v in value.items()) + '}'
            return json.dumps(value)
        command += ['-c', 'tui.keymap=' + inline(keymap)]
    process = subprocess.Popen(command, stdin=slave,
                               stdout=slave, stderr=slave, env=env,
                               start_new_session=True)
    os.close(slave)
    output = b''
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                output += chunk
                if b'\x1b[6n' in chunk:
                    os.write(master, b'\x1b[1;1R')
            if process.poll() is not None:
                break
            if b'Invalid `tui.keymap`' in output:
                break
            # These appear after the loading shell, once the actual session starts.
            if b'Tip:' in output or b'context left' in output:
                break
        return output
    finally:
        if process.poll() is None:
            os.write(master, b'\x03\x03')
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=3)
        os.close(master)


def assert_ready(output):
    assert b'Invalid `tui.keymap`' not in output, output[-2000:]
    assert any(marker in output for marker in
               (b'Tip:', b'context left')), output[-2000:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    parser.add_argument('--installed', action='store_true')
    args = parser.parse_args()
    if args.installed:
        assert_ready(startup(args.binary))
        print('PASS: installed config reaches interactive Codex startup')
        return
    keymap = (Path(__file__).resolve().parents[1] / 'config/codex/keymap.toml').read_text()
    for label, patch, error in [
        ('provisioned map', keymap, None),
        ('Copy conflict', keymap.replace('edit_queued_message = ["alt-o"]',
                                        'edit_queued_message = ["ctrl-o"]'), b'`copy`'),
        ('reserved mode conflict', keymap.replace('next_permission_mode = ["alt-n"]',
                                                 'next_permission_mode = ["shift-tab"]'),
         b'fixed.cycle_collaboration_mode'),
    ]:
        output = startup(args.binary, tomllib.loads(patch)['tui']['keymap'])
        if error:
            assert b'Invalid `tui.keymap`' in output and error in output, output[-2000:]
            print('PASS: real TUI rejects ' + label)
        else:
            assert_ready(output)
            print('PASS: real TUI accepts ' + label)


if __name__ == '__main__':
    main()
