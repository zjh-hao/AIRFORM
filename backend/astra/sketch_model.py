"""Lightweight local ONNX recognizer for freehand 2D sketches and handwritten letters/digits.

Uses CPUExecutionProvider via onnxruntime so it never contends with DirectML hand tracking:
  1. Xenova/quickdraw-mobilevit-small (28x28 grayscale, 345 QuickDraw classes, normal+hflip TTA)
  2. breezedeus/cnocr-ppocr-en_PP-OCRv4 (48xW RGB, CTC English OCR with conditional slant TTA)
"""
import json
import math
from pathlib import Path
import threading
import time

import cv2
import numpy as np

try:
    import onnxruntime as ort
except ImportError:  # pragma: no cover - optional runtime guard
    ort = None


ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / '.cache/sketch-models'

FALLBACK_EN_DICT = (
    '0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`'
    'abcdefghijklmnopqrstuvwxyz{|}~!"#$%&\'()*+,-./ '
)

QUICKDRAW_TYPE_MAP = {
    'circle': 'sphere',
    'square': 'cube',
    'triangle': 'pyramid',
    'moon': 'moon',
    'star': 'star',
    'cloud': 'cloud',
    'lightning': 'lightning',
    'sun': 'sun',
    'diamond': 'diamond',
    'hexagon': 'hexagon',
    'octagon': 'hexagon',
    'crown': 'crown',
    'house': 'house',
    'barn': 'house',
    'tent': 'house',
    'church': 'house',
    'flower': 'flower',
    'tree': 'tree',
    'umbrella': 'umbrella',
    'butterfly': 'butterfly',
    'snowflake': 'snowflake',
    'smiley face': 'smiley',
    'face': 'smiley',
    'hourglass': 'hourglass',
}

DISPLAY_NAMES = {
    'sphere': '球体',
    'cube': '立方体',
    'pyramid': '四棱锥',
    'moon': '月亮',
    'star': '五角星',
    'cloud': '云朵',
    'lightning': '闪电',
    'sun': '太阳',
    'diamond': '菱钻',
    'hexagon': '六边形',
    'crown': '皇冠',
    'house': '小屋',
    'flower': '花朵',
    'tree': '小树',
    'umbrella': '雨伞',
    'butterfly': '蝴蝶',
    'snowflake': '雪花',
    'smiley': '笑脸',
    'hourglass': '沙漏',
    'heart': '爱心',
}

# Exclude 'lightning' so slanted hand-drawn 'Z' always gets OCR + horizontal-bar disambiguation.
FAST_PATH_PATTERNS = frozenset({
    'star', 'cloud', 'sun', 'crown', 'flower', 'umbrella', 'smiley face', 'diamond',
})


def _build_canonical_heart(n=64) -> np.ndarray:
    t = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    x = 16.0 * (np.sin(t) ** 3)
    y = 13.0 * np.cos(t) - 5.0 * np.cos(2.0 * t) - 2.0 * np.cos(3.0 * t) - np.cos(4.0 * t)
    xn = (x - x.min()) / max(x.max() - x.min(), 1e-6)
    yn = (y - y.min()) / max(y.max() - y.min(), 1e-6)
    return np.column_stack([xn, yn]).astype(np.float32)


_CANONICAL_HEART = _build_canonical_heart(64)


def _cpu_session_options():
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_mem_pattern = True
    options.add_session_config_entry('session.intra_op.allow_spinning', '0')
    options.add_session_config_entry('session.inter_op.allow_spinning', '0')
    return options


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - np.max(logits)
    exp = np.exp(shifted)
    return exp / np.sum(exp)


def _normalize_strokes(raw_strokes):
    """Validate and convert JSON stroke arrays into list of finite (N, 2) float32 arrays."""
    if not isinstance(raw_strokes, list) or not (1 <= len(raw_strokes) <= 16):
        raise ValueError('strokes must contain 1..16 polylines')
    cleaned = []
    for stroke in raw_strokes:
        if not isinstance(stroke, list) or len(stroke) < 2 or len(stroke) > 512:
            raise ValueError('each stroke must contain 2..512 2D points')
        pts = np.asarray(stroke, dtype=np.float32)
        if pts.ndim != 2 or pts.shape[1] != 2 or not np.all(np.isfinite(pts)):
            raise ValueError('each point must be a finite [x, y] pair')
        cleaned.append(pts)
    return cleaned


