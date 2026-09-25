"""Verify Chromium can start with its sandbox; repair Ubuntu's path allowlist."""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

RESTRICTION = Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
POLICY_DIR = Path("/etc/apparmor.d")

MARKER = "# Managed by dev-tools: Chromium user namespaces\n"


def probe(chromium):
    if os.geteuid() == 0:
        return {
            "ready": False,
            "error": "Run browser provisioning as an unprivileged user with sudo.",
        }
    snap_browser = str(chromium).startswith("/snap/bin/chromium")
    probe_root = Path.home() / "snap/chromium/common" if snap_browser else None
    if probe_root:
        probe_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="devtools-browser-probe.", dir=probe_root) as directory:
        args = [
            str(chromium),
            "--headless",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
            "--password-store=basic",
            "--disable-background-networking",
            "--disable-component-update",
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0",
            f"--user-data-dir={directory}",
            "about:blank",
        ]
        with tempfile.TemporaryFile(mode="w+b") as log:
            try:
                process = subprocess.Popen(
                    args,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=log,
                    start_new_session=True,
                )
            except OSError as exc:
                return {"ready": False, "error": str(exc)}
            try:
                deadline = time.monotonic() + 15
                endpoint = Path(directory) / "DevToolsActivePort"
                http = build_opener(ProxyHandler({}))
                while time.monotonic() < deadline and process.poll() is None:
                    try:
                        port = int(endpoint.read_text().splitlines()[0])
                        with http.open(
                            f"http://127.0.0.1:{port}/json/list", timeout=1
                        ) as response:
                            pages = json.load(response)
                        if any(
                            page.get("type") == "page"
                            and page.get("url") == "about:blank"
                            for page in pages
                        ):
                            return {"ready": True}
                    except (OSError, ValueError, IndexError):
                        pass
                    time.sleep(0.1)
                log.seek(0)
                stderr = log.read().decode(errors="replace")
                lines = [
                    line
                    for line in stderr.splitlines()
                    if any(
                        word in line.lower()
                        for word in (
                            "fatal",
                            "sandbox",
                            "namespace",
                            "permission denied",
                        )
                    )
                ]
                return {
                    "ready": False,
                    "error": "\n".join(lines[-5:])
                    or (
                        "Chromium sandbox probe timed out."
                        if process.poll() is None
                        else f"Chromium probe exited {process.returncode}"
                    ),
                }
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()


def profile_text(chromium, uid):
    path = str(Path(chromium).resolve(strict=True))
    # AppArmor paths are a policy language, not shell strings. Permit literal
    # ordinary paths only, never glob/variable/quote/newline policy injection.
    if not re.fullmatch(r"/[a-zA-Z0-9_./ +\-]+", path):
        raise ValueError(
            "Chromium path contains unsupported AppArmor policy characters."
        )
    return (
        MARKER
        + "abi <abi/4.0>,\ninclude <tunables/global>\n\n"
        + f'profile dev-tools-browser-{uid} "{path}" flags=(unconfined) {{\n'
        + "  userns,\n}\n"
    )


def repair(chromium):
    result = probe(chromium)
    if result["ready"]:
        return 0
    restriction = RESTRICTION
    if not (
        restriction.exists()
        and restriction.read_text().strip() == "1"
        and any(
            message in result["error"].lower()
            for message in ("no usable sandbox", "failed to move to new namespace")
        )
    ):
        raise RuntimeError(result["error"])
    parser = shutil.which("apparmor_parser")
    if parser is None and Path("/usr/sbin/apparmor_parser").exists():
        parser = "/usr/sbin/apparmor_parser"
    if not parser or not shutil.which("sudo"):
        raise RuntimeError(
            "Chromium needs an AppArmor userns profile. Install apparmor and enable sudo for provisioning."
        )
    if subprocess.run(
        ["sudo", "-n", "true"], capture_output=True, check=False
    ).returncode:
        raise RuntimeError(
            "Chromium needs an AppArmor userns profile. Run sudo -v, then rerun provisioning."
        )
    destination = POLICY_DIR / f"dev-tools-browser-{os.getuid()}"
    content = profile_text(chromium, os.getuid())
    if destination.is_symlink() or (
        destination.exists() and not destination.read_text().startswith(MARKER)
    ):
        raise RuntimeError(
            f"Refusing to replace unmanaged AppArmor profile: {destination}"
        )
    with tempfile.TemporaryDirectory(prefix="devtools-apparmor.") as directory:
        candidate = Path(directory) / "profile"
        candidate.write_text(content)
        # Parse before installing, without loading policy or writing caches.
        subprocess.run(
            [parser, "-Q", "-T", str(candidate)], check=True, capture_output=True
        )
        if not destination.exists() or destination.read_text() != content:
            subprocess.run(
                [
                    "sudo",
                    "-n",
                    "install",
                    "-o",
                    "root",
                    "-g",
                    "root",
                    "-m",
                    "0644",
                    str(candidate),
                    str(destination),
                ],
                check=True,
                capture_output=True,
            )
        # Also repairs a present profile that has not been loaded since boot.
        subprocess.run(
            ["sudo", "-n", parser, "-r", str(destination)],
            check=True,
            capture_output=True,
        )
    result = probe(chromium)
    if not result["ready"]:
        raise RuntimeError(
            "AppArmor profile loaded but Chromium still cannot start: "
            + result["error"]
        )
    return 10


def main():
    try:
        if sys.argv[1] == "probe":
            result = probe(sys.argv[2])
            print(json.dumps(result))
            return 0 if result["ready"] else 1
        return repair(sys.argv[2])
    except subprocess.CalledProcessError as exc:
        print(
            "Browser sandbox setup failed: "
            + (exc.stderr or b"").decode(errors="replace")[-2000:],
            file=sys.stderr,
        )
        return 1
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Browser sandbox setup failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
