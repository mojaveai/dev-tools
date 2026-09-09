"""Native browser lifecycle. Playwright, TigerVNC and noVNC do the actual work.

No HTTP/MCP proxy is implemented here. A detached supervisor owns each desktop;
agent MCP clients attach using the upstream Playwright CDP transport.
"""

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import ProxyHandler, build_opener


class BrowserError(Exception):
    pass


def state_root():
    return Path(
        os.environ.get(
            "DEVTOOLS_BROWSER_STATE",
            str(Path.home() / ".local/state/dev-tools/browser"),
        )
    )


def config_path():
    return Path(
        os.environ.get(
            "DEVTOOLS_BROWSER_CONFIG",
            str(Path.home() / ".config/dev-tools/browser.json"),
        )
    )


def config():
    try:
        return json.loads(config_path().read_text())
    except FileNotFoundError:
        raise BrowserError(
            "Browser runtime is not installed. Run provision.sh --with-browser."
        ) from None


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with tmp.open("x") as file:
            os.chmod(tmp, 0o600)
            json.dump(value, file, indent=2)
            file.write("\n")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


@contextmanager
def lock(path, blocking=True):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a") as file:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(file, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            raise BrowserError(
                "This session already has an agent attached; use a different --session."
            ) from None
        yield


def session_id(value=None):
    value = (
        value
        if value is not None
        else (os.environ.get("DEVTOOLS_BROWSER_SESSION") or None)
    )
    if value is not None:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", value):
            raise BrowserError(
                "Session names must be 1–80 letters, digits, underscores or hyphens."
            )
        return value
    identity = os.environ.get("CODEX_THREAD_ID")
    if identity:
        return "task-" + hashlib.sha256(identity.encode()).hexdigest()[:24]
    return "session-" + uuid.uuid4().hex[:24]


def session_dir(name):
    return state_root() / "sessions" / session_id(name)


def read_session(name):
    try:
        return json.loads((session_dir(name) / "session.json").read_text())
    except FileNotFoundError:
        raise BrowserError(f"Unknown session: {name}") from None


