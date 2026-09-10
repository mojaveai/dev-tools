"""Offline regression coverage for lifecycle ownership and provisioning safety."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "browser"))
import manager as m
from configure import configure


class BrowserTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = patch.dict(
            os.environ,
            {
                "DEVTOOLS_BROWSER_STATE": str(self.root / "state"),
                "DEVTOOLS_BROWSER_CONFIG": str(self.root / "config.json"),
            },
        )
        self.env.start()
        m.write_json(
            m.config_path(), {"viewer_policy_reviewed": True, "viewer_https_port": 443}
        )

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def meta(self, name="one"):
        return {
            "id": name,
            "viewer_port": 46001,
            "processes": {},
            "route": None,
            "viewer_url": None,
            "ready": False,
        }

    def test_task_identity_and_path_traversal(self):
        with patch.dict(
            os.environ, {"CODEX_THREAD_ID": "a/task", "DEVTOOLS_BROWSER_SESSION": ""}
        ):
            first = m.session_id()
            self.assertEqual(first, m.session_id())
        with patch.dict(
            os.environ, {"CODEX_THREAD_ID": "other", "DEVTOOLS_BROWSER_SESSION": ""}
        ):
            self.assertNotEqual(first, m.session_id())
        for bad in ("../profile", "/tmp/foo", "hello world", "a" * 81):
            with self.assertRaises(m.BrowserError):
                m.session_id(bad)

    def test_explicit_environment_session_can_resume_named_session(self):
        with patch.dict(os.environ, {"DEVTOOLS_BROWSER_SESSION": "named-task"}):
            self.assertEqual("named-task", m.session_id())
            self.assertEqual("other-task", m.session_id("other-task"))
            with self.assertRaises(m.BrowserError):
                m.session_id("")

    def test_reused_pid_is_not_live(self):
        current = m.process_identity(os.getpid())
        self.assertTrue(m.alive(current))
        self.assertFalse(m.alive(dict(current, start="0")))
        self.assertFalse(m.alive(dict(current, boot="old-boot")))

    def test_stale_pid_cleanup_never_signals_reused_process(self):
        meta = self.meta()
        meta["processes"] = {
            "supervisor": dict(m.process_identity(os.getpid()), start="0")
        }
        with patch.object(m.os, "kill") as kill, patch.object(m.os, "killpg") as killpg:
            m.stop_locked(meta)
        kill.assert_not_called()
        killpg.assert_not_called()

    def test_default_rollout_is_gated_without_touching_host(self):
        env = dict(
            os.environ,
            DEVTOOLS_BROWSER_CONFIG=str(self.root / "missing.json"),
            DEVTOOLS_BROWSER_ENABLED="0",
        )
        result = subprocess.run(
            [str(REPO / "provision.sh"), "--only", "mod_browser", "--non-interactive"],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("pilot: enable with --with-browser", result.stdout)
        self.assertFalse((self.root / "missing.json").exists())

    def test_agent_lock_excludes_second_client(self):
        with (
            m.lock(self.root / "agent.lock"),
            self.assertRaises(m.BrowserError),
            m.lock(self.root / "agent.lock", blocking=False),
        ):
            self.fail("Second client acquired profile ownership")

    @contextmanager
    def tailscale(self, initial=None):
        serve = initial or {
            "Web": {
                "host.example.ts.net:443": {
                    "Handlers": {"/unrelated": {"Proxy": "http://127.0.0.1:9999"}}
                }
            }
        }
        calls = []

        def fake(args):
            calls.append(args)
            if args[0] == "status":
                return json.dumps(
                    {
                        "BackendState": "Running",
                        "Self": {"DNSName": "host.example.ts.net."},
                    }
                )
            if args[1] == "status":
                return json.dumps(serve)
            path = next(a.split("=", 1)[1] for a in args if a.startswith("--set-path="))
            handlers = (
                serve.setdefault("Web", {})
                .setdefault("host.example.ts.net:443", {})
                .setdefault("Handlers", {})
            )
            if args[-1] == "off":
                handlers.pop(path, None)
            else:
                handlers[path] = {"Proxy": args[-1]}
            return ""

        with patch.object(m, "ts", side_effect=fake):
            yield serve, calls

    def test_publish_is_idempotent_and_preserves_unrelated_routes(self):
        meta = self.meta()
        with self.tailscale() as (serve, calls):
            m.publish(meta)
            m.publish(meta)
            self.assertEqual(1, sum("--bg" in call for call in calls))
            query = parse_qs(urlsplit(meta["viewer_url"]).query)
            self.assertEqual(query["host"], ["host.example.ts.net"])
            self.assertEqual(query["port"], ["443"])
            self.assertEqual(query["encrypt"], ["1"])
            self.assertEqual(query["path"], ["browser/one/websockify"])
            self.assertIn("view_only=1", meta["viewer_url"])
            self.assertIn("browser%2Fone%2Fwebsockify", meta["viewer_url"])
            m.unpublish(meta)
            self.assertEqual(
                {"/unrelated": {"Proxy": "http://127.0.0.1:9999"}},
                serve["Web"]["host.example.ts.net:443"]["Handlers"],
            )

    def test_refuses_funnel_and_occupied_path(self):
        for initial in (
            {"AllowFunnel": {"host.example.ts.net:443": True}},
            {
                "Web": {
                    "host.example.ts.net:443": {
                        "Handlers": {"/browser/one": {"Proxy": "http://127.0.0.1:5"}}
                    }
                }
            },
        ):
            with self.tailscale(initial), self.assertRaises(m.BrowserError):
                m.publish(self.meta())

    def test_policy_review_required_before_any_network_call(self):
        m.write_json(m.config_path(), {})
        with patch.object(m, "ts") as ts, self.assertRaises(m.BrowserError):
            m.publish(self.meta())
        ts.assert_not_called()

    def test_empty_serve_config_and_timeout_preserve_cleanup_intent(self):
        with patch.object(m, "ts", return_value="null"):
            self.assertEqual({}, m.serve_config())
        meta = self.meta()
        responses = [
            json.dumps(
                {"BackendState": "Running", "Self": {"DNSName": "host.example.ts.net."}}
            ),
            "{}",
            subprocess.TimeoutExpired("tailscale serve", 20),
        ]
        with (
            patch.object(m, "ts", side_effect=responses),
            self.assertRaises(subprocess.TimeoutExpired),
        ):
            m.publish(meta)
        self.assertEqual("/browser/one", m.read_session("one")["route"]["path"])

    def test_stop_keeps_route_ownership_when_tailscale_unavailable(self):
        meta = self.meta()
        meta["route"] = {
            "host": "host.example.ts.net:443",
            "path": "/browser/one",
            "port": 443,
            "proxy": "http://127.0.0.1:46001",
        }
        with patch.object(m, "ts", side_effect=m.BrowserError("offline")):
            result = m.stop_locked(meta)
        self.assertEqual(meta["route"], result["route"])
        self.assertIn("offline", result["viewer_error"])
        self.assertFalse(result["running"])

    def test_cleanup_does_not_remove_reassigned_route(self):
        meta = self.meta()
        with self.tailscale() as (serve, calls):
            m.publish(meta)
            serve["Web"]["host.example.ts.net:443"]["Handlers"]["/browser/one"] = {
                "Text": "new owner"
            }
            with self.assertRaises(m.BrowserError):
                m.unpublish(meta)
            self.assertFalse(any(call[-1] == "off" for call in calls))

    def test_legacy_mcp_commands_do_not_launch_processes(self):
        with patch.object(m.subprocess, "Popen") as popen, patch.object(m.os, "execve") as execute:
            with self.assertRaisesRegex(m.BrowserError, "Legacy Playwright MCP removed"):
                m.run_mcp("old-session")
            with self.assertRaisesRegex(m.BrowserError, "Legacy Mac MCP removed"):
                m.mac_mcp()
        popen.assert_not_called()
        execute.assert_not_called()

    def test_install_can_record_viewer_review_without_mac_approval(self):
        m.write_json(m.config_path(), {})
        with (
            patch.dict(os.environ, {"DEVTOOLS_VIEWER_POLICY_REVIEWED": "1"}),
            patch("configure.subprocess.check_output", return_value="/chromium"),
            patch("configure.shutil.which", side_effect=lambda name: "/bin/" + name),
            patch("builtins.print"),
        ):
            configure(REPO, Path("/runtime"), Path("/bin/dev-tools"))
        self.assertTrue(m.config()["viewer_policy_reviewed"])
        self.assertNotIn("mac_browser", m.config())

    def test_configure_preserves_approvals_and_has_no_login_calls(self):
        previous = {
            "viewer_policy_reviewed": True,
            "max_sessions": 3,
            "mac_browser": {
                "endpoint": "https://mac.example.ts.net/mcp",
                "proxy": "",
                "approved": True,
            },
        }
        m.write_json(m.config_path(), previous)
        with (
            patch.dict(
                os.environ,
                {
                    "DEVTOOLS_MAC_BROWSER_ENDPOINT": previous["mac_browser"][
                        "endpoint"
                    ],
                    "DEVTOOLS_MAC_BROWSER_PROXY": "",
                },
            ),
            patch("configure.subprocess.check_output", return_value="/chromium") as run,
            patch("configure.shutil.which", side_effect=lambda name: "/bin/" + name),
            patch("builtins.print"),
        ):
            configure(REPO, Path("/runtime"), Path("/bin/dev-tools"))
            first = m.config()
            configure(REPO, Path("/runtime"), Path("/bin/dev-tools"))
        self.assertEqual(first, m.config())
        self.assertTrue(first["mac_browser"]["approved"])
        self.assertTrue(first["viewer_policy_reviewed"])
        self.assertEqual(3, first["max_sessions"])
        self.assertTrue(all(call.args[0][1] == "-e" for call in run.call_args_list))

    def test_omitted_mac_proxy_preserves_existing_approval(self):
        endpoint = "https://mac.example.ts.net/mcp"
        previous = {
            "mac_browser": {
                "endpoint": endpoint,
                "proxy": "http://127.0.0.1:1056",
                "approved": True,
            }
        }
        m.write_json(m.config_path(), previous)
        with (
            patch.dict(os.environ, {"DEVTOOLS_MAC_BROWSER_ENDPOINT": endpoint}),
            patch("configure.subprocess.check_output", return_value="/chromium"),
            patch("configure.shutil.which", side_effect=lambda name: "/bin/" + name),
            patch("builtins.print"),
        ):
            os.environ.pop("DEVTOOLS_MAC_BROWSER_PROXY", None)
            configure(REPO, Path("/runtime"), Path("/bin/dev-tools"))
        self.assertEqual(previous["mac_browser"], m.config()["mac_browser"])

    def test_malformed_existing_configs_are_not_destroyed(self):
        for helper, suffix, contents, body in (
            ("json_merge", "json", "{bad", "{}"),
            ("toml_merge", "toml", "[broken", "[new]\nx = 1"),
        ):
            target = self.root / ("existing." + suffix)
            target.write_text(contents)
            result = subprocess.run(
                [
                    "sh",
                    "-c",
                    '. "$1/lib/common.sh"; ' + helper + ' "$2"',
                    "test",
                    str(REPO),
                    str(target),
                ],
                input=body,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(contents, target.read_text())

    def test_merges_preserve_unrelated_auth_and_mcp_settings(self):
        target = self.root / "claude.json"
        target.write_text(
            json.dumps(
                {
                    "oauthAccount": {"accountUuid": "unchanged"},
                    "mcpServers": {"existing": {"command": "my-server"}},
                }
            )
        )
        patch_json = {
            "mcpServers": {
                "dev-tools-browser": {
                    "command": "dev-tools",
                    "args": ["browser", "mcp"],
                }
            }
        }

        def run():
            return subprocess.run(
                [
                    "sh",
                    "-c",
                    '. "$1/lib/common.sh"; json_merge "$2"',
                    "test",
                    str(REPO),
                    str(target),
                ],
                input=json.dumps(patch_json),
                text=True,
                capture_output=True,
                check=False,
            )

        self.assertEqual(10, run().returncode)
        before = target.read_bytes()
        self.assertEqual(0, run().returncode)
        self.assertEqual(before, target.read_bytes())
        result = json.loads(before)
        self.assertEqual("unchanged", result["oauthAccount"]["accountUuid"])
        self.assertEqual("my-server", result["mcpServers"]["existing"]["command"])


if __name__ == "__main__":
    unittest.main()
