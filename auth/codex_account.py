"""Check the configured ChatGPT identity without printing account data or tokens."""

import json
import os
import queue
import signal
import subprocess
import threading
import time

MATCH, ABSENT, MISMATCH, UNVERIFIED = 0, 2, 3, 4


def classify(account, expected):
    if not expected or expected.startswith("pass://") or "@" not in expected:
        return UNVERIFIED
    if account is None:
        return ABSENT
    if not isinstance(account, dict):
        return UNVERIFIED
    if account.get("type") != "chatgpt":
        return MISMATCH
    email = account.get("email")
    if not isinstance(email, str) or not email.strip():
        return UNVERIFIED
    return (
        MATCH if email.strip().casefold() == expected.strip().casefold() else MISMATCH
    )


def read_account(timeout=15):
    """Use Codex's supported credential-store-independent account/read API."""
    process = subprocess.Popen(
        ["codex", "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        start_new_session=True,
    )
    messages = queue.Queue()

    def receive():
        try:
            for line in process.stdout:
                messages.put(json.loads(line))
        except (ValueError, OSError):
            pass
        finally:
            messages.put(None)

    threading.Thread(target=receive, daemon=True).start()
    deadline = time.monotonic() + timeout

    def send(message):
        process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()

    def response(request_id):
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            message = messages.get(timeout=remaining)
            if not isinstance(message, dict):
                raise TypeError("app-server response unavailable")
            if message.get("id") == request_id:
                if "error" in message or "result" not in message:
                    raise RuntimeError("app-server rejected request")
                return message["result"]

    try:
        send(
            {
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "dev_tools_account_check",
                        "version": "1.0.0",
                    }
                },
            }
        )
        response(1)
        send({"method": "initialized", "params": {}})
        send({"id": 2, "method": "account/read", "params": {"refreshToken": False}})
        result = response(2)
        if "account" not in result:
            raise RuntimeError("missing account field")
        return result["account"]
    finally:
        # Only our own app-server group; never stop another Codex process.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        process.stdin.close()
        process.stdout.close()


def main():
    expected = os.environ.get("DEVTOOLS_CODEX_EXPECTED_EMAIL", "").strip()
    if not expected:
        for field in ("DEVTOOLS_CODEX_VAULT_EMAIL", "DEVTOOLS_CODEX_VAULT_USERNAME"):
            candidate = os.environ.get(field, "").strip()
            if classify(None, candidate) != UNVERIFIED:
                expected = candidate
                break
    # A missing/unresolved target never authorizes accepting an arbitrary login.
    if classify(None, expected) == UNVERIFIED:
        return UNVERIFIED
    try:
        return classify(read_account(), expected)
    except (OSError, ValueError, RuntimeError, TimeoutError, queue.Empty, TypeError):
        return UNVERIFIED


if __name__ == "__main__":
    raise SystemExit(main())
