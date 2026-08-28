#!/usr/bin/env python3
"""Hand the Proton Pass bootstrap token to machines on this tailnet.

Run this on one always-on box. New machines join the tailnet by interactive
approval, then ask this endpoint for the one token that unlocks the vault.

Authorisation is Tailscale identity, not a shared secret: every request is
resolved with `tailscale whois`, and anything that cannot be resolved to an
allowed tag or user is refused. Traffic is already encrypted by WireGuard, so
this speaks plain HTTP and never needs a certificate.

    DEV_SECRETS_PAT_FILE=~/.secrets/proton-pass.pat ./secrets-server.py

Environment:
    DEV_SECRETS_PAT_FILE   file holding the Proton Pass PAT   (required)
    DEV_SECRETS_ALLOW_TAGS comma-separated tags               (default tag:dev)
    DEV_SECRETS_ALLOW_USERS comma-separated login names       (default none)
    DEV_SECRETS_PORT       listen port                        (default 8099)
    DEV_SECRETS_BIND       listen address       (default: this node's tailnet IP)

Name the host `dev-secrets` in Tailscale and clients find it via MagicDNS with
no configuration. Otherwise set DEVTOOLS_SECRETS_URL on the client.
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAT_FILE = os.path.expanduser(os.environ.get("DEV_SECRETS_PAT_FILE", ""))
ALLOW_TAGS = {t.strip() for t in os.environ.get("DEV_SECRETS_ALLOW_TAGS", "tag:dev").split(",") if t.strip()}
ALLOW_USERS = {u.strip().lower() for u in os.environ.get("DEV_SECRETS_ALLOW_USERS", "").split(",") if u.strip()}
PORT = int(os.environ.get("DEV_SECRETS_PORT", "8099"))


def log(*parts):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(stamp, *parts, flush=True)


def tailscale_ip():
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5)
        return out.stdout.strip().splitlines()[0]
    except Exception:
        return ""


def whois(ip):
    """Resolve a tailnet IP to its node. Returns None when it cannot be resolved."""
    try:
        out = subprocess.run(["tailscale", "whois", "--json", ip],
                             capture_output=True, text=True, timeout=5)
    except Exception as exc:
        log("whois error", ip, repr(exc))
        return None
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return None


def authorize(ip):
    """(allowed, description). Fails closed: anything unresolvable is refused."""
    data = whois(ip)
    if not data:
        return False, "not a tailnet peer"
    node = data.get("Node") or {}
    tags = set(node.get("Tags") or [])
    login = ((data.get("UserProfile") or {}).get("LoginName") or "").lower()
    name = node.get("Name") or ip

    if tags & ALLOW_TAGS:
        return True, f"{name} tags={sorted(tags & ALLOW_TAGS)}"
    if login and login in ALLOW_USERS:
        return True, f"{name} user={login}"
    return False, f"{name} tags={sorted(tags) or None} user={login or None}"


def read_pat():
    with open(PAT_FILE) as fh:
        return fh.read().strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "dev-secrets"
    sys_version = ""

    def log_message(self, fmt, *args):  # quieter default logging
        pass

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        peer = self.client_address[0]
        if self.path != "/bootstrap":
            self._send(404, b"not found\n")
            return

        allowed, why = authorize(peer)
        if not allowed:
            log("DENY ", peer, why)
            self._send(403, b"forbidden\n")
            return

        try:
            pat = read_pat()
        except OSError as exc:
            log("ERROR", peer, "cannot read PAT file:", exc)
            self._send(500, b"server misconfigured\n")
            return

        if not pat.startswith("pst_"):
            log("ERROR", peer, "PAT file does not look like a Proton Pass token")
            self._send(500, b"server misconfigured\n")
            return

        log("ALLOW", peer, why)
        self._send(200, f"PROTON_PASS_PERSONAL_ACCESS_TOKEN={pat}\n".encode())


def main():
    if not PAT_FILE:
        sys.exit("DEV_SECRETS_PAT_FILE is required")
    if not os.path.exists(PAT_FILE):
        sys.exit(f"PAT file not found: {PAT_FILE}")
    if not ALLOW_TAGS and not ALLOW_USERS:
        sys.exit("set DEV_SECRETS_ALLOW_TAGS and/or DEV_SECRETS_ALLOW_USERS")

    # Bind to the tailnet address so the peer address of every request is a real
    # tailnet IP that whois can resolve -- and so this is never exposed on a
    # public interface by accident.
    bind = os.environ.get("DEV_SECRETS_BIND") or tailscale_ip()
    if not bind:
        sys.exit("could not determine this node's tailnet IP; set DEV_SECRETS_BIND")

    log(f"serving /bootstrap on {bind}:{PORT}")
    log(f"allow tags={sorted(ALLOW_TAGS) or None} users={sorted(ALLOW_USERS) or None}")
    ThreadingHTTPServer((bind, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
