#!/usr/bin/env python3
"""Audited, non-disclosing wrapper for Proton Pass CLI access."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


_CREDENTIAL_ROOT = Path.home() / ".codex" / "agent-credentials"
_PAT_PATH = _CREDENTIAL_ROOT / "proton-pass.pat"
_AUDIT_PATH = _CREDENTIAL_ROOT / "proton-pass-access.jsonl"
_SESSION_PATH = _CREDENTIAL_ROOT / "proton-pass-session"
_USE_USER_SESSION = False
_USER_SESSION_PATH = Path.home() / ".config" / "dev-tools" / "proton-pass-session"
_PAT_RE = re.compile(r"^pst_[A-Za-z0-9_-]+::[A-Za-z0-9_-]+$")
_SECRET_IN_REASON_RE = re.compile(r"pst_[A-Za-z0-9_-]+::[A-Za-z0-9_-]+")
_BLOCKED_PREFIXES = (
    ("item", "view"),
    ("password",),
    ("totp",),
)


class AccessError(RuntimeError):
    """Raised when the audited credential-access contract is not met."""


def _validate_reason(reason: str) -> str:
    normalized = " ".join(reason.split())
    if len(normalized) < 8:
        raise AccessError("--reason must explain the credential access in at least 8 characters")
    if len(normalized) > 500:
        raise AccessError("--reason must be 500 characters or fewer")
    if _SECRET_IN_REASON_RE.search(normalized):
        raise AccessError("--reason must not contain a credential")
    return normalized


def _audit(action: str, reason: str, result: str) -> None:
    _CREDENTIAL_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    _CREDENTIAL_ROOT.chmod(0o700)
    event = {
        "at": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "reason": reason,
        "result": result,
    }
    fd = os.open(_AUDIT_PATH, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except BaseException:
        os.close(fd)
        raise
    with os.fdopen(fd, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, separators=(",", ":")) + "\n")


def _pass_cli() -> str:
    executable = shutil.which("pass-cli")
    if executable is None:
        raise AccessError("pass-cli is not installed or is not on PATH")
    return executable


def _environment_with_reason(reason: str) -> dict[str, str]:
    """Bind the audited purpose to Proton Pass's native agent-session contract."""

    environment = os.environ.copy()
    environment["PROTON_PASS_AGENT_REASON"] = reason
    if _USE_USER_SESSION:
        _USER_SESSION_PATH.mkdir(mode=0o700, parents=True, exist_ok=True)
        _USER_SESSION_PATH.chmod(0o700)
        environment["PROTON_PASS_SESSION_DIR"] = str(_USER_SESSION_PATH)
        environment["PROTON_PASS_KEY_PROVIDER"] = "fs"
        return environment
    _SESSION_PATH.mkdir(mode=0o700, parents=True, exist_ok=True)
    _SESSION_PATH.chmod(0o700)
    environment["PROTON_PASS_SESSION_DIR"] = str(_SESSION_PATH)
    return environment


def _read_pat() -> str:
    explicit = os.environ.get("PROTON_PASS_PERSONAL_ACCESS_TOKEN_FILE")
    state = Path(os.environ.get("DEVTOOLS_STATE_DIR", str(Path.home() / ".config/dev-tools")))
    provisioned = state / "proton-pass.pat"
    if explicit:
        path = Path(explicit).expanduser()
    elif sys.platform == "darwin":
        raise AccessError("Mac credential access requires the full user session or an explicit PAT file")
    elif provisioned.exists() or provisioned.is_symlink() or "DEVTOOLS_STATE_DIR" in os.environ:
        path = provisioned
    else:
        path = _PAT_PATH
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise AccessError(f"agent PAT is unavailable at {path}") from exc
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise AccessError("agent PAT must be an ordinary, non-symlinked file")
    if metadata.st_uid != os.getuid():
        raise AccessError("agent PAT must be owned by the current workspace user")
    if metadata.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise AccessError("agent PAT must not grant group or other permissions")
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise AccessError("agent PAT could not be read") from exc
    if not _PAT_RE.fullmatch(value):
        raise AccessError("agent PAT has an invalid format")
    return value


