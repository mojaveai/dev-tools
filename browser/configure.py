"""Generate only dev-tools-owned settings; preserve approvals across reruns."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from manager import config_path, validate_mac_endpoint, write_json


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
    if os.environ.get("DEVTOOLS_MAC_BROWSER_ENDPOINT"):
        endpoint = validate_mac_endpoint(os.environ["DEVTOOLS_MAC_BROWSER_ENDPOINT"])
        old = cfg.get("mac_browser", {})
        proxy = os.environ.get(
            "DEVTOOLS_MAC_BROWSER_PROXY",
            old.get("proxy", "") if old.get("endpoint") == endpoint else "",
        )
        cfg["mac_browser"] = {
            "endpoint": endpoint,
            "proxy": proxy,
            "approved": old.get("approved", False)
            if (old.get("endpoint"), old.get("proxy", "")) == (endpoint, proxy)
            else False,
        }
    if cfg != previous:
        write_json(path, cfg)

    # Scratch patches contain no credentials. Existing merge helpers perform the
    # actual edits, including TOML comments/unrelated table preservation.
    command = str(executable)
    servers = {
        "dev-tools-browser": {
            "type": "stdio",
            "command": command,
            "args": ["browser", "mcp"],
        }
    }
    toml = [
        "[mcp_servers.dev-tools-browser]",
        "command = " + json.dumps(command),
        'args = ["browser", "mcp"]',
        "startup_timeout_sec = 60",
        "tool_timeout_sec = 180",
        'env_vars = ["CODEX_THREAD_ID", "DEVTOOLS_BROWSER_SESSION", "DEVTOOLS_BROWSER_CONFIG", "DEVTOOLS_BROWSER_STATE"]',
        "",
    ]
    if cfg.get("mac_browser"):
        servers["dev-tools-mac-browser"] = {
            "type": "stdio",
            "command": command,
            "args": ["browser", "mac-mcp"],
        }
        toml += [
            "[mcp_servers.dev-tools-mac-browser]",
            "command = " + json.dumps(command),
            'args = ["browser", "mac-mcp"]',
            "startup_timeout_sec = 60",
            "tool_timeout_sec = 180",
            "",
        ]
    print(
        json.dumps(
            {
                "changed": cfg != previous,
                "claude": {"mcpServers": servers},
                "codex": "\n".join(toml),
            }
        )
    )


if __name__ == "__main__":
    configure(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
