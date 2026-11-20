"""Summarize local A/B logs, which contain timings and positions but no images."""
import argparse
import json
import math
from pathlib import Path
from statistics import median

import numpy as np

from astra_ab import FPS, PERIOD, RECOVERIES, SWEEPS


def stats(values):
    values = sorted(values)
    if not values:
        return {'n': 0}
    return {'n': len(values), 'median': round(median(values), 2),
            'p95': round(values[math.ceil(.95 * len(values)) - 1], 2)}


def timings(runs, phase=None):
    model, capture_to_raf, frame_gaps, preprocess, paired = [], [], [], [], []
    frames_with_hand = 0
    for run in runs:
        frames = run['rows']
        if phase is None:
            start = frames[0]['at'] + 5000
            rows = [row for row in frames if start <= row['at'] < start + 8000]
        else:
            rows = [row for row in frames if row.get('phase') == phase]
        model.extend(row['modelMs'] for row in rows)
        capture_to_raf.extend(row['nextRaf'] - row['capture'] for row in rows if 'nextRaf' in row)
        frame_gaps.extend(b['at'] - a['at'] for a, b in zip(rows, rows[1:]))
        preprocess.extend(row['preprocessMs'] for row in rows if 'preprocessMs' in row)
        paired.extend(row['pairGapMs'] for row in rows)
        frames_with_hand += sum(bool(row['sides']) for row in rows)
    return {'model_ms': stats(model), 'capture_to_next_raf_ms': stats(capture_to_raf),
            'output_gap_ms': stats(frame_gaps), 'python_preprocess_ms': stats(preprocess),
            'host_pair_gap_ms': stats(paired), 'outputs_with_hand': frames_with_hand,
            'startup_ms': stats(run['firstFrameMs'] for run in runs),
            'clock_rtt_ms': stats(run['clockRTTMs'] for run in runs)}


def hologram(runs):
    center, size = [], []
    all_draws, coast = 0, 0
    for run in runs:
        palms = run['palms']
        all_draws += len(palms)
        coast += sum(pose['alpha'] < .99 for pose in palms)
        palms = [pose for pose in palms if pose['alpha'] >= .99]
        if not palms:
            continue
        x, y, radius = (median(pose[key] for pose in palms) for key in ('x', 'y', 'radius'))
        center.extend(math.hypot(pose['x'] - x, pose['y'] - y) for pose in palms)
        size.extend(abs(pose['radius'] - radius) for pose in palms)
    return {'center_drift_px': stats(center), 'radius_drift_px': stats(size), 'draws': all_draws,
            'draws_with_alpha_below_0_99': coast}


def phase_lag(rows, started, key, invert=False):
    values = [(row['nextRaf'], row[key]) for row in rows if key in row and 'nextRaf' in row]
    if len(values) < PERIOD // 2:
        return None
    ts, ys = np.array(values).T
    ys *= -1 if invert else 1
    phase = (ts - started) * (2 * math.pi * FPS / (PERIOD * 1000))
    design = np.column_stack((np.ones(ts.size), np.sin(phase), np.cos(phase)))
    coefficients, *_ = np.linalg.lstsq(design, ys, rcond=None)
    if 2 * np.sum((ys - design @ coefficients) ** 2) > np.sum((ys - np.mean(ys)) ** 2):
        return None
    return math.atan2(-coefficients[2], coefficients[1]) * PERIOD * 1000 / (2 * math.pi * FPS)


def drawing(runs):
    tip_lag, cursor_lag, reacquired = [], [], []
    misses = no_right = none_on_screen = unknown_pinch = blank_hits = motions_seen = 0
    for run in runs:
        motion = [row for row in run['rows'] if row.get('phase') == 'motion']
        motions_seen += len(motion)
        no_right += sum('Right' not in row['sides'] for row in motion)
        none_on_screen += sum('cursorX' not in row for row in motion)
        unknown_pinch += sum(row['state'] == 'Pinching' and row['point'] for row in run['rows'])
        blank_hits += sum(bool(row['sides']) for row in run['rows'] if row.get('phase') == 'occluded')
        for sweep in range(SWEEPS):
            rows = [row for row in motion if row['trial'] == sweep]
            if not rows:
                continue
            started = rows[0]['capture'] - rows[0]['offset'] * 1000 / FPS
            for key, results in [('tipX', tip_lag), ('cursorX', cursor_lag)]:
                lag = phase_lag(rows, started, key, invert=key == 'cursorX')
                if lag is not None:
                    results.append(lag)
        for trial in range(RECOVERIES):
            reveal = [row for row in run['rows'] if row.get('phase') == 'reveal' and row['trial'] == trial]
            recovered = next((row for row in reveal if row['sides']), None)
            if recovered is None:
                misses += 1
                continue
            cue = recovered['capture'] - (recovered['offset'] - 12) * 1000 / FPS
            reacquired.append(recovered['at'] - cue)
    return {'tip_phase_lag_ms': stats(tip_lag), 'cursor_phase_lag_ms': stats(cursor_lag),
            'sweeps': len(runs) * SWEEPS, 'motion_expected_frames': len(runs) * SWEEPS * PERIOD,
            'motion_outputs': motions_seen, 'motion_outputs_without_right': no_right,
            'motion_outputs_without_filtered_cursor': none_on_screen,
            'open_palm_outputs_in_pinching_state_with_point': unknown_pinch,
            'blank_outputs_with_landmarks': blank_hits, 'recovery_ms': stats(reacquired),
            'recovery_failures': misses, 'recovery_attempts': len(runs) * RECOVERIES}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    result = {}
    for variant in ['a', 'b']:
        runs = {mode: [json.loads(path.read_text(encoding='utf-8'))
                       for path in sorted(args.directory.glob(f'{mode}-{variant}[0-9].json'))]
                for mode in ['live', 'hologram', 'drawing']}
        result[variant] = {'live': timings(runs['live']), 'same_input_motion': timings(runs['drawing'], 'motion'),
                           'hologram': hologram(runs['hologram']), 'drawing': drawing(runs['drawing'])}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
