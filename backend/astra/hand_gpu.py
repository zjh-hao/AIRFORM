"""Run the two networks from hand_landmarker.task using ONNX Runtime DirectML.

Tensor decoding and crop geometry follow the MediaPipe hand task graphs.
https://github.com/google-ai-edge/mediapipe/tree/master/mediapipe/tasks/cc/vision
"""
from dataclasses import dataclass
import math
from pathlib import Path
import time

import cv2
import numpy as np

MODEL_DIR = Path(__file__).resolve().parents[2] / '.cache/astra-gpu'
PROVIDER = 'DmlExecutionProvider'
PALM_FILE = 'hand_detector.onnx'
LANDMARK_FILE = 'hand_landmarks_detector.onnx'
HAND_JOINTS = [0, 1, 2, 3, 5, 6, 9, 10, 13, 14, 17, 18]
PALM_SIZE = 192
HAND_SIZE = 224


def palm_anchors():
    groups = []
    for grid, per_cell in ((24, 2), (12, 6)):
        centers = (np.arange(grid, dtype=np.float32) + .5) / grid
        grid_xy = np.stack(np.meshgrid(centers, centers), axis=-1).reshape(-1, 2)
        groups.append(np.repeat(grid_xy, per_cell, axis=0))
    return np.concatenate(groups)


PALM_ANCHORS = palm_anchors()


def rotation(dx, dy):
    return math.pi / 2 + math.atan2(dy, dx)


def rotation_matrix(angle):
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, -s], [s, c]], dtype=np.float32)


