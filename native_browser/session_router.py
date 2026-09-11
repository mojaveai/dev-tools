"""Keep the MCP connection alive while browsers reconnect; never replay actions."""
import json
import os
import queue
import select
import socket
import subprocess
import sys
import threading
import time
import uuid

from health import local_health, mac_health


class Backend:
    def __init__(self, route, socket_path, runtime):
        self.route, self.connection, self.child = route, None, None
        if route == 'mac':
            self.connection = socket.socket(socket.AF_UNIX)
            self.connection.settimeout(3)
            try: self.connection.connect(socket_path)
            except Exception:
                self.connection.close(); raise
            self.connection.settimeout(None)
            self.reader = self.connection.makefile('rb', buffering=0)
            self.writer = self.connection.makefile('wb', buffering=0)
        else:
            command, env = runtime()
            self.child = subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, bufsize=0)
            self.reader, self.writer = self.child.stdout, self.child.stdin
        self.buffer = bytearray()

    def send(self, message):
        data = memoryview((json.dumps(message) + '\n').encode())
        while data:
            count = self.writer.write(data)
            if not count: raise OSError('Native connection closed')
            data = data[count:]
        self.writer.flush()

    def initialize(self, params):
        ident = 'dev-tools-init-' + uuid.uuid4().hex
        self.send({'jsonrpc': '2.0', 'id': ident, 'method': 'initialize', 'params': params})
        deadline = time.monotonic() + 10
        while True:
            while b'\n' not in self.buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([self.reader], [], [], remaining)[0]:
                    raise TimeoutError('Native initialization timed out')
                data = os.read(self.reader.fileno(), 65536)
                if not data: raise OSError('Native initialization closed')
                self.buffer.extend(data)
            line, _, rest = self.buffer.partition(b'\n'); self.buffer[:] = rest
            message = json.loads(line)
            if message.get('id') == ident and 'method' not in message:
                if 'error' in message: raise RuntimeError('Native initialization failed')
                self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
                return
            # Native initialization has no interaction callbacks. Do not grant
            # anything or silently drop a new unsupported initialization request.
            if 'id' in message and 'method' in message:
                raise RuntimeError('Unexpected callback during native initialization')

    def close(self):
        if self.connection:
            try: self.connection.shutdown(socket.SHUT_RDWR)
            except OSError: pass
        if self.child:
            if self.child.poll() is None: self.child.terminate()
            try: self.child.wait(timeout=3)
            except subprocess.TimeoutExpired: self.child.kill(); self.child.wait()
        for stream in (self.reader, self.writer):
            try: stream.close()
            except OSError: pass
        if self.connection: self.connection.close()


def read_events(source, reader, events, buffer=None):
    buffer = bytearray() if buffer is None else buffer
    try:
        while True:
            while b'\n' in buffer:
                line, _, rest = buffer.partition(b'\n'); buffer[:] = rest
                events.put((source, json.loads(line)))
            data = os.read(reader.fileno(), 65536)
            if not data: break
            buffer.extend(data)
    except (OSError, ValueError): pass
    finally: events.put((source, None))


