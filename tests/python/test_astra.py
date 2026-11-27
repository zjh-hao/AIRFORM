"""Test Astra calibration, tracking, camera sessions and HTTP requests without hardware."""
import http.client
import json
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from http.server import ThreadingHTTPServer

import numpy as np

from backend.astra.registration import DepthRegistration
from backend.astra.hand_gpu import GpuHandTracker, HAND_SIZE, PALM_ANCHORS, PALM_SCAN_INTERVAL, PALM_SIZE, Square, _predict_rect, rotation_matrix
from backend.astra.hand_tracking import TrackedAstra
from backend.astra.server import CaptureManager, handler_for, pack_frame
from backend.astra.sketch_model import get_sketch_recognizer
from backend.astra.openni import is_astra_pro_plus


def calibration():
    return {'depth_intrinsics': [500, 500, 320, 240], 'color_intrinsics': [500, 500, 320, 240],
            'depth_distortion': [0]*5, 'color_distortion': [0]*5,
            'rotation': np.eye(3).ravel().tolist(), 'translation_mm': [0]*3}


class FakeCamera:
    opened = closed = 0

    def __init__(self):
        type(self).opened += 1
        self.registration = SimpleNamespace(metadata={'width': 640, 'height': 480})
        self.info = {'name': 'test'}

    def read(self):
        time.sleep(.005)
        return np.zeros((480, 640, 3), np.uint8), np.full((480, 640), 1000, np.uint16), {}

    def close(self):
        type(self).closed += 1


