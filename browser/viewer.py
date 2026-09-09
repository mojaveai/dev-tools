"""Use upstream websockify/noVNC with a small same-origin handoff UI/API."""

import json
import logging
import os
import signal
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import handoff
from websockify.websocketproxy import ProxyRequestHandler, WebSocketProxy


class Handler(ProxyRequestHandler):
    def __init__(self, req, addr, server):
        self.handoff_directory = server.handoff_directory
        self.handoff_web = server.handoff_web
        super().__init__(req, addr, server)

    def respond(self, body, content_type="application/json", code=200):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/handoff-state":
            self.respond(json.dumps(handoff.read(self.handoff_directory)))
        elif path == "/handoff.js":
            self.respond(
                Path(__file__).with_name("handoff.js").read_bytes(),
                "text/javascript",
            )
        elif path == "/vnc.html":
            page = (Path(self.handoff_web) / "vnc.html").read_text()
            page = page.replace(
                "</body>",
                '<script type="module" src="./handoff.js"></script></body>',
            )
            self.respond(page, "text/html; charset=utf-8")
        else:
            super().do_GET()

    def do_POST(self):
        # A custom header and JSON require a CORS preflight from other
        # origins. No CORS permission is granted. Stale request IDs also fail.
        if (
            urlsplit(self.path).path != "/handoff-done"
            or self.headers.get("X-DevTools-Handoff") != "1"
        ):
            self.send_error(403)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size < 1024:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(size))
            state = handoff.finish(self.handoff_directory, payload["id"])
            self.respond(json.dumps(state))
        except (ValueError, KeyError, TypeError):
            self.respond(
                json.dumps(
                    {"error": "Request expired or invalid; refresh handoff status."}
                ),
                code=409,
            )


def serve(directory, web, viewer_port, vnc_port):
    server = WebSocketProxy(
        RequestHandlerClass=Handler,
        listen_host="127.0.0.1",
        listen_port=viewer_port,
        target_host="127.0.0.1",
        target_port=vnc_port,
        web=web,
        cert=str(Path(directory) / "viewer-no-tls.pem"),
    )
    server.handoff_directory = str(directory)
    server.handoff_web = str(web)
    server.start_server()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) > 5:
        # An upgraded viewer follows the original desktop supervisor's lifetime.
        from manager import alive

        supervisor = json.loads(sys.argv[5])

        def watch():
            while alive(supervisor):
                time.sleep(1)
            os.killpg(os.getpgrp(), signal.SIGTERM)

        threading.Thread(target=watch, daemon=True).start()
    serve(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
