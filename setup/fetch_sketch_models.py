"""Download lightweight local ONNX models for 2D sketch & handwritten letter recognition."""
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache/sketch-models'

ARTIFACTS = {
    'quickdraw-mobilevit-small.onnx': (
        'https://huggingface.co/Xenova/quickdraw-mobilevit-small/resolve/main/onnx/model.onnx',
        15_000_000,
    ),
    'quickdraw-config.json': (
        'https://huggingface.co/Xenova/quickdraw-mobilevit-small/resolve/main/config.json',
        1_000,
    ),
    'en_PP-OCRv4_rec_infer.onnx': (
        'https://huggingface.co/breezedeus/cnocr-ppocr-en_PP-OCRv4/resolve/main/en_PP-OCRv4_rec_infer.onnx',
        1_000_000,
    ),
    'en_dict.txt': (
        'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/en_dict.txt',
        100,
    ),
}


def download_file(url: str, dest: Path, min_bytes: int = 128):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.tmp')
    req = urllib.request.Request(url, headers={'User-Agent': 'AIRFORM-ModelFetcher/1.0'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    if len(data) < min_bytes:
        raise RuntimeError(f'Downloaded file too small for {dest.name}: {len(data)} bytes')
    tmp.write_bytes(data)
    tmp.replace(dest)


def ensure_sketch_models(cache_dir: Path = CACHE):
    paths = {}
    for filename, (url, min_bytes) in ARTIFACTS.items():
        dest = cache_dir / filename
        if not dest.is_file() or dest.stat().st_size < min_bytes:
            print(f'Fetching {filename} ...', flush=True)
            download_file(url, dest, min_bytes)
        paths[filename] = dest
    return paths


def main():
    paths = ensure_sketch_models()
    for name, path in paths.items():
        print(f'{name}: {path.stat().st_size:,} bytes -> {path}')


if __name__ == '__main__':
    main()