def _stroke_geometry_stats(strokes):
    all_pts = np.vstack(strokes)
    mn = all_pts.min(axis=0)
    mx = all_pts.max(axis=0)
    span_x = float(mx[0] - mn[0])
    span_y = float(mx[1] - mn[1])
    diag = math.hypot(span_x, span_y)

    total_len = 0.0
    for st in strokes:
        diffs = st[1:] - st[:-1]
        total_len += float(np.sum(np.hypot(diffs[:, 0], diffs[:, 1])))

    first, last = strokes[0][0], strokes[-1][-1]
    end_gap = float(math.hypot(float(last[0] - first[0]), float(last[1] - first[1])))
    is_single_straight = False
    if len(strokes) == 1 and diag > 1e-5:
        pts = strokes[0]
        chord = float(math.hypot(float(pts[-1, 0] - pts[0, 0]), float(pts[-1, 1] - pts[0, 1])))
        if chord > 0.72 * diag and chord / max(total_len, 1e-5) > 0.90:
            is_single_straight = True

    return {
        'mn': mn,
        'mx': mx,
        'span_x': span_x,
        'span_y': span_y,
        'diag': diag,
        'total_len': total_len,
        'closed_ratio': end_gap / max(diag, 1e-5),
        'is_single_straight': is_single_straight,
    }


def _clean_strokes(strokes, eps_ratio=0.018):
    """Smooth dense 30Hz hand tremor with pinned endpoints, then simplify via RDP."""
    all_pts = np.vstack(strokes)
    span = max(float(all_pts[:, 0].max() - all_pts[:, 0].min()),
               float(all_pts[:, 1].max() - all_pts[:, 1].min()), 1e-4)
    eps = span * eps_ratio
    cleaned = []
    for st in strokes:
        arr = st.copy()
        if len(arr) >= 16:
            diffs = arr[1:] - arr[:-1]
            avg_step = float(np.mean(np.hypot(diffs[:, 0], diffs[:, 1])))
            if avg_step <= span * 0.12:
                for _ in range(2):
                    sm = arr.copy()
                    sm[1:-1] = 0.25 * arr[:-2] + 0.5 * arr[1:-1] + 0.25 * arr[2:]
                    arr = sm
        if len(arr) >= 12:
            poly = cv2.approxPolyDP(arr.reshape(-1, 1, 2), eps, False).reshape(-1, 2)
            if len(poly) >= 2:
                arr = poly
        cleaned.append(arr.astype(np.float32))
    return cleaned


def _rotate_strokes(strokes, angle_deg: float):
    rad = math.radians(angle_deg)
    c, s = math.cos(rad), math.sin(rad)
    all_pts = np.vstack(strokes)
    cx, cy = (all_pts.min(axis=0) + all_pts.max(axis=0)) * 0.5
    rotated = []
    for st in strokes:
        dx = st[:, 0] - cx
        dy = st[:, 1] - cy
        rotated.append(np.column_stack([cx + dx * c - dy * s, cy + dx * s + dy * c]).astype(np.float32))
    return rotated