class SessionRouter:
    def __init__(self, socket_path, runtime, emit, events=None, factory=Backend):
        self.socket_path, self.runtime, self.emit = socket_path, runtime, emit
        self.events = events or queue.Queue()
        self.factory, self.backend = factory, None
        self.initialize_params, self.tools = None, None
        self.pinned, self.lost = None, False
        self.pending = {}
        self.dispatch_routes = {}

    def health(self):
        mac = mac_health(self.socket_path)
        local = {'ready': False, 'reason': 'not_needed'} if mac['ready'] else local_health(self.runtime)
        route = 'mac' if mac['ready'] else 'local' if local['ready'] else None
        return {'route': route, 'mac': mac, 'local': local}

    def connect(self, route, restore=False):
        backend = self.factory(route, self.socket_path, self.runtime)
        try:
            if restore: backend.initialize(self.initialize_params)
        except Exception:
            backend.close(); raise
        old, self.backend = self.backend, backend
        if old: old.close()
        threading.Thread(target=read_events, args=(backend, backend.reader, self.events, backend.buffer), daemon=True).start()

    def error(self, message, text):
        if 'id' not in message: return
        if message.get('method') == 'tools/call':
            result = {'jsonrpc': '2.0', 'id': message['id'], 'result': {
                'isError': True, 'content': [{'type': 'text', 'text': text}]}}
        else:
            result = {'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32000, 'message': text}}
        self.emit(result)

    def client(self, message):
        method = message.get('method')
        name = message.get('params', {}).get('name') if method == 'tools/call' else None
        if method == 'initialize': self.initialize_params = message.get('params', {})
        if method == 'tools/list' and self.tools is not None and self.backend is None:
            self.emit({'jsonrpc': '2.0', 'id': message['id'], 'result': self.tools}); return
        if name == 'js_reset' and self.lost:
            self.lost, self.pinned = False, None
            self.emit({'jsonrpc': '2.0', 'id': message['id'], 'result': {'content': [{
                'type': 'text', 'text': 'Disconnected runtime cleared. Next js call rediscovers the browser; inspect its state before continuing. Prior actions were not replayed.'}]}})
            return
        if name == 'js':
            if self.lost:
                self.error(message, 'Native connection was lost. An earlier action may have completed. Call js_reset, then inspect browser state before continuing; actions are never replayed.'); return
            if self.pinned is None:
                if self.pending:
                    self.error(message, 'Wait for the outstanding MCP request before selecting a browser.'); return
                health = self.health()
                route = health['route']
                if route is None:
                    self.error(message, 'No connected browser is available. Mac: ' + health['mac']['reason'] +
                        '; local: ' + health['local']['reason'] + '. Keep ChatGPT desktop and Chrome open on the browser host. The relay will rediscover browsers on the next js call; no Codex restart is needed. No JavaScript was executed.'); return
                if self.backend is None or self.backend.route != route:
                    try: self.connect(route, restore=True)
                    except (OSError, ValueError, RuntimeError):
                        self.error(message, 'Browser connected during discovery but native initialization failed. Retry discovery; no JavaScript was executed.'); return
                self.pinned = route
        if self.backend is None:
            self.error(message, 'Native runtime disconnected. Call js_reset before resuming browser work.'); return
        if method and 'id' in message:
            self.pending[message['id']] = message
            if name == 'js': self.dispatch_routes[message['id']] = self.pinned
        try: self.backend.send(message)
        except OSError: self.disconnected(self.backend)

    def downstream(self, backend, message):
        if backend is not self.backend: return
        if message is None: self.disconnected(backend); return
        request = self.pending.pop(message.get('id'), None) if 'method' not in message else None
        route = self.dispatch_routes.pop(message.get('id'), None) if request else None
        result = message.get('result')
        if request and isinstance(result, dict):
            if request.get('method') == 'initialize':
                result['instructions'] = result.get('instructions', '') + '\nDev-tools selects a connected browser on the first js call, not at MCP startup. Failed discovery can be retried without reconnecting. The destination is pinned after dispatch; js_reset explicitly releases it. Inspect the reported destination and browser state after reset. Never replay an uncertain action.'
            elif request.get('method') == 'tools/list': self.tools = result
            elif request.get('method') == 'tools/call':
                name = request.get('params', {}).get('name')
                if name == 'js_reset' and not result.get('isError'):
                    self.pinned = None
                    result.setdefault('content', []).append({'type': 'text', 'text': 'Next js call rediscovers the browser and may select a different machine. Inspect the new destination before acting.'})
                elif name == 'js':
                    result.setdefault('content', []).insert(0, {'type': 'text', 'text': 'Native CUA destination: ' + ('Mac Chrome through SSH relay.' if route == 'mac' else 'local browser on the agent host.')})
        self.emit(message)

    def disconnected(self, backend):
        if backend is not self.backend: return
        self.backend = None
        backend.close()
        self.lost = self.pinned is not None
        pending, self.pending = self.pending, {}
        self.dispatch_routes.clear()
        for message in pending.values():
            self.error(message, 'Native browser connection closed. The action outcome may be unknown; do not replay it. Call js_reset and inspect browser state before continuing.')

    def run(self):
        # A native runtime provides the unchanged tool schemas even while its
        # browser is offline. Actual JS dispatch is gated by live discovery.
        try: self.connect('local')
        except (OSError, ValueError, RuntimeError): self.connect('mac')
        threading.Thread(target=read_events, args=('client', sys.stdin.buffer, self.events), daemon=True).start()
        try:
            while True:
                source, message = self.events.get()
                if source == 'client':
                    if message is None: break
                    self.client(message)
                else: self.downstream(source, message)
        finally:
            if self.backend: self.backend.close()


def run(socket_path, runtime):
    def emit(message):
        sys.stdout.buffer.write((json.dumps(message) + '\n').encode()); sys.stdout.buffer.flush()
    SessionRouter(socket_path, runtime, emit).run()
