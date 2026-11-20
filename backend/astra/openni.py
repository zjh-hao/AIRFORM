"""Small, typed OpenNI 2.3 C ABI adapter (Windows x64).

ABI/constants follow the lab's OniCAPI.h/OniCTypes.h/OniCProperties.h.
No SDK binaries are copied into this repository. Each instance is owned by
one acquisition thread; OpenNI is process-global, so only one may be open.
"""
import ctypes as C
import os
from pathlib import Path

import numpy as np


class VideoMode(C.Structure):
    _fields_ = [(name, C.c_int) for name in ('format', 'width', 'height', 'fps')]


class DeviceInfo(C.Structure):
    _fields_ = [('uri', C.c_char * 256), ('vendor', C.c_char * 256),
                ('name', C.c_char * 256), ('vid', C.c_uint16), ('pid', C.c_uint16)]


class Frame(C.Structure):
    _fields_ = [('data_size', C.c_int), ('data', C.c_void_p), ('sensor', C.c_int),
                ('timestamp', C.c_uint64), ('index', C.c_int), ('width', C.c_int),
                ('height', C.c_int), ('mode', VideoMode), ('cropped', C.c_int),
                ('origin_x', C.c_int), ('origin_y', C.c_int), ('stride', C.c_int)]


class CameraParams(C.Structure):
    _fields_ = [('depth_intrinsics', C.c_float * 4), ('color_intrinsics', C.c_float * 4),
                ('rotation', C.c_float * 9), ('translation_mm', C.c_float * 3),
                ('depth_distortion', C.c_float * 5), ('color_distortion', C.c_float * 5)]

    def as_dict(self):
        return {name: list(getattr(self, name)) for name, _ in self._fields_}


def find_runtime(explicit=None):
    setting = Path(__file__).resolve().parents[2] / '.cache' / 'openni2-runtime.txt'
    saved = setting.read_text(encoding='utf-8-sig').strip() if setting.is_file() else None
    candidates = [explicit, os.environ.get('OPENNI2_REDIST64'), os.environ.get('OPENNI2_REDIST'), saved,
                  Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'OpenNI2' / 'Redist']
    for candidate in filter(None, candidates):
        path = Path(candidate).resolve()
        if (path / 'OpenNI2.dll').is_file():
            return path
    raise RuntimeError('OpenNI2.dll not found. Set OPENNI2_REDIST64 or pass --openni-dir (x64 runtime with drivers).')


def is_astra_pro_plus(info):
    if info.vid or info.pid:
        return info.vid == 0x2BC5 and info.pid == 0x060F
    # Some official Windows OpenNI builds return zero numeric IDs while
    # preserving the hardware IDs in the Windows USB interface path.
    prefix = rb'\\?\usb#vid_2bc5&pid_060f'
    uri = info.uri.lower()
    return uri.startswith(prefix) and uri[len(prefix):len(prefix)+1] in (b'&', b'#')


