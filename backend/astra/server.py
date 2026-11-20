"""Same-origin static frontend + lease-controlled Astra bridge on loopback.

Run from repository root: python -m backend.astra.server --probe
or python -m backend.astra.server (after the frontend production build).
Packet v1: uint32 LE JSON length | UTF-8 JSON | JPEG | uint16 LE aligned Z.
"""
import argparse
import json
from pathlib import Path
import secrets
import socket
import struct
import threading
import time
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import cv2
import numpy as np

from .camera import AstraCamera
from .capture_process import IsolatedAstra

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / 'web/dist'
LEASE_SECONDS = 15


def pack_frame(bgr, depth, metadata):
    ok, jpeg = cv2.imencode('.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise RuntimeError('Cannot encode Astra color frame')
    header = json.dumps({**metadata, 'version': 1, 'jpeg_bytes': jpeg.nbytes,
                         'depth_bytes': depth.nbytes}, separators=(',', ':')).encode()
    return struct.pack('<I', len(header)) + header + jpeg.tobytes() + depth.astype('<u2', copy=False).tobytes()


class CaptureManager:
    """Single camera owner, bounded latest-frame slot and per-browser lease.

    All native camera operations happen on one thread. Stop joins that owner
    before another session can open; stale stop/frame requests cannot affect a
    new session. A closed/crashed browser loses its lease and releases hardware.
    """
    def __init__(self, factory=IsolatedAstra, lease_seconds=LEASE_SECONDS):
        self.factory, self.lease_seconds = factory, lease_seconds
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.lifecycle = threading.Lock()
        self.thread = None
        self.session = None
        self.error = None
        self.packet = None
        self.sequence = 0
        self.captured_at = 0

    def start(self):
        with self.lifecycle:
            with self.changed:
                if self.thread and self.thread.is_alive():
                    raise RuntimeError('Astra is already in use; stop the other page/session first')
                self.session = secrets.token_urlsafe(24)
                self.error, self.packet, self.sequence = None, None, 0
                self.stop_event = threading.Event()
                self.ready = threading.Event()
                self.last_request = time.monotonic()
                self.thread = threading.Thread(target=self._capture, name='astra-capture', daemon=True)
                self.thread.start()
            if not self.ready.wait(32):
                self.stop_event.set()
                raise RuntimeError('Astra startup timed out; wait for release before retrying')
            with self.changed:
                if self.error:
                    raise RuntimeError(self.error)
                self.last_request = time.monotonic()
                return {'session': self.session, **self.metadata}

    def _capture(self):
        camera = None
        try:
            camera = self.factory()
            with self.changed:
                self.last_request = time.monotonic()
                self.metadata = {**camera.registration.metadata, 'device': camera.info}
            while not self.stop_event.is_set():
                if time.monotonic() - self.last_request > self.lease_seconds:
                    raise RuntimeError('Astra session expired; camera released')
                bgr, depth, timing = camera.read()
                sequence = self.sequence + 1
                packet = pack_frame(bgr, depth, {**self.metadata, **timing, 'sequence': sequence})
                with self.changed:
                    self.packet, self.sequence = packet, sequence
                    self.captured_at = time.monotonic()
                    self.ready.set()
                    self.changed.notify_all()
        except Exception as error:
            with self.changed:
                self.error = str(error)
        finally:
            if camera is not None:
                camera.close()
            with self.changed:
                self.ready.set()
                self.changed.notify_all()

    def frame(self, session, after):
        with self.changed:
            self._authorize(session)
            self.last_request = time.monotonic()
            self.changed.wait_for(lambda: self.error or self.sequence > after or self.stop_event.is_set(), timeout=1)
            self._authorize(session)
            if self.error:
                raise RuntimeError(self.error)
            if self.stop_event.is_set() or not self.packet:
                raise RuntimeError('Astra has stopped')
            if time.monotonic() - self.captured_at > 1:
                raise RuntimeError('Astra stream is stale; stop and reconnect the camera')
            return self.packet if self.sequence > after else None

    def _authorize(self, session):
        if not session or session != self.session:
            raise PermissionError('Stale or invalid Astra session')

    def stop(self, session=None, shutdown=False):
        with self.lifecycle:
            with self.changed:
                if not shutdown:
                    self._authorize(session)
                thread = self.thread
                if thread is None:
                    return
                self.stop_event.set()
                self.changed.notify_all()
            thread.join(timeout=8)
            if thread.is_alive():
                raise RuntimeError('Camera is still releasing; do not open another capture process')
            with self.changed:
                self.thread = self.packet = None
                self.session = None


def handler_for(manager, directory, port):
    allowed_hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def _check_host(self):
            if self.headers.get('Host') not in allowed_hosts:
                self.send_error(403, 'Use localhost or 127.0.0.1')
                return False
            return True

        def _send(self, data, content_type='application/json', status=200):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(data)

        def _json(self, data, status=200):
            self._send(json.dumps(data).encode(), status=status)

        def do_GET(self):
            if not self._check_host():
                return
            route = urlsplit(self.path)
            if route.path == '/api/astra/frame':
                query = parse_qs(route.query)
                try:
                    packet = manager.frame(query.get('session', [''])[0], int(query.get('after', ['0'])[0]))
                except (RuntimeError, ValueError, PermissionError) as error:
                    self._json({'error': str(error)}, 409)
                    return
                try:
                    self._send(packet or b'', 'application/octet-stream', 200 if packet else 204)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    self.close_connection = True
            elif route.path.startswith('/api/'):
                self.send_error(404)
            else:
                super().do_GET()

        def do_POST(self):
            if not self._check_host():
                return
            origin = self.headers.get('Origin')
            if (self.headers.get('X-KineGlow-Client') != '1'
                    or self.headers.get_content_type() != 'application/json'
                    or (origin is not None and origin not in {f'http://{h}' for h in allowed_hosts})):
                self._json({'error': 'Same-origin AIRFORM client required'}, 403)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 <= size <= 4096:
                    raise ValueError('Invalid body size')
                body = json.loads(self.rfile.read(size) or b'{}')
                if not isinstance(body, dict):
                    raise ValueError('Expected a JSON object')
                if self.path == '/api/astra/start':
                    self._json(manager.start())
                elif self.path == '/api/astra/stop':
                    manager.stop(body.get('session'))
                    self._json({'stopped': True})
                else:
                    self.send_error(404)
            except (RuntimeError, ValueError, PermissionError) as error:
                self._json({'error': str(error)}, 409)

        def list_directory(self, path):
            self.send_error(404)

        def log_request(self, code='-', size='-'):
            # A frame request happens many times/second; keep console output
            # useful and never log the per-session token in its query string.
            if urlsplit(self.path).path == '/api/astra/frame':
                if isinstance(code, int) and code >= 400:
                    self.log_message('Astra frame request: HTTP %s', code)
                return
            super().log_request(code, size)

    return Handler


def probe(factory, frames):
    camera = factory()
    try:
        start = time.monotonic()
        rows = []
        for _ in range(frames):
            bgr, depth, timing = camera.read()
            valid = depth[depth > 0]
            rows.append({'depth_index': timing['depth_index'], 'valid_depth_pixels': len(valid),
                         'median_mm': float(np.median(valid)) if len(valid) else None,
                         'host_pair_gap_ms': timing['host_pair_gap_ms']})
        return {'device': camera.info, 'calibration': camera.depth.params.as_dict(),
                'frames': frames, 'seconds': time.monotonic() - start,
                'color_shape': list(bgr.shape), 'aligned_depth_shape': list(depth.shape),
                'first': rows[0], 'last': rows[-1],
                'all_frames_have_depth': all(row['valid_depth_pixels'] > 0 for row in rows),
                'depth_indices_increase': all(a['depth_index'] < b['depth_index'] for a, b in zip(rows, rows[1:])),
                'note': 'Host-paired RGB-D; not hardware synchronized. No camera images saved.'}
    finally:
        camera.close()


class WorkshopServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--openni-dir')
    parser.add_argument('--uri')
    parser.add_argument('--color-index', type=int)
    parser.add_argument('--color-mirrored', action='store_true', help='Unmirror firmware-mirrored UVC input before registration')
    parser.add_argument('--port', type=int, default=None)
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--open-browser', action='store_true')
    parser.add_argument('--frames', type=int, default=30)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    if not 1 <= args.frames <= 1000 or (args.port is not None and not 1024 <= args.port <= 65535):
        parser.error('frames must be 1..1000; port must be 1024..65535')
    options = dict(openni_dir=args.openni_dir, uri=args.uri, color_index=args.color_index,
                   color_mirrored=args.color_mirrored)
    if args.probe:
        result = probe(partial(AstraCamera, **options), args.frames)
        content = json.dumps(result, indent=2)
        print(content)
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(content, encoding='utf-8')
        if not result['all_frames_have_depth'] or not result['depth_indices_increase']:
            raise RuntimeError('Astra probe did not produce valid advancing depth frames')
        return
    if not (DIST / 'index.html').is_file():
        parser.error('Build the frontend first: npm --prefix web run build')
    manager = CaptureManager(partial(IsolatedAstra, **options))
    ports = [args.port] if args.port is not None else [4187, 4188]
    for port in ports:
        try:
            server = WorkshopServer(('127.0.0.1', port), handler_for(manager, DIST, port))
            break
        except OSError as exc:
            if port == ports[-1] or exc.errno not in (48, 98, 10013, 10048):
                raise
    print(f'AIRFORM Astra: http://127.0.0.1:{port}/?input=astra (camera opens only after Start)', flush=True)
    if args.open_browser:
        webbrowser.open(f'http://127.0.0.1:{port}/?input=astra')
    try:
        server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        manager.stop(shutdown=True)
        server.server_close()


if __name__ == '__main__':
    main()