def process_identity(pid):
    """Linux start time + boot ID prevent signalling a reused PID after a crash/reboot."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if stat[0] == "Z":
            return None
        return {
            "pid": pid,
            "start": stat[19],
            "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        }
    except (FileNotFoundError, ProcessLookupError):
        return None


def alive(identity):
    return bool(identity) and process_identity(identity["pid"]) == identity


def local_http(url):
    # Never send loopback health probes through an inherited corporate proxy.
    with build_opener(ProxyHandler({})).open(url, timeout=2) as response:
        return response.read()


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def ts(args):
    cfg = config()
    binary = cfg.get("tailscale") or shutil.which("tailscale")
    if not binary:
        raise BrowserError(
            "Tailscale CLI unavailable; local browser works, viewer publication needs Tailscale Serve."
        )
    command = [binary]
    if cfg.get("tailscale_socket"):
        command.append("--socket=" + cfg["tailscale_socket"])
    result = subprocess.run(
        command + args, text=True, capture_output=True, timeout=20, check=False
    )
    if result.returncode:
        raise BrowserError(
            "Tailscale: " + (result.stderr or result.stdout).strip()[:2000]
        )
    return result.stdout


def route_info(meta):
    cfg = config()
    status = json.loads(ts(["status", "--json"]))
    dns = status.get("Self", {}).get("DNSName", "").rstrip(".")
    if status.get("BackendState") != "Running" or not dns:
        raise BrowserError("Tailscale is not running with a MagicDNS name.")
    port = int(cfg.get("viewer_https_port", 443))
    host = f"{dns}:{port}"
    return host, "/browser/" + meta["id"], port


def get_handler(serve, host, path):
    return serve.get("Web", {}).get(host, {}).get("Handlers", {}).get(path)


def serve_config():
    value = json.loads(ts(["serve", "status", "--json"]) or "{}") or {}
    if not isinstance(value, dict):
        raise BrowserError("Unexpected Tailscale Serve status; expected a JSON object.")
    return value


def publish(meta):
    cfg = config()
    if not cfg.get("viewer_policy_reviewed"):
        raise BrowserError(
            "Viewer access policy not reviewed. Audit tailnet grants, then run dev-tools browser publish SESSION --policy-reviewed. Local automation is ready."
        )
    host, path, port = route_info(meta)
    serve = serve_config()
    if serve.get("AllowFunnel", {}).get(host):
        raise BrowserError(
            "Funnel is enabled on this HTTPS listener; refusing to expose a browser publicly. Use a private Serve port."
        )
    proxy = f"http://127.0.0.1:{meta['viewer_port']}"
    existing = get_handler(serve, host, path)
    if existing and existing != {"Proxy": proxy}:
        raise BrowserError(f"Serve path {path} is already owned by another service.")
    # Record intent before mutation: a timed-out CLI can still have installed the
    # route. Cleanup must be able to identify it even if verification never ran.
    meta["route"] = {"host": host, "path": path, "port": port, "proxy": proxy}
    write_json(session_dir(meta["id"]) / "session.json", meta)
    if not existing:
        ts(["serve", "--bg", f"--https={port}", f"--set-path={path}", proxy])
    current = serve_config()
    if get_handler(current, host, path) != {"Proxy": proxy}:
        raise BrowserError(
            "Serve did not retain the session route; check HTTPS and Serve permissions."
        )
    authority = host if port != 443 else host.rsplit(":", 1)[0]
    query = urlencode(
        {
            # noVNC 1.3/1.4 constructs ws(s)://host:port/path itself.
            # Explicit host also selects compatible path handling in newer releases.
            "host": host.rsplit(":", 1)[0],
            "port": str(port),
            "encrypt": "1",
            "path": f"{path.lstrip('/')}/websockify",
            "autoconnect": "1",
            "reconnect": "1",
            "view_only": "1",
            "resize": "scale",
        }
    )
    meta.update(
        viewer_url=f"https://{authority}{path}/vnc.html?{query}",
        route={"host": host, "path": path, "port": port, "proxy": proxy},
        viewer_error=None,
    )
    write_json(session_dir(meta["id"]) / "session.json", meta)
    return meta


def unpublish(meta):
    route = meta.get("route")
    if not route:
        return
    serve = serve_config()
    current = get_handler(serve, route["host"], route["path"])
    if current == {"Proxy": route["proxy"]}:
        ts(["serve", f"--https={route['port']}", f"--set-path={route['path']}", "off"])
    elif current:
        raise BrowserError(
            "Session Serve route was changed by another service; leaving it untouched."
        )
    meta.update(route=None, viewer_url=None)


def status(meta):
    result = dict(meta)
    result["process_health"] = {
        key: alive(value) for key, value in meta.get("processes", {}).items()
    }
    result["running"] = bool(result["process_health"]) and all(
        result["process_health"].values()
    )
    result["cdp_ready"] = False
    if result["running"]:
        try:
            result["cdp_ready"] = "webSocketDebuggerUrl" in json.loads(
                local_http(f"http://127.0.0.1:{meta['cdp_port']}/json/version")
            )
        except (OSError, ValueError):
            pass
    # Publication is not evidence that ACLs permit a particular remote device.
    result["viewer_reachability"] = "not_verified_from_another_device"
    if not result["running"]:
        result["viewer_url"] = None
    return result


def start(name):
    if os.geteuid() == 0:
        raise BrowserError(
            "Run browser sessions as an unprivileged Linux user. Chromium's sandbox is not disabled for root."
        )
    cfg = config()
    root = state_root()
    with lock(root / "registry.lock"):
        directory = session_dir(name)
        if (directory / "session.json").exists():
            previous = read_session(name)
            if status(previous)["running"]:
                return status(previous)
            stopped = stop_locked(previous)
            if stopped.get("route"):
                raise BrowserError(
                    "Old viewer route could not be removed; resolve viewer_error before resuming this session."
                )
        active = sum(
            alive(json.loads(p.read_text()).get("processes", {}).get("supervisor"))
            for p in (root / "sessions").glob("*/session.json")
        )
        if active >= int(cfg.get("max_sessions", 8)):
            raise BrowserError(
                "Session limit reached; stop an unused session or raise max_sessions."
            )
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        (directory / "profile").mkdir(exist_ok=True, mode=0o700)
        # Lock covers display allocation for our sessions. X's own lock rejects
        # conflicts with unrelated displays; we never delete another X lock.
        reserved = set()
        for p in (root / "sessions").glob("*/session.json"):
            other = json.loads(p.read_text())
            if alive(other.get("processes", {}).get("supervisor")):
                reserved.add(other["display"])
        display = next(
            (
                n
                for n in range(100, 1000)
                if n not in reserved
                and not Path(f"/tmp/.X{n}-lock").exists()
                and not Path(f"/tmp/.X11-unix/X{n}").exists()
            ),
            None,
        )
        if display is None:
            raise BrowserError("No free virtual display.")
        # Never reuse a port still referenced by a stale Serve route we own.
        stale_ports = {
            json.loads(p.read_text())["viewer_port"]
            for p in (root / "sessions").glob("*/session.json")
            if json.loads(p.read_text()).get("route")
        }
        ports = set()
        while len(ports) < 3:
            candidate = free_port()
            if candidate not in stale_ports:
                ports.add(candidate)
        cdp, viewer, vnc = sorted(ports)
        meta = {
            "id": name,
            "display": display,
            "cdp_port": cdp,
            "viewer_port": viewer,
            "vnc_port": vnc,
            "created_at": time.time(),
            "processes": {},
            "viewer_url": None,
            "route": None,
        }
        write_json(directory / "session.json", meta)
        with (directory / "supervisor.log").open("ab") as log:
            child = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "_supervise", name],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
                close_fds=True,
            )
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            meta = read_session(name)
            if (
                meta.get("ready")
                and status(meta)["running"]
                and status(meta)["cdp_ready"]
            ):
                if cfg.get("viewer_policy_reviewed"):
                    try:
                        publish(meta)
                    except (BrowserError, subprocess.TimeoutExpired, ValueError) as exc:
                        meta["viewer_error"] = str(exc)
                        write_json(directory / "session.json", meta)
                else:
                    meta["viewer_error"] = (
                        "Viewer policy not reviewed; run publish SESSION --policy-reviewed after auditing access."
                    )
                    write_json(directory / "session.json", meta)
                return status(meta)
            if child.poll() is not None:
                raise BrowserError(
                    f"Browser startup failed; inspect {directory / 'supervisor.log'}"
                )
            time.sleep(0.2)
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
        raise BrowserError(
            f"Browser startup timed out; inspect {directory / 'supervisor.log'}"
        )


def stop_locked(meta):
    import handoff

    pending = handoff.read(session_dir(meta["id"]))
    if pending["status"] == "pending":
        try:
            handoff.finish(session_dir(meta["id"]), pending["id"], "cancelled")
        except ValueError:
            pass  # The viewer may have completed it concurrently.
    # Stop the owned supervisor before routes/metadata, avoiding a late write.
    supervisor = meta.get("processes", {}).get("supervisor")
    if alive(supervisor):
        os.kill(supervisor["pid"], signal.SIGTERM)
        deadline = time.monotonic() + 20
        while alive(supervisor) and time.monotonic() < deadline:
            time.sleep(0.1)
        if alive(supervisor):
            os.killpg(supervisor["pid"], signal.SIGKILL)
    # A killed supervisor might leave children. Only kill matching process
    # identities, never "pkill chrome" or another task's process group.
    for label, identity in meta.get("processes", {}).items():
        if label != "supervisor" and alive(identity):
            os.kill(identity["pid"], signal.SIGTERM)
    try:
        unpublish(meta)
        meta["viewer_error"] = None
    except (BrowserError, subprocess.TimeoutExpired, ValueError) as exc:
        # Retain route ownership to let a later stop retry cleanup.
        meta["viewer_error"] = str(exc)
    meta["ready"] = False
    write_json(session_dir(meta["id"]) / "session.json", meta)
    return status(meta)


def supervise(name):
    cfg, directory = config(), session_dir(name)
    meta = read_session(name)
    env = dict(
        os.environ,
        DISPLAY=f":{meta['display']}",
        XAUTHORITY=str(directory / "Xauthority"),
    )
    cookie = uuid.uuid4().hex
    subprocess.run(
        [cfg["xauth"], "-f", env["XAUTHORITY"], "add", env["DISPLAY"], ".", cookie],
        check=True,
    )
    os.chmod(env["XAUTHORITY"], 0o600)
    children = []
    stopping = False

    def handle_stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    meta["processes"] = {"supervisor": process_identity(os.getpid())}

    def launch(label, command):
        child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL)
        children.append(child)
        meta["processes"][label] = process_identity(child.pid)
        write_json(directory / "session.json", meta)
        return child

    try:
        launch(
            "desktop",
            [
                cfg["vnc"],
                env["DISPLAY"],
                "-geometry",
                "1440x900",
                "-depth",
                "24",
                "-localhost",
                "yes",
                "-rfbport",
                str(meta["vnc_port"]),
                "-SecurityTypes",
                "None",
                "-AlwaysShared",
                "-auth",
                env["XAUTHORITY"],
                "-nolisten",
                "tcp",
            ],
        )
        for _ in range(100):
            if Path(f"/tmp/.X11-unix/X{meta['display']}").exists():
                break
            if children[0].poll() is not None or stopping:
                raise BrowserError("TigerVNC failed to start")
            time.sleep(0.1)
        else:
            raise BrowserError("Virtual display did not become ready")
        launch("window_manager", [cfg["window_manager"]])
        browser_args = [
            cfg["chromium"],
            "--no-first-run",
            "--no-default-browser-check",
            "--password-store=basic",
            "--remote-debugging-address=127.0.0.1",
            f"--remote-debugging-port={meta['cdp_port']}",
            f"--user-data-dir={directory / 'profile'}",
        ]
        # Coder/Docker commonly provide only 64 MiB /dev/shm. Multiple headed
        # Chromium sessions otherwise die with SIGBUS. This uses disk-backed
        # shared memory; it does not disable the browser's security sandbox.
        shm = os.statvfs("/dev/shm")
        if shm.f_blocks * shm.f_frsize < 256 * 1024 * 1024:
            browser_args.append("--disable-dev-shm-usage")
        launch("browser", browser_args + ["about:blank"])
        launch(
            "viewer",
            [
                "/usr/bin/python3",
                str(Path(__file__).with_name("viewer.py")),
                str(directory),
                cfg["novnc"],
                str(meta["viewer_port"]),
                str(meta["vnc_port"]),
            ],
        )
        for _ in range(150):
            if stopping or any(p.poll() is not None for p in children):
                failed = [
                    f"{label} (exit {child.poll()})"
                    for label, identity in meta["processes"].items()
                    for child in children
                    if child.pid == identity["pid"] and child.poll() is not None
                ]
                raise BrowserError(
                    "Browser startup interrupted"
                    if stopping
                    else "Session startup failed: "
                    + ", ".join(failed)
                    + "; inspect earlier component output"
                )
            try:
                local_http(f"http://127.0.0.1:{meta['cdp_port']}/json/version")
                local_http(f"http://127.0.0.1:{meta['viewer_port']}/vnc.html")
                meta["ready"] = True
                write_json(directory / "session.json", meta)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise BrowserError("Browser or viewer failed readiness checks")
        while not stopping and all(p.poll() is None for p in children):
            time.sleep(0.3)
        if not stopping:
            print(
                "Session component exited; stopping desktop. Exit codes: "
                + repr([p.poll() for p in children]),
                flush=True,
            )
    finally:
        browser_pid = (meta.get("processes", {}).get("browser") or {}).get("pid")
        browser = next((p for p in children if p.pid == browser_pid), None)
        if browser is not None and browser.poll() is None:
            try:
                subprocess.run(
                    [
                        cfg["node"],
                        str(Path(__file__).with_name("close-browser.cjs")),
                        cfg["runtime"],
                        f"http://127.0.0.1:{meta['cdp_port']}",
                    ],
                    stdin=subprocess.DEVNULL,
                    timeout=5,
                    check=False,
                )
                browser.wait(timeout=5)
            except (subprocess.TimeoutExpired, OSError):
                pass
            if browser.poll() is None:
                browser.terminate()
                try:
                    browser.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    browser.kill()
                    browser.wait()
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        # Do not overwrite route metadata written by the CLI while we ran.
        meta = read_session(name)
        meta["ready"] = False
        write_json(directory / "session.json", meta)


def run_mcp(name):
    directory = session_dir(name)
    with lock(directory / "agent.lock", blocking=False):
        meta = start(name)
        print(
            json.dumps(
                {
                    "session_id": name,
                    "viewer_url": meta["viewer_url"],
                    "viewer_error": meta.get("viewer_error"),
                }
            ),
            file=sys.stderr,
        )
        cfg = config()
        command = [
            cfg["node"],
            str(Path(cfg["runtime"]) / "node_modules/@playwright/mcp/cli.js"),
            "--cdp-endpoint",
            f"http://127.0.0.1:{meta['cdp_port']}",
            "--output-dir",
            str(directory / "artifacts"),
        ]
        # Keep the lock in this parent while the upstream MCP owns stdin/stdout.
        child = subprocess.Popen(command)

        def end_client(signum, _frame):
            if child.poll() is None:
                child.send_signal(signum)

        signal.signal(signal.SIGTERM, end_client)
        signal.signal(signal.SIGINT, end_client)
        try:
            return child.wait()
        finally:
            if child.poll() is None:
                child.terminate()


def validate_mac_endpoint(endpoint):
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise BrowserError(
            "Mac endpoint must be an HTTPS URL without credentials, query or fragment."
        )
    return endpoint.rstrip("/")


def mac_mcp():
    cfg = config()
    mac = cfg.get("mac_browser", {})
    if not mac.get("approved"):
        raise BrowserError(
            "Mac browser access is pending owner approval. On the Mac approve network/extension access, then run dev-tools browser approve-mac."
        )
    endpoint = validate_mac_endpoint(mac["endpoint"])
    command = [
        cfg["node"],
        str(Path(cfg["runtime"]) / "node_modules/mcp-remote/dist/proxy.js"),
        endpoint,
    ]
    env = dict(os.environ)
    if mac.get("proxy"):
        env.update(
            HTTPS_PROXY=mac["proxy"],
            HTTP_PROXY=mac["proxy"],
            NO_PROXY="localhost,127.0.0.1",
        )
        command.append("--enable-proxy")
    os.execve(cfg["node"], command, env)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    for command in (
        "start",
        "mcp",
        "status",
        "url",
        "stop",
        "delete-profile",
        "publish",
    ):
        sub = subs.add_parser(command)
        sub.add_argument("session", nargs="?")
        sub.add_argument("--json", action="store_true")
        if command == "publish":
            sub.add_argument(
                "--policy-reviewed",
                action="store_true",
                help="Confirm owner has audited tailnet access including existing broad grants",
            )
        if command == "delete-profile":
            sub.add_argument("--yes", action="store_true")
    for command in ("request-input", "input-status", "cancel-input", "wait-input"):
        sub = subs.add_parser(command)
        sub.add_argument("session")
        sub.add_argument("--json", action="store_true")
        if command == "request-input":
            sub.add_argument("--message", required=True)
        if command in ("cancel-input", "wait-input"):
            sub.add_argument("--request-id", required=True)
        if command == "wait-input":
            sub.add_argument("--timeout", type=int, default=60)
    subs.add_parser("list").add_argument("--json", action="store_true")
    subs.add_parser("doctor").add_argument("--json", action="store_true")
    subs.add_parser("mac-mcp")
    subs.add_parser("approve-mac")
    subs.add_parser("revoke-mac")
    subs.add_parser("_supervise").add_argument("session")
    args = parser.parse_args(argv)
    if args.command in ("request-input", "input-status", "cancel-input", "wait-input"):
        import handoff

        directory = session_dir(session_id(args.session))
        if not directory.exists():
            parser.error("Browser session does not exist")
        try:
            if args.command == "request-input":
                if not status(read_session(args.session))["running"]:
                    raise ValueError("Start the browser before requesting input")
                result = handoff.request(directory, args.message)
            elif args.command == "cancel-input":
                result = handoff.finish(directory, args.request_id, "cancelled")
            else:
                deadline = time.monotonic() + min(
                    max(getattr(args, "timeout", 0), 0), 60
                )
                while True:
                    result = handoff.read(directory)
                    if (
                        args.command != "wait-input"
                        or result["id"] != args.request_id
                        or result["status"] != "pending"
                        or time.monotonic() >= deadline
                    ):
                        break
                    time.sleep(0.5)
            print(json.dumps(result))
            return
        except ValueError as exc:
            parser.error(str(exc))
    os.umask(0o077)
    try:
        if args.command == "_supervise":
            supervise(args.session)
            return
        if args.command == "mac-mcp":
            mac_mcp()
            return
        if args.command in ("approve-mac", "revoke-mac"):
            cfg = config()
            if not cfg.get("mac_browser"):
                raise BrowserError(
                    "No Mac endpoint configured; provision with --with-mac-browser URL."
                )
            cfg["mac_browser"]["approved"] = args.command == "approve-mac"
            write_json(config_path(), cfg)
            print(
                "Mac client "
                + (
                    "enabled; remote ACL and extension approval still apply."
                    if args.command == "approve-mac"
                    else "disabled for new connections; revoke active access at the Mac as well."
                )
            )
            return
        if args.command == "list":
            result = [
                status(json.loads(p.read_text()))
                for p in sorted((state_root() / "sessions").glob("*/session.json"))
            ]
        elif args.command == "doctor":
            cfg = config()
            result = {
                "components": {
                    key: bool(cfg.get(key)) and Path(cfg[key]).exists()
                    for key in (
                        "node",
                        "chromium",
                        "vnc",
                        "window_manager",
                        "websockify",
                        "novnc",
                        "xauth",
                    )
                },
                "viewer_policy_reviewed": cfg.get("viewer_policy_reviewed", False),
                "mac_browser": {
                    "configured": bool(cfg.get("mac_browser")),
                    "approved": cfg.get("mac_browser", {}).get("approved", False),
                },
            }
            from sandbox import probe

            result["sandbox"] = probe(cfg.get("chromium", ""))
            try:
                result["tailscale"] = json.loads(ts(["status", "--json"])).get(
                    "BackendState"
                )
            except (BrowserError, subprocess.TimeoutExpired, ValueError) as exc:
                result["tailscale_error"] = str(exc)
        else:
            name = session_id(getattr(args, "session", None))
            if args.command == "mcp":
                sys.exit(run_mcp(name))
            if args.command == "start":
                result = start(name)
            else:
                with lock(state_root() / "registry.lock"):
                    meta = read_session(name)
                    if args.command == "stop":
                        result = stop_locked(meta)
                    elif args.command == "delete-profile":
                        if not args.yes:
                            raise BrowserError(
                                "Profile deletion requires --yes; this removes saved logins."
                            )
                        if any(alive(p) for p in meta.get("processes", {}).values()):
                            raise BrowserError(
                                "Stop this session before deleting its profile."
                            )
                        shutil.rmtree(session_dir(name) / "profile", ignore_errors=True)
                        result = {"id": name, "profile_deleted": True}
                    elif args.command == "publish":
                        if not status(meta)["running"]:
                            raise BrowserError(
                                "Start this session before publishing it."
                            )
                        if args.policy_reviewed:
                            cfg = config()
                            cfg["viewer_policy_reviewed"] = True
                            write_json(config_path(), cfg)
                        result = status(publish(meta))
                    else:
                        result = status(meta)
                        if args.command == "url":
                            if not result.get("viewer_url"):
                                raise BrowserError(
                                    result.get("viewer_error")
                                    or "Viewer not published or session stopped."
                                )
                            if not args.json:
                                print(result["viewer_url"])
                                return
        print(json.dumps(result, indent=2))
    except (
        BrowserError,
        OSError,
        ValueError,
        subprocess.TimeoutExpired,
        subprocess.CalledProcessError,
    ) as exc:
        print(f"dev-tools browser: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
