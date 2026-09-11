"""Bounded discovery probes. Never approve requests or perform UI actions."""
import json
import os
import select
import socket
import subprocess
import time
import uuid


def probe(reader, writer, timeout=6, chrome_only=False):
    deadline = time.monotonic() + timeout
    buffer = bytearray()

    def send(value):
        payload = memoryview((json.dumps(value) + '\n').encode())
        while payload:
            count = writer.write(payload)
            if not count: raise OSError('Native runtime closed')
            payload = payload[count:]
        writer.flush()

    def request(ident, method, params):
        send({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params})
        while True:
            while b'\n' not in buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([reader], [], [], remaining)[0]:
                    raise TimeoutError('Browser discovery timed out')
                data = os.read(reader.fileno(), 65536)
                if not data: raise OSError('Native runtime closed')
                buffer.extend(data)
            line, _, rest = buffer.partition(b'\n'); buffer[:] = rest
            value = json.loads(line)
            if value.get('id') == ident and 'method' not in value: return value
            if 'method' in value and 'id' in value:
                send({'jsonrpc': '2.0', 'id': value['id'], 'error': {
                    'code': -32601, 'message': 'Discovery probe does not grant approvals'}})

    try:
        result = request(1, 'initialize', {'protocolVersion': '2024-11-05',
            'capabilities': {}, 'clientInfo': {'name': 'dev-tools-browser-discovery', 'version': '1'}})
        if 'error' in result: return {'ready': False, 'reason': 'native_initialization_failed'}
        send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        result = request(2, 'tools/call', {'name': 'js', 'arguments': {
            'code': 'await cua.listBrowsers();', 'title': 'Check browser availability'},
            '_meta': {'x-codex-turn-metadata': {'session_id': str(uuid.uuid4()), 'turn_id': str(uuid.uuid4())}}})
        if 'error' in result or result.get('result', {}).get('isError'):
            return {'ready': False, 'reason': 'native_discovery_failed'}
        for content in result.get('result', {}).get('content', []):
            try: browsers = json.loads(content.get('text', ''))
            except (ValueError, TypeError): continue
            if not isinstance(browsers, list): continue
            matches = [item for item in browsers if isinstance(item, dict) and
                (item.get('type') == 'extension' and item.get('family') == 'chrome'
                 if chrome_only else item.get('id') is not None)]
            if matches: return {'ready': True, 'reason': 'browser_connected'}
        return {'ready': False, 'reason': 'no_connected_browser'}
    except TimeoutError:
        return {'ready': False, 'reason': 'discovery_timeout'}
    except (OSError, ValueError):
        return {'ready': False, 'reason': 'native_connection_failed'}


def mac_health(path, timeout=6):
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(timeout)
    try:
        connection.connect(path)
        connection.settimeout(None)
        with connection.makefile('rb', buffering=0) as reader, connection.makefile('wb', buffering=0) as writer:
            return probe(reader, writer, timeout, chrome_only=True)
    except FileNotFoundError:
        return {'ready': False, 'reason': 'relay_socket_missing'}
    except OSError:
        return {'ready': False, 'reason': 'relay_unreachable'}
    finally:
        connection.close()


def local_health(runtime, timeout=6):
    child = None
    try:
        command, env = runtime()
        child = subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        return probe(child.stdout, child.stdin, timeout)
    except (OSError, ValueError, KeyError, RuntimeError):
        return {'ready': False, 'reason': 'local_runtime_missing'}
    finally:
        if child:
            child.terminate()
            try: child.wait(timeout=3)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
            child.stdin.close(); child.stdout.close()