def _rasterize_quickdraw_view(strokes, size=256, thick=14, pad=0.86, hflip=False) -> np.ndarray:
    img = np.zeros((size, size), dtype=np.uint8)
    all_pts = np.vstack(strokes)
    mn, mx = all_pts.min(axis=0), all_pts.max(axis=0)
    span = max(float(mx[0] - mn[0]), float(mx[1] - mn[1]), 1e-4)
    center = (mn + mx) * 0.5
    scale = (size * pad) / span
    sign_x = -1.0 if hflip else 1.0
    for st in strokes:
        px = np.round(sign_x * (st[:, 0] - center[0]) * scale + size * 0.5).astype(np.int32)
        py = np.round(-(st[:, 1] - center[1]) * scale + size * 0.5).astype(np.int32)
        cv2.polylines(img, [np.column_stack([px, py])], False, 255, thick, cv2.LINE_AA)
    return cv2.resize(img, (28, 28), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0


def _rasterize_quickdraw_batch(strokes) -> np.ndarray:
    clean = _clean_strokes(strokes, eps_ratio=0.020)
    v0 = _rasterize_quickdraw_view(clean, thick=14, pad=0.86, hflip=False)
    v1 = _rasterize_quickdraw_view(clean, thick=13, pad=0.86, hflip=True)
    return np.stack([v0[None], v1[None]], axis=0)


def _compute_ocr_width(clean_strokes, char_h=34, pad_x=18) -> int:
    all_pts = np.vstack(clean_strokes)
    mn, mx = all_pts.min(axis=0), all_pts.max(axis=0)
    span_x = max(float(mx[0] - mn[0]), 1e-4)
    span_y = max(float(mx[1] - mn[1]), 1e-4)
    scale = min(float(char_h) / span_y, 72.0 / span_x)
    return int(max(64, min(144, round(span_x * scale + pad_x * 2))))


def _rasterize_ocr_image(strokes, width: int, height=48, thick=3, char_h=34) -> np.ndarray:
    img = np.full((height, width, 3), 255, dtype=np.uint8)
    all_pts = np.vstack(strokes)
    mn, mx = all_pts.min(axis=0), all_pts.max(axis=0)
    span_x = max(float(mx[0] - mn[0]), 1e-4)
    span_y = max(float(mx[1] - mn[1]), 1e-4)
    scale = min(float(char_h) / span_y, (width - 28.0) / span_x)
    cx = float((mn[0] + mx[0]) * 0.5)
    cy = float((mn[1] + mx[1]) * 0.5)
    for st in strokes:
        px = np.round((st[:, 0] - cx) * scale + width * 0.5).astype(np.int32)
        py = np.round(-(st[:, 1] - cy) * scale + height * 0.5).astype(np.int32)
        cv2.polylines(img, [np.column_stack([px, py])], False, (0, 0, 0), thick, cv2.LINE_AA)
    arr = (img.astype(np.float32) / 255.0 - 0.5) / 0.5
    return np.transpose(arr, (2, 0, 1))


def _decode_ctc(probs: np.ndarray, vocab: list[str]):
    ids = probs.argmax(axis=-1)
    prev = 0
    chars, confs = [], []
    for t, idx in enumerate(ids):
        idx_int = int(idx)
        if idx_int != 0 and idx_int != prev:
            if idx_int < len(vocab):
                chars.append(vocab[idx_int])
                confs.append(float(probs[t, idx_int]))
        prev = idx_int
    text = ''.join(chars).strip()
    conf = min(confs) if confs else 0.0
    return text, conf


def _is_horizontal_z(clean_strokes, stats) -> bool:
    """Distinguish handwritten 'Z' (two near-horizontal bars) from vertical lightning bolt."""
    if len(clean_strokes) != 1 or stats['closed_ratio'] <= 0.25:
        return False
    all_pts = clean_strokes[0]
    span = max(stats['span_x'], stats['span_y'], 1e-4)
    poly = cv2.approxPolyDP(all_pts.reshape(-1, 1, 2), span * 0.08, False).reshape(-1, 2)
    if len(poly) != 4:
        return False
    s0 = poly[1] - poly[0]
    s1 = poly[2] - poly[1]
    s2 = poly[3] - poly[2]
    top_horiz = abs(float(s0[1])) <= 0.45 * abs(float(s0[0])) and abs(float(s0[0])) >= 0.28 * stats['span_x']
    bot_horiz = abs(float(s2[1])) <= 0.45 * abs(float(s2[0])) and abs(float(s2[0])) >= 0.28 * stats['span_x']
    opposite_diag = (s0[0] * s1[0] < 0) and (s1[0] * s2[0] < 0)
    return bool(top_horiz and bot_horiz and opposite_diag)


def _detect_heart(strokes, stats):
    """Strict structural + Chamfer-distance detector for 1-stroke or 2-stroke hearts."""
    if len(strokes) > 2 or stats['span_y'] <= 1e-4:
        return None
    aspect = stats['span_x'] / stats['span_y']
    if not (0.65 <= aspect <= 1.55):
        return None

    if len(strokes) == 1:
        if stats['closed_ratio'] > 0.35:
            return None
    else:
        # 2-stroke heart: endpoints of both halves meet near top cleft and bottom tip.
        s0, s1 = strokes
        p0a, p0b = s0[0], s0[-1]
        p1a, p1b = s1[0], s1[-1]
        pair1 = max(math.hypot(float(p0a[0] - p1a[0]), float(p0a[1] - p1a[1])),
                    math.hypot(float(p0b[0] - p1b[0]), float(p0b[1] - p1b[1])))
        pair2 = max(math.hypot(float(p0a[0] - p1b[0]), float(p0a[1] - p1b[1])),
                    math.hypot(float(p0b[0] - p1a[0]), float(p0b[1] - p1a[1])))
        if min(pair1, pair2) > 0.38 * stats['diag']:
            return None

    pts = np.vstack(strokes)
    xn = (pts[:, 0] - stats['mn'][0]) / max(stats['span_x'], 1e-6)
    yn = (pts[:, 1] - stats['mn'][1]) / max(stats['span_y'], 1e-6)

    # Upper left and right lobes reach near top, while narrow center notch dips visibly below.
    left_upper = yn[(xn < 0.40) & (yn > 0.50)]
    right_upper = yn[(xn > 0.60) & (yn > 0.50)]
    center_notch = yn[(np.abs(xn - 0.50) <= 0.075) & (yn > 0.40)]
    bottom_pts = xn[yn < 0.22]
    if not (len(left_upper) and len(right_upper) and len(center_notch) and len(bottom_pts)):
        return None
    lobe_peak = min(float(left_upper.max()), float(right_upper.max()))
    cleft_y = float(center_notch.min())
    if lobe_peak < 0.84 or float(center_notch.max()) > 0.92 or lobe_peak - cleft_y < 0.12:
        return None
    if float(np.mean(np.abs(bottom_pts - 0.5))) > 0.17:
        return None

    # Bidirectional Chamfer distance to canonical heart contour
    query = np.column_stack([xn, yn]).astype(np.float32)
    diff = query[:, None, :] - _CANONICAL_HEART[None, :, :]
    dists = np.sqrt(np.sum(diff * diff, axis=-1))
    chamfer = 0.5 * (float(np.mean(dists.min(axis=1))) + float(np.mean(dists.min(axis=0))))
    if chamfer > 0.145:
        return None
    return max(0.75, min(0.98, 1.0 - chamfer * 1.4))


def _is_circular_outline(strokes, stats) -> bool:
    if len(strokes) > 2 or stats['closed_ratio'] > 0.25 or stats['span_y'] <= 1e-4:
        return False
    aspect = stats['span_x'] / stats['span_y']
    if not (0.76 <= aspect <= 1.32):
        return False
    pts = np.vstack(strokes)
    c = (stats['mn'] + stats['mx']) * 0.5
    radii = np.hypot(pts[:, 0] - c[0], pts[:, 1] - c[1])
    mean_r = float(np.mean(radii))
    return mean_r > 1e-4 and (float(np.std(radii)) / mean_r) <= 0.19


class SketchRecognizer:
    """Thread-safe local ONNX runner for sketch patterns and handwritten letters/digits."""

    def __init__(self, model_dir: Path = MODEL_DIR):
        self.model_dir = Path(model_dir)
        self._lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._loaded = False
        self._qd_sess = None
        self._qd_in = None
        self._id2label = {}
        self._label2id = {}
        self._ocr_sess = None
        self._ocr_in = None
        self._ocr_vocab = [''] + list(FALLBACK_EN_DICT) + [' ']
        self._error = None

    def _ensure_loaded(self):
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            self._loaded = True
            if ort is None:
                self._error = 'onnxruntime is not installed'
                return
            try:
                qd_path = self.model_dir / 'quickdraw-mobilevit-small.onnx'
                cfg_path = self.model_dir / 'quickdraw-config.json'
                ocr_path = self.model_dir / 'en_PP-OCRv4_rec_infer.onnx'
                dict_path = self.model_dir / 'en_dict.txt'
                sess_opts = _cpu_session_options()

                if qd_path.is_file() and cfg_path.is_file():
                    cfg = json.loads(cfg_path.read_text(encoding='utf-8'))
                    self._id2label = {int(k): v for k, v in cfg.get('id2label', {}).items()}
                    self._label2id = {v: k for k, v in self._id2label.items()}
                    self._qd_sess = ort.InferenceSession(
                        str(qd_path), sess_options=sess_opts, providers=['CPUExecutionProvider'],
                    )
                    self._qd_in = self._qd_sess.get_inputs()[0].name

                if dict_path.is_file():
                    lines = dict_path.read_text(encoding='utf-8').splitlines()
                    if lines:
                        self._ocr_vocab = [''] + lines + [' ']

                if ocr_path.is_file():
                    self._ocr_sess = ort.InferenceSession(
                        str(ocr_path), sess_options=sess_opts, providers=['CPUExecutionProvider'],
                    )
                    self._ocr_in = self._ocr_sess.get_inputs()[0].name
            except Exception as error:
                self._error = str(error)

    def status(self):
        self._ensure_loaded()
        return {
            'available': bool(self._qd_sess or self._ocr_sess),
            'quickdrawReady': bool(self._qd_sess),
            'ocrReady': bool(self._ocr_sess),
            'quickdrawClasses': len(self._id2label),
            'supportedPatterns': sorted(set(QUICKDRAW_TYPE_MAP.values()) | {'heart'}),
            'error': self._error,
        }

    def _recognize_single(self, strokes, closed_hint: bool):
        stats = _stroke_geometry_stats(strokes)

        # Ignore tiny dots or single nearly-straight lines (let user finish multi-stroke T/H/A/X).
        if stats['diag'] < 1e-3 or stats['total_len'] < 1e-3 or stats['is_single_straight']:
            return {'recognized': False, 'reason': 'stroke-too-simple'}

        clean_ocr_strokes = _clean_strokes(strokes, eps_ratio=0.014)
        top_patterns = []
        qd_probs = None
        ocr_text = ''
        ocr_conf = 0.0

        qd_batch = _rasterize_quickdraw_batch(strokes) if self._qd_sess is not None else None
        heart_conf = _detect_heart(strokes, stats)

        with self._infer_lock:
            if qd_batch is not None:
                logits = self._qd_sess.run(None, {self._qd_in: qd_batch})[0]
                p0 = _softmax(logits[0])
                p1 = _softmax(logits[1]) if logits.shape[0] > 1 else p0
                qd_probs = 0.6 * p0 + 0.4 * p1
                top_indices = np.argsort(-qd_probs)[:5]
                top_patterns = [
                    {'label': self._id2label.get(int(i), str(i)), 'prob': float(qd_probs[i])}
                    for i in top_indices
                ]

            skip_ocr = (
                heart_conf is not None
                or (
                    top_patterns
                    and top_patterns[0]['label'] in FAST_PATH_PATTERNS
                    and top_patterns[0]['prob'] >= 0.82
                )
            )
            if self._ocr_sess is not None and not skip_ocr:
                ocr_w = _compute_ocr_width(clean_ocr_strokes)
                ocr_img = _rasterize_ocr_image(clean_ocr_strokes, ocr_w)
                ocr_out = self._ocr_sess.run(None, {self._ocr_in: ocr_img[None]})[0][0]
                ocr_text, ocr_conf = _decode_ctc(ocr_out, self._ocr_vocab)

                clean_cand = ocr_text.upper() if len(ocr_text) == 1 and ocr_text.isalnum() else ''
                if not (clean_cand and ocr_conf >= 0.75):
                    # Conditional batched slant-correction TTA (-15 deg / +15 deg) for tilted handwriting.
                    s_neg = _rotate_strokes(clean_ocr_strokes, -15.0)
                    s_pos = _rotate_strokes(clean_ocr_strokes, 15.0)
                    tta_batch = np.stack([
                        _rasterize_ocr_image(s_neg, ocr_w),
                        _rasterize_ocr_image(s_pos, ocr_w),
                    ], axis=0)
                    tta_out = self._ocr_sess.run(None, {self._ocr_in: tta_batch})[0]
                    for idx in range(tta_out.shape[0]):
                        tx, cf = _decode_ctc(tta_out[idx], self._ocr_vocab)
                        if len(tx) == 1 and tx.isalnum() and (not clean_cand or cf > ocr_conf):
                            ocr_text, ocr_conf = tx, cf
                            clean_cand = tx.upper()

        decision = self._arbitrate(
            clean_ocr_strokes, top_patterns, qd_probs, ocr_text, ocr_conf,
            stats, len(strokes), closed_hint, heart_conf,
        )
        if not decision:
            return {
                'recognized': False,
                'topPatterns': top_patterns[:3],
                'ocrText': ocr_text,
                'ocrConfidence': round(ocr_conf, 4),
            }

        return {
            'recognized': True,
            **decision,
            'topPatterns': top_patterns[:3],
            'ocrText': ocr_text,
            'ocrConfidence': round(ocr_conf, 4),
        }

    def recognize(self, raw_strokes, *, closed_hint: bool = False, fallback_strokes=None, fallback_closed_hint: bool = False):
        started = time.perf_counter()
        strokes = _normalize_strokes(raw_strokes)
        fallback = _normalize_strokes(fallback_strokes) if fallback_strokes is not None else None

        self._ensure_loaded()
        if not (self._qd_sess or self._ocr_sess):
            return {
                'recognized': False,
                'usedFallback': False,
                'reason': self._error or 'Sketch ONNX models are not downloaded',
                'elapsedMs': round((time.perf_counter() - started) * 1000.0, 2),
            }

        result = self._recognize_single(strokes, closed_hint)
        used_fallback = False
        if not result.get('recognized') and fallback is not None:
            fb_result = self._recognize_single(fallback, fallback_closed_hint)
            if fb_result.get('recognized'):
                result = fb_result
                used_fallback = True

        return {
            **result,
            'usedFallback': used_fallback,
            'elapsedMs': round((time.perf_counter() - started) * 1000.0, 2),
        }

    def _arbitrate(self, clean_strokes, top_patterns, qd_probs, ocr_text, ocr_conf,
                   stats, stroke_count, closed_hint, heart_conf):
        # 0. Dedicated geometric heart check (QuickDraw lacks crisp heart classification).
        top1_qd = top_patterns[0] if top_patterns else {'label': '', 'prob': 0.0}
        if heart_conf is not None and not (
            top1_qd['label'] in ('circle', 'square', 'triangle', 'star', 'moon', 'cloud') and top1_qd['prob'] >= 0.70
        ):
            return {
                'kind': 'pattern',
                'type': 'heart',
                'char': None,
                'label': 'heart',
                'displayName': DISPLAY_NAMES['heart'],
                'confidence': round(float(heart_conf), 4),
                'model': 'geometric-heart',
            }

        # 1. Extract best QuickDraw pattern candidate with targeted shape aliases.
        best_pattern = None
        if top_patterns:
            top1_label, top1_prob = top1_qd['label'], top1_qd['prob']
            if top1_label in QUICKDRAW_TYPE_MAP and top1_prob >= 0.34:
                best_pattern = (top1_label, QUICKDRAW_TYPE_MAP[top1_label], top1_prob)
            elif top1_label in ('bracelet', 'necklace') and _is_circular_outline(clean_strokes, stats):
                circle_prob = float(qd_probs[self._label2id['circle']]) if (qd_probs is not None and 'circle' in self._label2id) else 0.0
                if circle_prob >= 0.04 or top1_prob >= 0.55:
                    best_pattern = ('circle', 'sphere', max(circle_prob, min(top1_prob, 0.78)))
            elif qd_probs is not None and 'tree' in self._label2id and top1_label in ('floor lamp', 'broccoli', 'lollipop', 'mushroom', 'palm tree'):
                tree_prob = float(qd_probs[self._label2id['tree']])
                if tree_prob >= 0.08:
                    best_pattern = ('tree', 'tree', tree_prob)
            elif qd_probs is not None and 'moon' in self._label2id:
                moon_prob = float(qd_probs[self._label2id['moon']])
                crescent_alias = top1_label in ('banana', 'boomerang', 'string bean', 'canoe')
                is_closed_crescent = closed_hint or stats['closed_ratio'] <= 0.30
                if moon_prob >= 0.28 or (crescent_alias and (moon_prob >= 0.075 or is_closed_crescent)):
                    best_pattern = ('moon', 'moon', max(moon_prob, min(top1_prob, 0.72)))

            if best_pattern is None:
                for cand in top_patterns[1:4]:
                    if cand['label'] in QUICKDRAW_TYPE_MAP and cand['prob'] >= 0.22:
                        best_pattern = (cand['label'], QUICKDRAW_TYPE_MAP[cand['label']], cand['prob'])
                        break

        # 2. Check clean single handwritten letter/digit recognition from PP-OCRv4.
        clean_ocr = ocr_text.upper() if len(ocr_text) == 1 and ocr_text.isalnum() else ''
        aspect = stats['span_x'] / max(stats['span_y'], 1e-4)
        valid_letter = False
        if clean_ocr and ocr_conf >= 0.48:
            if clean_ocr in ('O', '0') and stats['closed_ratio'] <= 0.22:
                valid_letter = False
            elif clean_ocr == 'I' and stroke_count == 1 and aspect < 0.28:
                valid_letter = ocr_conf >= 0.78 and aspect >= 0.16
            else:
                valid_letter = True

        # 3. Arbitrate between QuickDraw sketch pattern and PP-OCRv4 letter.
        if best_pattern is not None:
            qd_label, qd_type, qd_prob = best_pattern
            if valid_letter and qd_type in ('lightning', 'hourglass') and clean_ocr == 'Z' and ocr_conf >= 0.50:
                if _is_horizontal_z(clean_strokes, stats):
                    return self._letter_result('Z', ocr_conf)
            if valid_letter and qd_type == 'pyramid' and stroke_count == 1 and clean_ocr == '4' and qd_prob >= 0.65:
                valid_letter = False
            if valid_letter and qd_type == 'tree' and clean_ocr == '4' and ocr_conf < 0.85:
                valid_letter = False
            if valid_letter and qd_type == 'moon' and not closed_hint and stats['closed_ratio'] > 0.30 and clean_ocr in ('C', 'G') and ocr_conf >= 0.48:
                return self._letter_result(clean_ocr, ocr_conf)
            if valid_letter and qd_type in ('pyramid', 'house', 'cube') and ocr_conf >= 0.84 and qd_prob < 0.65:
                return self._letter_result(clean_ocr, ocr_conf)
            if valid_letter and ocr_conf >= 0.86 and qd_prob < 0.72 and qd_type not in (
                'star', 'lightning', 'cloud', 'sun', 'crown', 'flower', 'umbrella', 'smiley', 'pyramid',
            ):
                return self._letter_result(clean_ocr, ocr_conf)
            return {
                'kind': 'pattern',
                'type': qd_type,
                'char': None,
                'label': qd_label,
                'displayName': DISPLAY_NAMES.get(qd_type, qd_type),
                'confidence': round(float(qd_prob), 4),
                'model': 'quickdraw-mobilevit-small',
            }

        if valid_letter:
            return self._letter_result(clean_ocr, ocr_conf)

        return None

    @staticmethod
    def _letter_result(ch: str, conf: float):
        kind_label = '数字' if ch.isdigit() else '字母'
        return {
            'kind': 'letter',
            'type': 'letter',
            'char': ch,
            'label': ch,
            'displayName': f'{kind_label} {ch}',
            'confidence': round(float(conf), 4),
            'model': 'en_PP-OCRv4_rec',
        }


_DEFAULT_RECOGNIZER = SketchRecognizer()


def get_sketch_recognizer() -> SketchRecognizer:
    return _DEFAULT_RECOGNIZER