class OpenNIDepth:
    def __init__(self, runtime=None, uri=None):
        self.device = C.c_void_p()
        self.stream = C.c_void_p()
        self.initialized = False
        self.runtime = find_runtime(runtime)
        self.dll_directory = os.add_dll_directory(str(self.runtime))
        self.lib = C.CDLL(str(self.runtime / 'OpenNI2.dll'))
        self._bind()
        try:
            self._check(self.lib.oniInitialize(2003), 'initialize OpenNI')
            self.initialized = True
            devices = C.POINTER(DeviceInfo)()
            count = C.c_int()
            self._check(self.lib.oniGetDeviceList(C.byref(devices), C.byref(count)), 'enumerate devices')
            try:
                available = [DeviceInfo.from_buffer_copy(devices[i]) for i in range(count.value)]
            finally:
                self.lib.oniReleaseDeviceList(devices)
            # This adapter is calibrated for the Astra Pro Plus (lab PID 060f).
            matches = [d for d in available if is_astra_pro_plus(d)
                       and (uri is None or d.uri.decode() == uri)]
            if len(matches) != 1:
                raise RuntimeError(f'Expected one Astra Pro Plus (2bc5:060f), found {len(matches)}. Use --uri for multiple cameras.')
            info = matches[0]
            self.info = {'name': info.name.decode(), 'vendor': info.vendor.decode(),
                         'vid': 0x2BC5, 'pid': 0x060F, 'uri': info.uri.decode()}
            self._check(self.lib.oniDeviceOpen(info.uri, C.byref(self.device)), 'open Astra depth')
            self.params = CameraParams()
            size = C.c_int(C.sizeof(self.params))
            self._check(self.lib.oniDeviceGetProperty(self.device, 14, C.byref(self.params), C.byref(size)), 'read factory calibration')
            if size.value != C.sizeof(self.params):
                raise RuntimeError('Unexpected factory calibration ABI size')
            # Raw, unregistered, unmirrored depth: registration is explicit in registration.py.
            self._check(self.lib.oniDeviceCreateStream(self.device, 3, C.byref(self.stream)), 'create depth stream')
            self._set(self.lib.oniStreamSetProperty, self.stream, 3, VideoMode(100, 640, 480, 30))
            self._set(self.lib.oniStreamSetProperty, self.stream, 7, C.c_int(0))
            self._check(self.lib.oniStreamStart(self.stream), 'start depth stream')
            # This firmware exposes registration mode only after stream startup.
            registration = C.c_int(-1)
            registration_size = C.c_int(C.sizeof(registration))
            self._check(self.lib.oniDeviceGetProperty(self.device, 5, C.byref(registration), C.byref(registration_size)), 'read registration mode')
            if registration.value != 0:
                self._set(self.lib.oniDeviceSetProperty, self.device, 5, C.c_int(0))
        except BaseException:
            self.close()
            raise

    def _bind(self):
        handle, integer, pointer = C.c_void_p, C.c_int, C.c_void_p
        signatures = {
            'oniInitialize': ([integer], integer), 'oniShutdown': ([], None),
            'oniGetExtendedError': ([], C.c_char_p),
            'oniGetDeviceList': ([C.POINTER(C.POINTER(DeviceInfo)), C.POINTER(integer)], integer),
            'oniReleaseDeviceList': ([C.POINTER(DeviceInfo)], integer),
            'oniDeviceOpen': ([C.c_char_p, C.POINTER(handle)], integer),
            'oniDeviceClose': ([handle], integer),
            'oniDeviceGetProperty': ([handle, integer, pointer, C.POINTER(integer)], integer),
            'oniDeviceSetProperty': ([handle, integer, pointer, integer], integer),
            'oniDeviceCreateStream': ([handle, integer, C.POINTER(handle)], integer),
            'oniDeviceIsImageRegistrationModeSupported': ([handle, integer], integer),
            'oniStreamSetProperty': ([handle, integer, pointer, integer], integer),
            'oniStreamStart': ([handle], integer), 'oniStreamStop': ([handle], None),
            'oniStreamDestroy': ([handle], None),
            'oniWaitForAnyStream': ([C.POINTER(handle), integer, C.POINTER(integer), integer], integer),
            'oniStreamReadFrame': ([handle, C.POINTER(C.POINTER(Frame))], integer),
            'oniFrameRelease': ([C.POINTER(Frame)], None),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, result

    def _check(self, code, action):
        if code:
            error = (self.lib.oniGetExtendedError() or b'').decode(errors='replace')
            raise RuntimeError(f'Cannot {action}: OpenNI {code}: {error}')

    def _set(self, function, handle, prop, value):
        self._check(function(handle, prop, C.byref(value), C.sizeof(value)), f'set property {prop}')

    def read(self, timeout_ms=1000):
        changed = C.c_int()
        self._check(self.lib.oniWaitForAnyStream(C.byref(self.stream), 1, C.byref(changed), timeout_ms), 'wait for depth')
        frame = C.POINTER(Frame)()
        self._check(self.lib.oniStreamReadFrame(self.stream, C.byref(frame)), 'read depth')
        try:
            f = frame.contents
            if (f.width, f.height, f.mode.format) != (640, 480, 100) or f.cropped:
                raise RuntimeError('Expected uncropped 640x480 millimeter depth')
            if f.stride < f.width * 2 or f.data_size < f.stride * f.height:
                raise RuntimeError('Invalid OpenNI depth buffer size')
            raw = (C.c_uint8 * f.data_size).from_address(f.data)
            array = np.ndarray((f.height, f.width), dtype='<u2', buffer=raw, strides=(f.stride, 2)).copy()
            return array, {'depth_timestamp_us': f.timestamp, 'depth_index': f.index}
        finally:
            self.lib.oniFrameRelease(frame)

    def close(self):
        if self.stream:
            self.lib.oniStreamStop(self.stream)
            self.lib.oniStreamDestroy(self.stream)
            self.stream = C.c_void_p()
        if self.device:
            self.lib.oniDeviceClose(self.device)
            self.device = C.c_void_p()
        if self.initialized:
            self.lib.oniShutdown()
            self.initialized = False
        self.dll_directory.close()
