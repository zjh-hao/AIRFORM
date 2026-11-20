"""Export aggregate-only human tracking measurements from an analysis report."""
import argparse
import json
from pathlib import Path

METRICS = (
    "detectorOutputHz", "detectedHandFrames", "detectedHandFraction",
    "qualifiedInteractionFrames", "qualifiedInteractionFraction",
    "heldCursorFrames", "meanInferenceMs",
)


def summarize(report):
    rows = []
    for record in report["reports"]:
        case = record["testCase"]
        if case not in {"drawing", "static", "rotation", "low-light"}:
            raise ValueError("Unexpected test group")
        metrics = record["metrics"]
        row = {"case": case, "frames": record["frames"], "durationMs": record["durationMs"]}
        for name in METRICS:
            value = metrics.get(name)
            if isinstance(value, (float, int)):
                row[name] = value
        rows.append(row)
    return {"evidence": "historical physical Astra recordings", "sessions": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = summarize(json.loads(args.input.read_text(encoding="utf-8-sig")))
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
