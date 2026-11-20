"""Pair Astra OpenNI depth with its VID/PID-selected UVC color stream."""
import time

import cv2
from cv2_enumerate_cameras import enumerate_cameras

from .openni import OpenNIDepth
from .registration import DepthRegistration


class AstraCamera:
    def __init__(self, openni_dir=None, uri=None, color_index=None, color_mirrored=False):
        self.depth = self.color = None
        self.color_mirrored = color_mirrored
        try:
            self.depth = OpenNIDepth(openni_dir, uri)
            candidates = [c for c in enumerate_cameras(cv2.CAP_DSHOW)
                          if c.vid == 0x2BC5 and c.pid == 0x050F
                          and (color_index is None or c.index == color_index)]
            if len(candidates) != 1:
                raise RuntimeError(f'Expected one Astra UVC camera (2bc5:050f), found {len(candidates)}; use --color-index if needed.')
            color = candidates[0]
            self.info = {**self.depth.info, 'color_name': color.name, 'color_index': color.index}
            self.color = cv2.VideoCapture(color.index, cv2.CAP_DSHOW)
            if not self.color.isOpened():
                raise RuntimeError('Cannot open Astra color camera; close other camera programs')
            self.color.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.color.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            self.color.set(cv2.CAP_PROP_FPS, 30)
            self.registration = DepthRegistration(self.depth.params.as_dict())
        except BaseException:
            self.close()
            raise

    def read(self):
        # UVC and OpenNI are separate clocks. These are sequential host-paired
        # frames, NOT hardware-synchronized RGB-D. Expose host read separation.
        if not self.color.grab():
            raise RuntimeError('Astra color stream disconnected')
        color_grab = time.perf_counter()
        depth, timing = self.depth.read()
        depth_read = time.perf_counter()
        ok, bgr = self.color.retrieve()
        if not ok or bgr.shape != (480, 640, 3):
            raise RuntimeError('Expected 640x480 Astra color frame')
        if self.color_mirrored:
            bgr = cv2.flip(bgr, 1)
        aligned = self.registration.align(depth)
        return bgr, aligned, {**timing,
                             'host_pair_gap_ms': (depth_read - color_grab) * 1000,
                             'captured_monotonic': depth_read,
                             'synchronization': 'host-paired-not-hardware-synchronized'}

    def close(self):
        if self.color is not None:
            self.color.release()
            self.color = None
        if self.depth is not None:
            self.depth.close()
            self.depth = None
