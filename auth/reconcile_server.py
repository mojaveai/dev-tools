"""Gracefully reload same-user Codex Unix daemons after auth/config changes."""

import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def identity(pid):
    try:
        data = (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
        if data[0] == "Z":
            return None
        return {
            "pid": int(pid),
            "start": data[19],
            "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        }
    except (OSError, IndexError):
        return None


def daemon(pid, home):
    proc = Path("/proc") / str(pid)
    if proc.stat().st_uid != os.getuid():
        return None
    args = [
        part.decode() for part in (proc / "cmdline").read_bytes().split(b"\0") if part
    ]
    if "app-server" not in args or "--listen" not in args:
        return None
    endpoint = args[args.index("--listen") + 1]
    if not endpoint.startswith("unix://"):
        return None
    env = dict(
        part.split(b"=", 1)
        for part in (proc / "environ").read_bytes().split(b"\0")
        if b"=" in part
    )
    env = {key.decode(): value.decode() for key, value in env.items()}
    configured_home = Path(
        env.get("CODEX_HOME", str(Path(env.get("HOME", "")) / ".codex"))
    ).resolve()
    if configured_home != home.resolve():
        return None
    args[0] = str((proc / "exe").resolve())
    # Restrict the signal to the standalone daemon shape whose SIGHUP handler
    # drains active turns. Stdio servers belong to a caller and are untouched.
    version = (
        subprocess.check_output([args[0], "--version"], text=True, timeout=5)
        .strip()
        .split()[-1]
    )
    parts = tuple(int(part) for part in version.split(".")[:3])
    if parts < (0, 153, 0):
        return None
    return args, env, str((proc / "cwd").resolve())


def fingerprint(home):
    digest = hashlib.sha256()
    for name in ("auth.json", "config.toml"):
        path = Path(home) / name
        digest.update(name.encode())
        digest.update(path.read_bytes() if path.exists() else b"")
    return digest.hexdigest()


def worker(pid, start, boot, home, state=None):
    target = {"pid": int(pid), "start": start, "boot": boot}
    if identity(pid) != target:
        return
    launch = daemon(pid, Path(home))
    if not launch:
        return
    args, env, cwd = launch
    if identity(pid) != target:
        return
    # SIGHUP is explicitly GracefulOnly in supported Codex. Never send a second
    # forceable signal or terminate a task to make provisioning finish sooner.
    os.kill(int(pid), signal.SIGHUP)
    while identity(pid) == target:
        time.sleep(1)
    # Another service/client may have restarted the daemon while it drained.
    for proc in Path("/proc").iterdir():
        if proc.name.isdigit():
            try:
                if daemon(proc.name, Path(home)):
                    return
            except (OSError, ValueError, IndexError, subprocess.SubprocessError):
                pass
    current = fingerprint(home) if state else None
    child = subprocess.Popen(
        args,
        env=env,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    if state:
        payload = {"process": identity(child.pid), "fingerprint": current}
        path = Path(state) / "codex-restart-baseline.json"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(payload, stream)


def reconcile():
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    state = Path(
        os.environ.get("DEVTOOLS_STATE_DIR", str(Path.home() / ".config/dev-tools"))
    )
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    modified = max(
        (
            p.stat().st_mtime
            for p in [home / "auth.json", home / "config.toml"]
            if p.exists()
        ),
        default=0,
    )
    btime = next(
        int(line.split()[1])
        for line in Path("/proc/stat").read_text().splitlines()
        if line.startswith("btime ")
    )
    current = fingerprint(home)
    baseline_path = state / "codex-restart-baseline.json"
    try:
        baseline = json.loads(baseline_path.read_text())
    except (OSError, ValueError):
        baseline = {}
    queued = 0
    with (state / "codex-restart.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for proc in Path("/proc").iterdir():
            if not proc.name.isdigit():
                continue
            try:
                target = identity(proc.name)
                if (
                    not target
                    or btime + int(target["start"]) / os.sysconf("SC_CLK_TCK")
                    >= modified
                ):
                    continue
                if (
                    baseline.get("process") == target
                    and baseline.get("fingerprint") == current
                ):
                    continue
                if not daemon(proc.name, home):
                    continue
                pending = state / f"codex-restart-{proc.name}.json"
                old = json.loads(pending.read_text()) if pending.exists() else {}
                if (
                    old.get("target") == target
                    and identity(old.get("worker", {}).get("pid", -1))
                    == old.get("worker")
                    and old.get("worker")
                ):
                    queued += 1
                    continue
                child = subprocess.Popen(
                    [
                        sys.executable,
                        str(Path(__file__).resolve()),
                        "--worker",
                        proc.name,
                        target["start"],
                        target["boot"],
                        str(home),
                        str(state),
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                payload = {"target": target, "worker": identity(child.pid)}
                fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as stream:
                    json.dump(payload, stream)
                queued += 1
            except (OSError, ValueError, IndexError, subprocess.SubprocessError):
                continue
    if queued:
        print(
            "Codex daemon reload queued; active turns drain before restart.",
            file=sys.stderr,
        )
    return 10 if queued else 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker(*sys.argv[2:])
    else:
        raise SystemExit(reconcile())
