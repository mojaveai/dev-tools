"""Set managed Claude update preferences without replacing personal settings."""
import json
import os
from pathlib import Path
import tempfile


def apply(path):
    settings = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(settings, dict):
        raise ValueError('Claude settings must be an object')
    environment = settings.get('env', {})
    if environment is not None and not isinstance(environment, dict):
        raise ValueError('Claude settings env must be an object')
    if settings.get('autoUpdatesChannel') == 'latest' and 'DISABLE_AUTOUPDATER' not in (environment or {}):
        return False
    settings['autoUpdatesChannel'] = 'latest'
    if isinstance(settings.get('env'), dict):
        settings['env'].pop('DISABLE_AUTOUPDATER', None)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='settings.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(settings, output, indent=2)
            output.write('\n')
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


if __name__ == '__main__':
    target = Path(os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude'))) / 'settings.json'
    print('Updated Claude settings' if apply(target) else 'Claude settings already current')