def _operation_name(command: Sequence[str]) -> str:
    if not command:
        return "unknown"
    if len(command) >= 2:
        return f"{command[0]}-{command[1]}"
    return command[0]


def _validate_command(command: list[str]) -> list[str]:
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        raise AccessError("provide a pass-cli subcommand after --")
    if command[0] == "login" or "--pat" in command:
        raise AccessError("use the authenticate subcommand for PAT-based login")
    if "--no-masking" in command:
        raise AccessError("--no-masking is prohibited")
    if any(tuple(command[: len(prefix)]) == prefix for prefix in _BLOCKED_PREFIXES):
        raise AccessError("direct credential display is prohibited; use run or inject instead")
    if command[0] == "inject" and not any(
        argument in {"--out-file", "-o"} for argument in command
    ):
        raise AccessError("inject requires --out-file; stdout injection could disclose a secret")
    return command


def _field_names(payload: object) -> list[str]:
    """Extract field labels from a captured item response without emitting field values."""

    labels: set[str] = set()

    def add_field_name(section_name: object, field: object) -> None:
        """Record a custom-field label, never its content."""

        if not isinstance(field, dict):
            return
        name = field.get("name")
        if not isinstance(name, str) or not name.strip():
            return
        if isinstance(section_name, str) and section_name.strip():
            labels.add(f"{section_name}.{name}")
        else:
            labels.add(name)

    def visit(value: object) -> None:
        if isinstance(value, list):
            for element in value:
                visit(element)
            return
        if not isinstance(value, dict):
            return

        # Custom-item fields are serialized as section_name + section_fields.
        # Pass resolves them through the section-qualified field name.
        section_name = value.get("section_name")
        section_fields = value.get("section_fields")
        if isinstance(section_fields, list):
            for field in section_fields:
                add_field_name(section_name, field)

        # Some item types store unsectioned extra fields at this level.
        for extra_key in ("extra_fields", "extraFields"):
            extra_fields = value.get(extra_key)
            if isinstance(extra_fields, list):
                for field in extra_fields:
                    add_field_name(None, field)

        for child in value.values():
            visit(child)

    visit(payload)
    return sorted(label for label in labels if label.strip())


