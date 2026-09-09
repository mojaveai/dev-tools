"""Session-local human input requests; completion is tied to one request ID."""

import fcntl
import json
import os
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def locked(directory):
    with (Path(directory) / "handoff.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def read(directory):
    path = Path(directory) / "handoff.json"
    return (
        json.loads(path.read_text())
        if path.exists()
        else {"status": "idle", "id": None}
    )


def write(directory, state):
    path = Path(directory) / "handoff.json"
    temporary = path.with_name("handoff." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(state, handle)
    os.replace(temporary, path)
    return state


def request(directory, message):
    if not message.strip() or len(message) > 1000:
        raise ValueError("Input request needs a message of 1–1000 characters.")
    with locked(directory):
        if read(directory)["status"] == "pending":
            raise ValueError(
                "An input request is already pending; wait or cancel it first."
            )
        return write(
            directory,
            {
                "id": uuid.uuid4().hex,
                "status": "pending",
                "message": message,
                "requested_at": time.time(),
            },
        )


def finish(directory, request_id, status="completed"):
    with locked(directory):
        state = read(directory)
        if state["id"] != request_id or state["status"] != "pending":
            raise ValueError("This input request is no longer pending.")
        state.update(status=status, finished_at=time.time())
        return write(directory, state)