@dataclass
class Square:
    center: np.ndarray
    side: float
    angle: float

    @classmethod
    def from_box(cls, center, size, angle, shift_y, scale):
        shifted = center + rotation_matrix(angle)[:, 1] * (shift_y * size[1])
        return cls(shifted, float(max(size) * scale), angle)

    def crop(self, image, size):
        axes = rotation_matrix(self.angle) * (self.side / size)
        # OpenCV's affine map samples pixel centers while task coordinates use edges.
        anchor = self.center - .5 - axes @ np.full(2, (size - 1) / 2)
        transform = np.column_stack((axes, anchor))
        patch = cv2.warpAffine(image, transform, (size, size),
                               flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
        return patch.transpose(2, 0, 1)[None].astype(np.float32) / 255

    def bounds(self):
        return np.r_[self.center - self.side / 2, self.center + self.side / 2]


def overlap(box, boxes):
    intersection = np.maximum(0, np.minimum(box[2:], boxes[..., 2:]) -
                              np.maximum(box[:2], boxes[..., :2])).prod(axis=-1)
    area = (box[2:] - box[:2]).prod() + (boxes[..., 2:] - boxes[..., :2]).prod(axis=-1)
    return intersection / np.maximum(area - intersection, 1e-9)


def palm_rectangles(raw, logits, image_side, offset, threshold):
    scores = 1 / (1 + np.exp(-np.clip(logits.ravel(), -80, 80)))
    selected = np.flatnonzero(scores >= threshold)
    if not selected.size:
        return []
    scores = scores[selected]
    decoded = raw.reshape(-1, 9, 2)[selected] / PALM_SIZE
    decoded[:, 0] += PALM_ANCHORS[selected]
    decoded[:, 2:] += PALM_ANCHORS[selected, None]
    centers, sizes = decoded[:, 0], decoded[:, 1]
    boxes = np.column_stack((centers - sizes / 2, centers + sizes / 2))
    remaining = np.argsort(-scores, kind='stable')
    rectangles = []
    while remaining.size and len(rectangles) < 2:
        matches = overlap(boxes[remaining[0]], boxes[remaining]) > .3
        matches[0] = True
        cluster = remaining[matches]
        center, size, wrist, _, middle, *_ = np.average(decoded[cluster], axis=0, weights=scores[cluster])
        angle = rotation(*(middle - wrist))
        rectangles.append(Square.from_box(center * image_side + offset, size * image_side, angle, -.5, 2.6))
        remaining = remaining[~matches]
    return rectangles


def tracking_square(points):
    finger = (points[6] + 2 * points[10] + points[14]) / 4
    angle = rotation(*(finger - points[0]))
    axes = rotation_matrix(angle)
    local = points[HAND_JOINTS] @ axes
    low, high = local.min(axis=0), local.max(axis=0)
    return Square.from_box((low + high) / 2 @ axes.T, high - low, angle, -.1, 2)


def directml_session(filename, profile_prefix=None):
    import onnxruntime as ort

    if PROVIDER not in ort.get_available_providers():
        raise RuntimeError('缺少 ONNX Runtime DirectML，请运行实验目录的 setup/install.cmd')
    options = ort.SessionOptions()
    options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.add_session_config_entry('session.disable_cpu_ep_fallback', '1')
    if profile_prefix is not None:
        options.enable_profiling = True
        options.profile_file_prefix = str(profile_prefix)
    path = MODEL_DIR / filename
    if not path.is_file():
        raise RuntimeError('缺少实验版 GPU 模型，请运行实验目录的 setup/install.cmd')
    session = ort.InferenceSession(path.read_bytes(), sess_options=options, providers=[PROVIDER])
    session.disable_fallback()
    if session.get_providers()[0] != PROVIDER:
        raise RuntimeError('Astra GPU 推理未启用 DirectML')
    return session


class GpuHandTracker:
    backend = 'Python GPU · DirectML'

    def __init__(self, mode, profile_dir=None):
        self.mode = mode
        self.threshold = .28 if mode == 'VIDEO' else .5
        self.palm = directml_session(PALM_FILE, profile_dir / 'palms' if profile_dir else None)
        self.hand = directml_session(LANDMARK_FILE, profile_dir / 'landmarks' if profile_dir else None)
        self.previous = []
        self.epoch = None
        self.timestamp_ms = -1

    def detect(self, bgr, captured_at):
        if self.epoch is None:
            self.epoch = captured_at
        self.timestamp_ms = max(self.timestamp_ms + 1, round((captured_at - self.epoch) * 1000))
        begin = time.perf_counter()
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        started = time.perf_counter()
        height, width = rgb.shape[:2]
        center = np.array([width, height], dtype=np.float32) / 2
        scale = max(width, height)
        rectangles = self.previous.copy() if self.mode == 'VIDEO' else []
        if len(rectangles) < 2:
            tensor = Square(center, scale, 0).crop(rgb, PALM_SIZE)
            raw, logits = self.palm.run(['Identity', 'Identity_1'], {'input_1': tensor})
            fresh = palm_rectangles(raw, logits, scale, center - scale / 2, self.threshold)
            for rect in fresh:
                if all(overlap(rect.bounds(), old.bounds()) <= .35 for old in rectangles):
                    rectangles.append(rect)
        landmarks, world, handedness, next_rects = [], [], [], []
        for rect in rectangles[:2]:
            tensor = rect.crop(rgb, HAND_SIZE)
            image_xyz, presence, side, world_xyz = self.hand.run(
                ['Identity', 'Identity_1', 'Identity_2', 'Identity_3'], {'input_1': tensor})
            if float(presence.item()) < self.threshold:
                continue
            axes = rotation_matrix(rect.angle)
            local = image_xyz.reshape(21, 3) / HAND_SIZE
            pixel_xy = (local[:, :2] - .5) @ axes.T * rect.side + rect.center
            next_rects.append(tracking_square(pixel_xy))
            points = np.column_stack((pixel_xy / [width, height], local[:, 2] * rect.side / (.4 * width)))
            metric = world_xyz.reshape(21, 3)
            world_points = np.column_stack((metric[:, :2] @ axes.T, metric[:, 2]))
            landmarks.append(self.coordinates(points))
            world.append(self.coordinates(world_points))
            score = float(side.item())
            index = int(score < .5)
            name = 'Left' if index else 'Right'
            handedness.append([{'categoryName': name, 'displayName': name, 'index': index,
                                'score': 1 - score if index else score}])
        self.previous = next_rects
        return {'landmarks': landmarks, 'worldLandmarks': world, 'handedness': handedness,
                'inferenceMs': (time.perf_counter() - started) * 1000,
                'preprocessMs': (started - begin) * 1000, 'timestampMs': self.timestamp_ms}

    @staticmethod
    def coordinates(points):
        return [dict(zip(('x', 'y', 'z'), point)) for point in points.tolist()]

    def close(self):
        self.palm = self.hand = None
