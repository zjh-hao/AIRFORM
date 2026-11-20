"""Run the workshop's Hand Landmarker on the captured, unmirrored color image."""
from pathlib import Path
import threading
import time
from types import SimpleNamespace

import cv2

MODEL = Path(__file__).resolve().parents[2] / 'assets/models/hand_landmarker.task'


class HandTracker:
    backend = 'Python CPU'

    def __init__(self, mode):
        import mediapipe as mp

        self.mp = mp
        self.mode = mode
        self.epoch = None
        self.timestamp_ms = -1
        vision = mp.tasks.vision
        self.detector = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_buffer=MODEL.read_bytes(),
                                              delegate=mp.tasks.BaseOptions.Delegate.CPU),
            running_mode=vision.RunningMode[mode], num_hands=2,
            **(dict(min_hand_detection_confidence=.28, min_hand_presence_confidence=.28,
                    min_tracking_confidence=.35) if mode == 'VIDEO' else {}),
        ))

    def detect(self, bgr, captured_at):
        if self.epoch is None:
            self.epoch = captured_at
        tick = max(self.timestamp_ms + 1, round((captured_at - self.epoch) * 1000))
        self.timestamp_ms = tick
        begin = time.perf_counter()
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB,
                              data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        started = time.perf_counter()
        result = (self.detector.detect_for_video(image, tick) if self.mode == 'VIDEO'
                  else self.detector.detect(image))
        ended = time.perf_counter()

        def landmarks(hands):
            return [[{'x': p.x, 'y': p.y, 'z': p.z} for p in hand] for hand in hands]

        return {
            'landmarks': landmarks(result.hand_landmarks),
            'worldLandmarks': landmarks(result.hand_world_landmarks),
            'handedness': [[{'categoryName': c.category_name, 'displayName': c.display_name,
                             'index': c.index, 'score': c.score} for c in hand]
                           for hand in result.handedness],
            'inferenceMs': (ended - started) * 1000,
            'preprocessMs': (started - begin) * 1000,
            'timestampMs': tick,
        }

    def close(self):
        self.detector.close()


class TrackedAstra:
    """Overlap capture with inference and keep at most one waiting RGB-D pair."""

    def __init__(self, factory, mode, tracker_factory=HandTracker):
        self.tracker = tracker_factory(mode)
        try:
            self.camera = factory()
        except BaseException:
            self.tracker.close()
            raise
        self.info = self.camera.info
        self.registration = SimpleNamespace(metadata={
            **self.camera.registration.metadata, 'tracking_backend': getattr(self.tracker, 'backend', 'Python'),
            'tracking_mode': mode,
        })
        self.changed = threading.Condition()
        self.stopped = False
        self.latest = self.error = None
        self.sequence = 0
        self.thread = threading.Thread(target=self._capture, name='astra-pair-reader', daemon=True)
        self.thread.start()

    def _capture(self):
        try:
            while True:
                with self.changed:
                    if self.stopped:
                        return
                bgr, depth, timing = self.camera.read()
                with self.changed:
                    self.sequence += 1
                    self.latest = (bgr, depth, {**timing, 'sequence': self.sequence})
                    self.changed.notify()
        except Exception as error:
            with self.changed:
                self.error = error
                self.changed.notify()

    def read(self):
        with self.changed:
            self.changed.wait_for(lambda: self.latest is not None or self.error is not None)
            if self.error is not None:
                raise self.error
            bgr, depth, timing = self.latest
            self.latest = None
        tracking = self.tracker.detect(bgr, timing['captured_monotonic'])
        return bgr, depth, {**timing, 'tracking': tracking}

    def close(self):
        with self.changed:
            self.stopped = True
        self.thread.join()  # IsolatedAstra.read() has a timeout. Keep pipe ownership exclusive.
        try:
            self.camera.close()
        finally:
            self.tracker.close()
