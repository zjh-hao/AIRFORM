"""Serve the real AIRFORM frontend with a physical camera or a repeatable RGB-D input."""
import argparse
import math
from pathlib import Path
import sys
import time
from types import SimpleNamespace


FPS = 30
PERIOD = 24  # frames per sweep, 0.8 seconds
SWEEPS = 8
RECOVERIES = 5
WARM = 150
STATIC = 90
MOTION_END = WARM + STATIC + SWEEPS * PERIOD
END = MOTION_END + RECOVERIES * 30


class Replay:
    def __init__(self, fixture):
        import cv2
        import numpy as np

        # The original crop is labeled Left by both runtimes. Flip the fixture
        # pixels once so the known open-hand motion exercises the right-hand pen.
        image = cv2.imdecode(np.frombuffer(fixture.read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
        hand = cv2.flip(image[595:810, :355], 1)
        self.images = {dx: self.place(hand, dx) for dx in {0, *map(self.shift, range(PERIOD))}}
        self.blank = self.place(None, 0)
        self.depth = np.full((480, 640), 700, dtype=np.uint16)
        rng = np.random.default_rng(4197)
        self.static = []
        base = self.images[0].astype(np.int16)
        for sample in range(30):
            noise = np.rint(rng.normal(0, 3, base.shape)).astype(np.int16)
            color = np.clip(base + noise + sample % 7 - 3, 0, 255).astype(np.uint8)
            depth = np.clip(700 + rng.integers(-6, 7, (480, 640)), 0, 65535).astype(np.uint16)
            self.static.append((color, depth))
        self.info = {'color_name': 'AIRFORM validation fixture', 'fps': FPS}
        self.registration = SimpleNamespace(metadata={
            'width': 640, 'height': 480, 'intrinsics': [500, 500, 320, 240], 'distortion': [0] * 5,
            'depth_unit': 'mm', 'coordinate_system': 'color-camera',
            'registration': 'factory-calibrated-software', 'mirrored': False,
        })
        self.epoch = time.perf_counter()
        self.index = 0

    @staticmethod
    def place(hand, dx):
        import numpy as np

        canvas = np.full((480, 640, 3), 29, dtype=np.uint8)
        if hand is not None:
            left = 142 + dx
            canvas[120:335, left:left + 355] = hand
        return canvas

    @staticmethod
    def shift(index):
        return round(105 * math.sin(2 * math.pi * index / PERIOD))

    def read(self):
        interval = 1 / FPS
        # Keep the input clock advancing even when a consumer is delayed.
        self.index = max(self.index, int((time.perf_counter() - self.epoch) * FPS))
        index = self.index
        self.index += 1
        captured = self.epoch + index * interval
        time.sleep(max(0, captured - time.perf_counter()))
        phase, trial, offset = 'tail', 0, 0
        image, depth = self.images[0], self.depth
        if index < WARM:
            phase = 'warm'
        elif index < WARM + STATIC:
            phase = 'static'
            image, depth = self.static[(index - WARM) % FPS]
        elif index < MOTION_END:
            phase = 'motion'
            trial, offset = divmod(index - WARM - STATIC, PERIOD)
            image = self.images[self.shift(offset)]
        elif index < END:
            trial, offset = divmod(index - MOTION_END, 30)
            phase = 'occluded' if offset < 12 else 'reveal'
            if phase == 'occluded':
                image = self.blank
        return image, depth, {
            'depth_index': index + 1, 'depth_timestamp_us': round(index * interval * 1e6),
            'captured_monotonic': captured, 'host_pair_gap_ms': 0,
            'synchronization': 'synthetic RGB-D fixture', 'test_phase': phase,
            'test_trial': trial, 'test_offset': offset,
        }

    def close(self):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--tracked', action='store_true')
    parser.add_argument('--live', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    sys.path.insert(0, str(root))
    from backend.astra.server import CaptureManager, DIST, IsolatedAstra, WorkshopServer, handler_for

    factory = IsolatedAstra if args.live else lambda: Replay(root / '.cache/woman_hands.jpg')
    manager = CaptureManager(factory, **({'tracked': True} if args.tracked else {}))

    class Handler(handler_for(manager, DIST, args.port)):
        def do_GET(self):
            if self.path == '/__ab_clock':
                if self._check_host():
                    self._json({'monotonicMs': time.perf_counter() * 1000})
            else:
                super().do_GET()

        def log_request(self, code='-', size='-'):
            if self.path != '/__ab_clock':
                super().log_request(code, size)

    with WorkshopServer(('127.0.0.1', args.port), Handler) as server:
        print(f'Local A/B endpoint: http://127.0.0.1:{args.port}/?input=astra', flush=True)
        try:
            server.serve_forever(poll_interval=.2)
        except KeyboardInterrupt:
            pass
        finally:
            manager.stop(shutdown=True)


if __name__ == '__main__':
    main()
