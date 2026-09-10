"""Generate only dev-tools-owned settings; preserve approvals across reruns."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from manager import config_path, write_json


def configure(repo, runtime, executable):
    path = config_path()
    previous = json.loads(path.read_text()) if path.exists() else {}
    cfg = dict(previous)
    node = shutil.which("node")
    chromium = subprocess.check_output(
        [
            node,
            "-e",
            "process.stdout.write(require('playwright').chromium.executablePath())",
        ],
        cwd=runtime,
        text=True,
    )
    cfg.update(
        runtime=str(runtime),
        node=node,
        chromium=chromium,
        vnc=shutil.which("Xtigervnc"),
        xauth=shutil.which("xauth"),
        window_manager=shutil.which("openbox"),
        websockify=shutil.which("websockify"),
        novnc="/usr/share/novnc",
    )
    cfg.setdefault("max_sessions", 8)
    if os.environ.get("DEVTOOLS_CODEX_LOGIN_WITH_PASS") == "1":
        cfg["codex_login_with_pass"] = True
    cfg.setdefault("viewer_policy_reviewed", False)
    if os.environ.get("DEVTOOLS_VIEWER_POLICY_REVIEWED") == "1":
        cfg["viewer_policy_reviewed"] = True
    cfg.setdefault("viewer_https_port", 443)
    if cfg != previous:
        write_json(path, cfg)

    # Browser viewer setup no longer registers agent MCPs. Native CUA routing
    # is configured independently by mod_native_browser.
    print(json.dumps({"changed": cfg != previous}))


if __name__ == "__main__":
    configure(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
