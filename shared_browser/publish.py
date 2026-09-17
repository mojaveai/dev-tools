"""Allocate only the shared browser's dedicated Serve listener."""
import json
import subprocess


def publish(run=subprocess.run):
    result = run(['tailscale', 'serve', 'status', '--json'], check=True,
                 capture_output=True, text=True, timeout=15)
    current = json.loads(result.stdout or '{}')
    listeners = [entry for host, entry in current.get('Web', {}).items()
                 if host.endswith(':8443')]
    expected = {'/': {'Proxy': 'http://127.0.0.1:8791'}}
    if listeners:
        if len(listeners) == 1 and listeners[0].get('Handlers') == expected:
            return
        raise RuntimeError('Tailscale Serve port 8443 is occupied; existing routes were preserved')
    if '8443' in current.get('TCP', {}):
        raise RuntimeError('Tailscale TCP port 8443 is occupied; existing routes were preserved')
    run(['tailscale', 'serve', '--bg', '--https=8443', 'http://127.0.0.1:8791'],
        check=True, timeout=30, stdin=subprocess.DEVNULL)


if __name__ == '__main__':
    try:
        publish()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        raise SystemExit(str(exc))
