"""Private Supervisor services for pods without a user systemd manager."""
import argparse
import fcntl
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import time


def value(text):
    text = str(text)
    if any(c in text for c in '\r\n;"'):
        raise ValueError('Unsupported character in service configuration')
    return text.replace('%', '%%')


def configuration(state, runtime, node, chrome, origin, owner, xvfb, engine):
    state, runtime = Path(state), Path(runtime)
    env = dict(SHARED_BROWSER_STATE=str(state), SHARED_BROWSER_CHROME=chrome,
               SHARED_BROWSER_ORIGIN=origin, SHARED_BROWSER_OWNER=owner,
               SHARED_BROWSER_XVFB=xvfb, SHARED_BROWSER_ENGINE=engine)
    text = f'''[unix_http_server]
file={value(state / 'supervisor.sock')}
chmod=0700
[supervisord]
pidfile={value(state / 'supervisor.pid')}
logfile={value(state / 'supervisor.log')}
logfile_maxbytes=2MB
logfile_backups=2
childlogdir={value(state)}
umask=0077
[rpcinterface:supervisor]
supervisor.rpcinterface_factory=supervisor.rpcinterface:make_main_rpcinterface
[supervisorctl]
serverurl=unix://{value(state / 'supervisor.sock')}
'''
    programs = [('receiver', [node, str(runtime / 'server.mjs')], 20)]
    repo = Path(os.environ.get('SHARED_BROWSER_REPO', runtime.parent))
    if not (repo / 'native_browser/configure.py').exists():
        repo = Path.home() / '.local/share/dev-tools'
    codex = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'config.toml'
    programs.append(('registration', [shutil.which('python3') or 'python3',
                    str(repo / 'shared_browser/repair.py'), '--watch', '--config',
                    str(codex), '--runtime', str(runtime), '--node', node], 30))
    if engine == 'native':
        programs.insert(0, ('chrome', [shutil.which('flock') or 'flock', '--no-fork',
                                      str(state / 'browser-host.lock'), node,
                                      str(runtime / 'browser-host.mjs')], 10))
    for name, command, priority in programs:
        text += f'''[program:{name}]
command={value(shlex.join(command))}
directory={value(runtime)}
environment={','.join(k+'="'+value(v)+'"' for k,v in env.items())}
priority={priority}
autostart=true
autorestart=true
startsecs=1
startretries=5
stopwaitsecs=20
killasgroup=true
redirect_stderr=true
stdout_logfile={value(state / (name + '.log'))}
stdout_logfile_maxbytes=2MB
stdout_logfile_backups=2
'''
    return text


def control(state, *args, check=True):
    return subprocess.run(['supervisorctl', '-c', str(state / 'supervisor.conf'), *args],
                          check=check, capture_output=True, text=True, timeout=45)


def start(state):
    # Serialize simultaneous MCP connections and shell startup. Supervisor owns
    # child lifetimes and crash recovery; no PID-only kill/restart operations.
    with (state / 'supervisor-start.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        running = control(state, 'pid', check=False)
        if running.returncode:
            # Do not give long-lived browser processes the caller's credentials.
            env = {k: v for k, v in os.environ.items()
                   if k in ('HOME', 'PATH', 'USER', 'LANG', 'CODEX_HOME')}
            subprocess.run(['supervisord', '-c', str(state / 'supervisor.conf')],
                           env=env, check=True, capture_output=True, timeout=15,
                           start_new_session=True)
            for _ in range(50):
                if control(state, 'pid', check=False).returncode == 0:
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('Supervisor did not start; inspect supervisor.log')
        # Already running programs are not restarted by start all.
        control(state, 'start', 'all')


def install(state, text):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state, 0o700)
    config = state / 'supervisor.conf'
    temporary = state / 'supervisor.conf.new'
    temporary.write_text(text)
    os.chmod(temporary, 0o600)
    temporary.replace(config)
    start(state)
    control(state, 'reread')
    control(state, 'update')
    # Source updates reconnect only the receiver. Chrome keeps unsaved tabs.
    control(state, 'restart', 'receiver')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('command', choices=('start', 'install'))
    p.add_argument('state', type=Path)
    p.add_argument('settings', nargs='*')
    a = p.parse_args()
    if a.command == 'install':
        install(a.state, configuration(a.state, *a.settings))
    else:
        start(a.state)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        # Never echo service environment/configuration or inherited credentials.
        raise SystemExit(f'Shared browser service failed ({type(exc).__name__}); inspect receiver.log, chrome.log and supervisor.log in the browser state directory.')
