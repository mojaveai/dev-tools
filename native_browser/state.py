"""Private, atomic relay settings writes (also supports system macOS Python)."""
import os
import tempfile

def atomic_write(path, data):
    if path.exists() and path.read_text() == data: return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name+'.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f: f.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    return True