class AstraTests(unittest.TestCase):
    def test_astra_device_identity_with_numeric_or_windows_uri_ids(self):
        device = lambda vid, pid, uri: SimpleNamespace(vid=vid, pid=pid, uri=uri)
        path = rb'\\?\usb#vid_2bc5&pid_060f&mi_00#device'
        self.assertTrue(is_astra_pro_plus(device(0x2BC5, 0x060F, b'')))
        self.assertTrue(is_astra_pro_plus(device(0, 0, path.upper())))
        self.assertFalse(is_astra_pro_plus(device(0x2BC5, 0x050F, path)))
        self.assertFalse(is_astra_pro_plus(device(0, 0, path.replace(b'060f', b'060ff'))))
        self.assertFalse(is_astra_pro_plus(device(0, 0, b'other#vid_2bc5&pid_060f&mi_00')))

    def test_identity_registration_and_holes(self):
        r = DepthRegistration(calibration())
        d = np.zeros((480, 640), np.uint16)
        d[200:220, 300:320] = 1000
        np.testing.assert_array_equal(r.align(d), d)

    def test_extrinsic_translation_and_color_axial_z(self):
        c = calibration()
        c['translation_mm'] = [-20, 0, 100]
        r = DepthRegistration(c)
        d = np.zeros((480, 640), np.uint16)
        d[240, 320] = 1000
        a = r.align(d)
        self.assertEqual(a[240, 311], 1100)
        self.assertEqual(np.count_nonzero(a), 1)

    def test_nearest_surface_wins_projection_collision(self):
        c = calibration()
        c['color_intrinsics'][0] = 1
        r = DepthRegistration(c)
        d = np.zeros((480, 640), np.uint16)
        d[240, 320], d[240, 321] = 800, 1500
        self.assertEqual(r.align(d)[240, 320], 800)

    def test_invalid_calibration_and_resolution(self):
        c = calibration()
        c['color_intrinsics'][0] = 0
        with self.assertRaises(ValueError):
            DepthRegistration(c)
        with self.assertRaises(ValueError):
            DepthRegistration(calibration(), 320, 240)

    def test_packet_layout_matches_depth_and_jpeg(self):
        d = np.full((480, 640), 1234, np.uint16)
        p = pack_frame(np.zeros((480, 640, 3), np.uint8), d, {'sequence': 1})
        n, = struct.unpack_from('<I', p)
        h = json.loads(p[4:4+n])
        self.assertEqual(h['version'], 1)
        self.assertEqual(p[4+n:6+n], b'\xff\xd8')
        np.testing.assert_array_equal(np.frombuffer(p, '<u2', offset=4+n+h['jpeg_bytes']).reshape(d.shape), d)

    def test_stop_restart_and_stale_clients_cannot_stop_new_session(self):
        m = CaptureManager(FakeCamera)
        try:
            first = m.start()['session']
            self.assertTrue(m.frame(first, 0))
            with self.assertRaises(RuntimeError):
                m.start()
            m.stop(first)
            second = m.start()['session']
            with self.assertRaises(PermissionError):
                m.stop(first)
            with self.assertRaises(PermissionError):
                m.frame(first, 0)
            self.assertTrue(m.frame(second, 0))
            m.stop(second)
        finally:
            m.stop(shutdown=True)

    def test_browser_crash_expires_lease_and_releases_camera(self):
        before = FakeCamera.closed
        m = CaptureManager(FakeCamera, lease_seconds=.1)
        try:
            session = m.start()['session']
            m.thread.join(1)
            self.assertFalse(m.thread.is_alive())
            self.assertEqual(FakeCamera.closed, before+1)
            with self.assertRaisesRegex(RuntimeError, 'expired'):
                m.frame(session, 0)
        finally:
            m.stop(shutdown=True)

    def test_capture_exception_releases_camera_and_surfaces_error(self):
        class Broken(FakeCamera):
            def read(self):
                raise RuntimeError('unplugged')
        m = CaptureManager(Broken)
        try:
            with self.assertRaisesRegex(RuntimeError, 'unplugged'):
                m.start()
            m.thread.join(1)
            self.assertEqual(Broken.opened, Broken.closed)
        finally:
            m.stop(shutdown=True)

    def test_slow_python_tracker_keeps_the_matched_latest_color_depth_and_timestamp(self):
        class Camera(FakeCamera):
            index = 0

            def read(self):
                time.sleep(.002)
                self.index += 1
                return (np.full((1, 1, 3), self.index, np.uint8), np.full((1, 1), self.index, np.uint16),
                        {'captured_monotonic': self.index * .002, 'depth_index': self.index})

        class Tracker:
            def __init__(self, mode):
                self.mode = mode
                self.closed = False

            def detect(self, image, captured_at):
                time.sleep(.035)
                return {'color': int(image[0, 0, 0]), 'captured_at': captured_at}

            def close(self):
                self.closed = True

        source = TrackedAstra(Camera, 'VIDEO', Tracker)
        try:
            first = source.read()[2]
            bgr, depth, second = source.read()
            index = second['sequence']
            self.assertGreater(index, first['sequence'] + 1)
            self.assertEqual(index, second['depth_index'])
            self.assertEqual(index, depth[0, 0])
            self.assertEqual(index, bgr[0, 0, 0])
            self.assertEqual(second['tracking'], {'color': index, 'captured_at': index * .002})
        finally:
            source.close()
        self.assertFalse(source.thread.is_alive())
        self.assertTrue(source.tracker.closed)
        self.assertEqual(Camera.opened, Camera.closed)

    def test_http_requires_local_host_and_same_origin_custom_header(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'index.html').write_text('test')
            m = CaptureManager(FakeCamera)
            server = ThreadingHTTPServer(('127.0.0.1', 0), lambda *args: None)
            port = server.server_address[1]
            server.RequestHandlerClass = handler_for(m, directory, port)
            t = threading.Thread(target=server.serve_forever, daemon=True)
            t.start()
            try:
                c = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                c.request('POST', '/api/astra/start', '{}', {'Content-Type': 'application/json'})
                self.assertEqual(c.getresponse().status, 403)
                c.close()
                c = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                c.request('GET', '/', headers={'Host': 'untrusted.example'})
                self.assertEqual(c.getresponse().status, 403)
                c.close()
                c = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                c.request('POST', '/api/astra/start', '{}', {'Content-Type': 'application/json',
                          'X-KineGlow-Client': '1', 'Origin': 'http://untrusted.example'})
                self.assertEqual(c.getresponse().status, 403)
                c.close()
            finally:
                server.shutdown(); server.server_close(); m.stop(shutdown=True)

    def test_registration_empty_depth_returns_zeros(self):
        r = DepthRegistration(calibration())
        d = np.zeros((480, 640), np.uint16)
        out = r.align(d)
        self.assertEqual(out.dtype, np.uint16)
        self.assertEqual(out.shape, (480, 640))
        self.assertEqual(np.count_nonzero(out), 0)

    def test_gpu_tracker_skips_redundant_palm_scans_predicts_motion_recovers_and_holds_deadband(self):
        class FakePalm:
            def __init__(self, state):
                self.state = state
                self.calls = 0

            def run(self, _outputs, _inputs):
                self.calls += 1
                raw = np.zeros((1, len(PALM_ANCHORS), 18), dtype=np.float32)
                logits = np.full((1, len(PALM_ANCHORS), 1), -10.0, dtype=np.float32)
                tx, ty = self.state['hand_xy']
                anchor = PALM_ANCHORS[0]
                cx = (tx / 640.0 - anchor[0]) * PALM_SIZE
                cy = ((ty + 80.0) / 640.0 - anchor[1]) * PALM_SIZE
                raw[0, 0, 0:4] = [cx, cy, .25 * PALM_SIZE, .25 * PALM_SIZE]
                raw[0, 0, 4:6] = [cx, cy + .08 * PALM_SIZE]
                raw[0, 0, 8:10] = [cx, cy - .08 * PALM_SIZE]
                logits[0, 0, 0] = 10.0
                return raw, logits

        class FakeHand:
            def __init__(self, state):
                self.state = state
                self.calls = 0

            def run(self, _outputs, _inputs):
                self.calls += 1
                rect = self.state['rect_provider']
                # Only report present when last_crop center covers hand_xy.
                cx, cy = self.state['hand_xy']
                in_box = True
                if rect is not None and not self.state['force_present']:
                    rcx, rcy = float(rect.center[0]), float(rect.center[1])
                    in_box = max(abs(cx - rcx), abs(cy - rcy)) <= rect.side * 0.6
                presence = np.array([[[0.95 if in_box else 0.05]]], dtype=np.float32)
                # Build synthetic 21 landmarks centered at hand_xy with realistic ~80px span.
                hand_pts = np.tile([cx, cy], (21, 1)).astype(np.float32)
                hand_pts[0] = [cx, cy + 40]
                hand_pts[6] = [cx - 10, cy - 20]
                hand_pts[10] = [cx, cy - 25]
                hand_pts[14] = [cx + 10, cy - 20]
                hand_pts[5] = [cx - 15, cy - 5]
                hand_pts[9] = [cx, cy - 8]
                hand_pts[13] = [cx + 12, cy - 5]
                hand_pts[17] = [cx + 22, cy]
                hand_pts[8] = [cx, cy - 45]
                if rect is not None:
                    axes = rotation_matrix(rect.angle)
                    local_xy = ((hand_pts - rect.center) @ axes) / rect.side + .5
                else:
                    local_xy = .5 + (hand_pts - np.array([cx, cy], dtype=np.float32)) / 200.0
                img_xyz = np.column_stack((local_xy * HAND_SIZE, np.zeros(21, dtype=np.float32))).astype(np.float32)
                side = np.array([[[0.9]]], dtype=np.float32)
                world = np.zeros((1, 21, 3), dtype=np.float32)
                return img_xyz[None], presence, side, world

        state = {'hand_xy': np.array([320.0, 240.0], dtype=np.float32), 'rect_provider': None, 'force_present': True}
        tracker = object.__new__(GpuHandTracker)
        tracker.mode = 'VIDEO'
        tracker.threshold = .28
        tracker.palm = FakePalm(state)
        tracker.hand = FakeHand(state)
        tracker.previous = []
        tracker._velocities = []
        tracker._prev_ts = None
        tracker._frames_since_palm = 0
        tracker.epoch = None
        tracker.timestamp_ms = -1

        orig_run = tracker._run_landmarks
        def wrapped_run(rgb, rect, width, height):
            state['rect_provider'] = rect
            return orig_run(rgb, rect, width, height)
        tracker._run_landmarks = wrapped_run

        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        # 1. Steady / sub-deadband jitter frames should skip palm scan except at PALM_SCAN_INTERVAL.
        t = 0.0
        r0 = tracker.detect(frame, t)
        self.assertEqual(len(r0['landmarks']), 1)
        self.assertEqual(tracker.palm.calls, 1)
        prev_rect = Square(tracker.previous[0].center.copy(), tracker.previous[0].side, tracker.previous[0].angle)

        for i in range(1, PALM_SCAN_INTERVAL + 1):
            t += 1.0 / 30.0
            state['hand_xy'] = np.array([320.0 + (1.5 if i % 2 else -1.5), 240.0], dtype=np.float32)
            res = tracker.detect(frame, t)
            self.assertEqual(len(res['landmarks']), 1)
            self.assertEqual(tracker.palm.calls, 1)
            self.assertTrue(np.allclose(tracker.previous[0].center, prev_rect.center))
            self.assertTrue(np.allclose(tracker._velocities[0], 0.0))

        # After PALM_SCAN_INTERVAL skipped frames, periodic palm scan refreshes.
        t += 1.0 / 30.0
        tracker.detect(frame, t)
        self.assertEqual(tracker.palm.calls, 2)

        # 2. Fast motion builds velocity and expands predicted ROI.
        for step in range(1, 5):
            t += 1.0 / 30.0
            state['hand_xy'] = np.array([320.0 + step * 35.0, 240.0], dtype=np.float32)
            tracker.detect(frame, t)
        self.assertGreater(tracker._velocities[0][0], 100.0)
        pred = _predict_rect(tracker.previous[0], tracker._velocities[0], 1.0 / 30.0, 640, 480)
        self.assertGreater(pred.center[0], tracker.previous[0].center[0])
        self.assertGreater(pred.side, tracker.previous[0].side)

        # 3. Sudden extreme jump causes ROI loss, triggering same-frame palm fallback without dropping frame.
        calls_before = tracker.palm.calls
        state['force_present'] = False
        t += 1.0 / 30.0
        state['hand_xy'] = np.array([100.0, 120.0], dtype=np.float32)
        recovered = tracker.detect(frame, t)
        self.assertEqual(tracker.palm.calls, calls_before + 1)
        self.assertEqual(len(recovered['landmarks']), 1)

    def test_sketch_endpoint_security_and_real_onnx_inference(self):
        recognizer = get_sketch_recognizer()
        status = recognizer.status()
        self.assertTrue(status['available'], f'Sketch ONNX models must be cached under .cache/sketch-models: {status}')
        self.assertTrue(status['quickdrawReady'])
        self.assertTrue(status['ocrReady'])

        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'index.html').write_text('test')
            m = CaptureManager(FakeCamera)
            server = ThreadingHTTPServer(('127.0.0.1', 0), lambda *args: None)
            port = server.server_address[1]
            server.RequestHandlerClass = handler_for(m, directory, port, sketch_recognizer=recognizer)
            t = threading.Thread(target=server.serve_forever, daemon=True)
            t.start()
            try:
                # 403 when custom client header is missing
                c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                c.request('POST', '/api/sketch/recognize', '{"strokes":[[[0,0],[1,1]]]}', {'Content-Type': 'application/json'})
                self.assertEqual(c.getresponse().status, 403)
                c.close()

                # GET /api/sketch/status succeeds
                c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                c.request('GET', '/api/sketch/status', headers={'Host': f'127.0.0.1:{port}'})
                resp = c.getresponse()
                self.assertEqual(resp.status, 200)
                self.assertTrue(json.loads(resp.read().decode())['available'])
                c.close()

                def post_recognize(strokes, closed_hint=False):
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                    payload = json.dumps({'strokes': strokes, 'closedHint': closed_hint})
                    conn.request('POST', '/api/sketch/recognize', payload, {
                        'Host': f'127.0.0.1:{port}',
                        'Origin': f'http://127.0.0.1:{port}',
                        'Content-Type': 'application/json',
                        'X-KineGlow-Client': '1',
                    })
                    r = conn.getresponse()
                    self.assertEqual(r.status, 200)
                    data = json.loads(r.read().decode())
                    conn.close()
                    return data

                # Crescent moon -> moon
                t1 = np.linspace(np.pi * 0.42, -np.pi * 0.42, 28)
                t2 = np.linspace(-np.pi * 0.42, np.pi * 0.42, 28)
                moon = np.vstack([
                    np.stack([np.cos(t1) * 0.8, np.sin(t1) * 0.85], 1),
                    np.stack([0.28 + np.cos(t2) * 0.55, np.sin(t2) * 0.82], 1),
                ]).tolist()
                self.assertEqual(post_recognize([moon], closed_hint=True).get('type'), 'moon')

                # 5-point star -> star
                star = [[float(np.cos(np.pi / 2 + k * 2 * np.pi / 5) * 0.85),
                         float(np.sin(np.pi / 2 + k * 2 * np.pi / 5) * 0.85)] for k in (0, 2, 4, 1, 3, 0)]
                self.assertEqual(post_recognize([star]).get('type'), 'star')

                # Lightning bolt -> lightning
                self.assertEqual(post_recognize([[[0.25, 0.85], [-0.25, 0.05], [0.15, 0.05], [-0.25, -0.85]]]).get('type'), 'lightning')

                # Handwritten single-stroke M & multi-stroke A / T -> letters
                m_res = post_recognize([[[-0.6, -0.8], [-0.5, 0.8], [0.0, -0.1], [0.5, 0.8], [0.6, -0.8]]])
                self.assertEqual(m_res.get('type'), 'letter')
                self.assertEqual(m_res.get('char'), 'M')

                a_res = post_recognize([[[-0.5, -0.8], [0.0, 0.8], [0.5, -0.8]], [[-0.3, -0.1], [0.3, -0.1]]])
                self.assertEqual(a_res.get('type'), 'letter')
                self.assertEqual(a_res.get('char'), 'A')

                t_res = post_recognize([[[-0.6, 0.8], [0.6, 0.8]], [[0.0, 0.8], [0.0, -0.8]]])
                self.assertEqual(t_res.get('type'), 'letter')
                self.assertEqual(t_res.get('char'), 'T')

                # Open C variants -> letter 'C' (not moon), continuous/3-stroke A -> 'A',
                # 4-stroke E -> 'E', 3-stroke H -> 'H', and 9-stroke sun (> 8 polylines limit) -> 'sun'
                c270 = np.stack([
                    np.cos(np.deg2rad(np.linspace(45, 315, 28))) * 0.75,
                    np.sin(np.deg2rad(np.linspace(45, 315, 28))) * 0.95,
                ], 1).tolist()
                self.assertEqual(post_recognize([c270], closed_hint=False).get('char'), 'C')
                self.assertEqual(post_recognize([[[0.5, 0.85], [-0.5, 0.85], [-0.5, -0.85], [0.5, -0.85]]]).get('char'), 'C')
                self.assertEqual(post_recognize([[[-0.55, -0.85], [0.0, 0.85], [0.55, -0.85], [0.25, -0.15], [-0.35, -0.15]]]).get('char'), 'A')
                self.assertEqual(post_recognize([[[0.0, 0.85], [-0.5, -0.8]], [[0.0, 0.85], [0.5, -0.8]], [[-0.3, -0.15], [0.3, -0.15]]]).get('char'), 'A')
                self.assertEqual(post_recognize([[[-0.45, 0.8], [-0.45, -0.8]], [[-0.45, 0.8], [0.45, 0.8]], [[-0.45, 0.0], [0.35, 0.0]], [[-0.45, -0.8], [0.45, -0.8]]]).get('char'), 'E')
                self.assertEqual(post_recognize([[[-0.45, 0.8], [-0.45, -0.8]], [[0.45, 0.8], [0.45, -0.8]], [[-0.45, 0.0], [0.45, 0.0]]]).get('char'), 'H')
                sun_ring = np.stack([np.cos(np.linspace(0, 2 * np.pi, 28)) * 0.34, np.sin(np.linspace(0, 2 * np.pi, 28)) * 0.34], 1).tolist()
                sun_rays = [[[float(np.cos(i * np.pi / 4) * 0.48), float(np.sin(i * np.pi / 4) * 0.48)],
                             [float(np.cos(i * np.pi / 4) * 0.85), float(np.sin(i * np.pi / 4) * 0.85)]] for i in range(8)]
                self.assertEqual(post_recognize([sun_ring] + sun_rays).get('type'), 'sun')

                # v9 accuracy upgrades: 1-stroke & 2-stroke heart, Z vs lightning, G vs moon, pine tree, slanted E/R
                ht = np.linspace(0, 2 * np.pi, 48)
                heart_pts = np.stack([
                    16 * np.sin(ht) ** 3 / 18.0,
                    (13 * np.cos(ht) - 5 * np.cos(2 * ht) - 2 * np.cos(3 * ht) - np.cos(4 * ht)) / 18.0,
                ], 1)
                self.assertEqual(post_recognize([heart_pts.tolist()], closed_hint=True).get('type'), 'heart')
                self.assertEqual(post_recognize([heart_pts[:25].tolist(), np.vstack([heart_pts[0:1], heart_pts[47:23:-1]]).tolist()]).get('type'), 'heart')
                self.assertEqual(post_recognize([[[-0.5, 0.85], [0.5, 0.85], [-0.5, -0.85], [0.5, -0.85]]]).get('char'), 'Z')
                g_pts = np.stack([np.cos(np.deg2rad(np.linspace(45, 345, 28))) * 0.65, np.sin(np.deg2rad(np.linspace(45, 345, 28))) * 0.85], 1).tolist() + [[0.65, -0.05], [0.05, -0.05]]
                self.assertEqual(post_recognize([g_pts]).get('char'), 'G')
                self.assertEqual(post_recognize([[[0, 0.85], [-0.5, 0.15], [0.5, 0.15], [0, 0.85]], [[-0.65, -0.35], [0, 0.3], [0.65, -0.35], [-0.65, -0.35]], [[0, -0.35], [0, -0.85]]]).get('type'), 'tree')
                # Circle must never false-trigger heart
                circ = np.stack([np.cos(np.linspace(0, 2 * np.pi, 32)) * 0.8, np.sin(np.linspace(0, 2 * np.pi, 32)) * 0.8], 1).tolist()
                self.assertEqual(post_recognize([circ], closed_hint=True).get('type'), 'sphere')

                # Single simple line does not prematurely trigger
                self.assertFalse(post_recognize([[[0.0, 0.8], [0.0, -0.8]]])['recognized'])

                # Single-roundtrip fallbackStrokes: primary stroke pair doesn't match,
                # fallback stroke (handwritten M) succeeds in the same POST.
                fb_payload = json.dumps({
                    'strokes': [[[0.0, 0.8], [0.0, -0.8]]],
                    'fallbackStrokes': [[[-0.6, -0.8], [-0.5, 0.8], [0.0, -0.1], [0.5, 0.8], [0.6, -0.8]]],
                })
                c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                c.request('POST', '/api/sketch/recognize', fb_payload, {
                    'Host': f'127.0.0.1:{port}',
                    'Origin': f'http://127.0.0.1:{port}',
                    'Content-Type': 'application/json',
                    'X-KineGlow-Client': '1',
                })
                fb_resp = json.loads(c.getresponse().read().decode())
                self.assertTrue(fb_resp['recognized'])
                self.assertTrue(fb_resp['usedFallback'])
                self.assertEqual(fb_resp['char'], 'M')
                c.close()
            finally:
                server.shutdown(); server.server_close(); m.stop(shutdown=True)

    def test_http11_keepalive_reuses_single_socket_across_200_and_204(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'index.html').write_text('hello-keepalive')
            m = CaptureManager(FakeCamera)
            server = ThreadingHTTPServer(('127.0.0.1', 0), lambda *args: None)
            server.daemon_threads = True
            port = server.server_address[1]
            server.RequestHandlerClass = handler_for(m, directory, port)
            t = threading.Thread(target=server.serve_forever, daemon=True)
            t.start()
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            try:
                sess = m.start()['session']
                conn.request('GET', '/', headers={'Host': f'127.0.0.1:{port}'})
                r1 = conn.getresponse()
                self.assertEqual(r1.status, 200)
                self.assertEqual(r1.read(), b'hello-keepalive')
                sock_fd = conn.sock.fileno()

                # Request latest frame and then 204 when up to date on the SAME socket
                conn.request('GET', f'/api/astra/frame?session={sess}&after=0', headers={'Host': f'127.0.0.1:{port}'})
                r2 = conn.getresponse()
                self.assertEqual(r2.status, 200)
                pkt = r2.read()
                seq = json.loads(pkt[4:4 + struct.unpack_from('<I', pkt)[0]])['sequence']
                self.assertEqual(conn.sock.fileno(), sock_fd)

                conn.request('GET', f'/api/astra/frame?session={sess}&after={seq + 1000}', headers={'Host': f'127.0.0.1:{port}'})
                r3 = conn.getresponse()
                self.assertEqual(r3.status, 204)
                self.assertEqual(r3.read(), b'')
                self.assertEqual(conn.sock.fileno(), sock_fd)

                conn.request('GET', '/api/sketch/status', headers={'Host': f'127.0.0.1:{port}'})
                r4 = conn.getresponse()
                self.assertEqual(r4.status, 200)
                _ = r4.read()
                self.assertEqual(conn.sock.fileno(), sock_fd)
            finally:
                conn.close()
                server.shutdown(); server.server_close(); m.stop(shutdown=True)

    def test_registration_with_nonzero_distortion_matches_reference(self):
        c = calibration()
        c['translation_mm'] = [-25, 12, 50]
        c['depth_distortion'] = [0.02, -0.04, 0.002, -0.002, 0.01]
        c['color_distortion'] = [0.03, -0.05, 0.001, -0.001, 0.008]
        r = DepthRegistration(c)
        d = np.full((480, 640), 1200, np.uint16)
        d[:40, :] = 0
        out = r.align(d)
        self.assertEqual(out.dtype, np.uint16)
        self.assertEqual(out.shape, (480, 640))
        self.assertGreater(np.count_nonzero(out), 250000)
        # Re-running with different depth cleanly clears previous frame's sentinel/pixels
        d2 = np.zeros((480, 640), np.uint16)
        d2[240, 320] = 900
        out2 = r.align(d2)
        self.assertEqual(np.count_nonzero(out2), 1)
        self.assertEqual(int(out2[out2 > 0][0]), 950)


if __name__ == '__main__':
    unittest.main()