def inspect_field_names(reason: str, share_id: str, item_id: str) -> int:
    """Read one item privately and return only its field labels."""

    result = "failed"
    try:
        completed = subprocess.run(
            [
                _pass_cli(),
                "item",
                "view",
                "--share-id",
                share_id,
                "--item-id",
                item_id,
                "--output",
                "json",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=_environment_with_reason(reason),
            check=False,
        )
        if completed.returncode != 0:
            return 1
        payload: Any = json.loads(completed.stdout)
        print(json.dumps({"field_names": _field_names(payload)}, separators=(",", ":")))
        result = "success"
        return 0
    except json.JSONDecodeError:
        return 1
    finally:
        _audit("item-field-names", reason, result)


def authenticate(reason: str) -> int:
    result = "failed"
    try:
        existing_session = subprocess.run(
            [_pass_cli(), "info"],
            stdin=None if _USE_USER_SESSION else subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=_environment_with_reason(reason),
            check=False,
        )
        if existing_session.returncode == 0:
            result = "success"
            print("pass_cli_authenticated=true")
            return 0
        if _USE_USER_SESSION:
            print('ERROR: Existing Mac user session could not be verified; sign in interactively.', file=sys.stderr)
            return 1
        pat = _read_pat()
        environment = _environment_with_reason(reason)
        environment["PROTON_PASS_PERSONAL_ACCESS_TOKEN"] = pat
        # Reset only the helper's own session, never the user's default store.
        subprocess.run(
            [_pass_cli(), "logout", "--force"], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=environment, check=False,
        )
        login = subprocess.run(
            [_pass_cli(), "login"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env=environment,
            check=False,
        )
        del pat
        if login.returncode != 0:
            diagnostic = (login.stderr or b'').decode(errors='replace').lower()
            category = 'login rejected'
            if 'timed out' in diagnostic or 'timeout' in diagnostic:
                category = 'network timeout'
            elif '429' in diagnostic or 'too many requests' in diagnostic:
                category = 'rate limited'
            elif 'expired' in diagnostic or 'invalid' in diagnostic:
                category = 'credential expired or invalid'
            print(f'ERROR: Proton authentication failed ({category})', file=sys.stderr)
            return 1
        test = subprocess.run(
            [_pass_cli(), "info"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=_environment_with_reason(reason),
            check=False,
        )
        if test.returncode != 0:
            return 1
        result = "success"
        print("pass_cli_authenticated=true")
        return 0
    finally:
        _audit("authenticate", reason, result)


def execute(reason: str, command: list[str]) -> int:
    validated = _validate_command(command)
    result = "failed"
    try:
        completed = subprocess.run(
            [_pass_cli(), *validated],
            env=_environment_with_reason(reason),
            check=False,
        )
        result = "success" if completed.returncode == 0 else "failed"
        return completed.returncode
    finally:
        _audit(_operation_name(validated), reason, result)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    auth = commands.add_parser("authenticate", help="authenticate with the agent-scoped PAT")
    auth.add_argument("--reason", required=True, help="non-sensitive purpose for this access")

    execute_parser = commands.add_parser("exec", help="run an audited pass-cli subcommand")
    execute_parser.add_argument("--reason", required=True, help="non-sensitive purpose for this access")
    execute_parser.add_argument("pass_args", nargs=argparse.REMAINDER)

    authenticated_execute = commands.add_parser(
        "authenticated-exec",
        help="authenticate and run an audited pass-cli subcommand in one process",
    )
    authenticated_execute.add_argument(
        "--reason", required=True, help="non-sensitive purpose for this access"
    )
    authenticated_execute.add_argument("pass_args", nargs=argparse.REMAINDER)

    field_names = commands.add_parser(
        "field-names", help="inspect item field labels without displaying field values"
    )
    field_names.add_argument("--reason", required=True, help="non-sensitive purpose for this access")
    field_names.add_argument("--share-id", required=True, help="vault share identifier")
    field_names.add_argument("--item-id", required=True, help="item identifier")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    global _SESSION_PATH, _USE_USER_SESSION
    args = parse_args(argv)
    try:
        reason = _validate_reason(args.reason)
        if sys.platform == "darwin" and not os.environ.get("PROTON_PASS_PERSONAL_ACCESS_TOKEN_FILE"):
            # Desktop users own a full login. Reuse it without touching its
            # database, logging it out, or copying its credentials.
            _USE_USER_SESSION = True
            environment = _environment_with_reason(reason)
            probe = subprocess.run([_pass_cli(), "info"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   env=environment, check=False)
            _audit("user-session-check", reason, "success" if probe.returncode == 0 else "failed")
            if probe.returncode != 0:
                raise AccessError('Mac user Proton session is unavailable; run provision.sh --only mod_passcli interactively')
        if args.command == "authenticate":
            return authenticate(reason)
        if args.command == "exec":
            return execute(reason, list(args.pass_args))
        if args.command == "authenticated-exec":
            # One isolated database and key lifetime per operation, including
            # containers that prohibit kernel keyring syscalls.
            _validate_command(list(args.pass_args))
            if _USE_USER_SESSION:
                return execute(reason, list(args.pass_args))
            with tempfile.TemporaryDirectory(prefix="devtools-pass-agent-") as session:
                _SESSION_PATH = Path(session)
                os.environ["PROTON_PASS_KEY_PROVIDER"] = "fs"
                authenticated = authenticate(reason)
                if authenticated != 0:
                    return authenticated
                return execute(reason, list(args.pass_args))
        if args.command == "field-names":
            return inspect_field_names(reason, args.share_id, args.item_id)
    except AccessError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    raise AssertionError(f"unexpected command {args.command!r}")


if __name__ == "__main__":
    raise SystemExit(main())
