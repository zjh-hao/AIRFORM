"""Verify the bundled hand model and fetch the official diagnostic image."""
import hashlib
import json
from pathlib import Path
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def prepare(asset):
    path = ROOT / asset["file"]
    def matches(data):
        return hashlib.sha256(data).hexdigest() == asset["sha256"]
    if path.is_file() and matches(path.read_bytes()):
        return
    if asset["bundled"]:
        raise RuntimeError(f"Restore the missing or damaged repository file: {path.name}")
    with urlopen(asset["source"], timeout=40) as response:
        data = response.read()
    if not matches(data):
        raise ValueError(f"Checksum mismatch: {path.name}")
    path.parent.mkdir(exist_ok=True, parents=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(data)
    temp = Path(temporary.name)
    try:
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


if __name__ == "__main__":
    for entry in json.loads(Path(__file__).with_name("assets.json").read_text()):
        prepare(entry)
