"""Add handoff to a running legacy desktop without restarting its browser."""

import copy
import json
import os
import subprocess
import time
from pathlib import Path

import manager as m


def complete_upgrade(directory, journal):
    old, new = journal["old"], journal["new"]
    if not m.alive(new["processes"]["viewer"]):
        route = old.get("route")
        if route:
            current = m.get_handler(m.serve_config(), route["host"], route["path"])
            if current == {"Proxy": new["route"]["proxy"]}:
                m.ts(
                    [
                        "serve",
                        "--bg",
                        f"--https={route['port']}",
                        f"--set-path={route['path']}",
                        route["proxy"],
                    ]
                )
            elif current not in (None, {"Proxy": route["proxy"]}):
                raise m.BrowserError("Viewer route changed ownership during recovery")
        m.write_json(directory / "session.json", old)
        (directory / "viewer-upgrade.json").unlink(missing_ok=True)
        upgrade(old)
        return
    route = old.get("route")
    if route:
        current = m.get_handler(m.serve_config(), route["host"], route["path"])
        target = new["route"]["proxy"]
        if current not in ({"Proxy": route["proxy"]}, {"Proxy": target}):
            raise m.BrowserError("Viewer route changed ownership during upgrade")
        if current != {"Proxy": target}:
            m.ts(
                [
                    "serve",
                    "--bg",
                    f"--https={route['port']}",
                    f"--set-path={route['path']}",
                    target,
                ]
            )
    m.write_json(directory / "session.json", new)
    (directory / "viewer-upgrade.json").unlink(missing_ok=True)


def upgrade(meta):
    directory = m.session_dir(meta["id"])
    journal_path = directory / "viewer-upgrade.json"
    if journal_path.exists():
        complete_upgrade(directory, json.loads(journal_path.read_text()))
        return
    if not m.status(meta)["running"]:
        return
    try:
        json.loads(
            m.local_http(f"http://127.0.0.1:{meta['viewer_port']}/handoff-state")
        )
        return
    except (OSError, ValueError):
        pass
    cfg = m.config()
    route = meta.get("route")
    if route and m.get_handler(m.serve_config(), route["host"], route["path"]) != {
        "Proxy": route["proxy"]
    }:
        raise m.BrowserError(
            "Cannot upgrade viewer: its published route changed ownership."
        )
    port = m.free_port()
    directory = m.session_dir(meta["id"])
    with (directory / "viewer-upgrade.log").open("ab") as log:
        child = subprocess.Popen(
            [
                "/usr/bin/python3",
                str(Path(__file__).with_name("viewer.py")),
                str(directory),
                cfg["novnc"],
                str(port),
                str(meta["vnc_port"]),
                json.dumps(meta["processes"]["supervisor"]),
            ],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
    journaled = False
    try:
        for _ in range(100):
            if child.poll() is not None:
                raise m.BrowserError(
                    "Upgraded viewer exited; inspect viewer-upgrade.log"
                )
            try:
                json.loads(m.local_http(f"http://127.0.0.1:{port}/handoff-state"))
                break
            except (OSError, ValueError):
                time.sleep(0.1)
        else:
            raise m.BrowserError("Upgraded viewer did not become ready")
        new = copy.deepcopy(meta)
        new["processes"]["legacy_viewer"] = meta["processes"]["viewer"]
        new["processes"]["viewer"] = m.process_identity(child.pid)
        new["viewer_port"] = port
        if route:
            new["route"]["proxy"] = f"http://127.0.0.1:{port}"
        journal = {"old": meta, "new": new}
        m.write_json(journal_path, journal)
        journaled = True
        complete_upgrade(directory, journal)
    except BaseException:
        # After journaling, leave the owned process available for a rerun to
        # finish a Serve mutation that might have succeeded despite a timeout.
        if not journaled:
            os.killpg(child.pid, 15)
            child.wait(timeout=10)
        raise


def main():
    with m.lock(m.state_root() / "registry.lock"):
        for path in (m.state_root() / "sessions").glob("*/session.json"):
            upgrade(json.loads(path.read_text()))


if __name__ == "__main__":
    main()
