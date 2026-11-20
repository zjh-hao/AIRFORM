"""Hardware-free tests: calibration geometry, ownership, lease and HTTP boundary."""
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
from backend.astra.server import CaptureManager, handler_for, pack_frame
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


if __name__ == '__main__':
    unittest.main()
