"""Convert the two bundled MediaPipe models into the local DirectML cache."""
import hashlib
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'assets/models/hand_landmarker.task'
CACHE = ROOT / '.cache/astra-gpu'
FILES = ('hand_detector', 'hand_landmarks_detector')


def main():
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    marker = CACHE / 'source.sha256'
    if (marker.is_file() and marker.read_text(encoding='ascii').strip() == digest
            and all((CACHE / (name + '.onnx')).is_file() for name in FILES)):
        return
    converter = CACHE.parent / 'gpu-converter'
    python = converter / 'Scripts/python.exe'
    if not python.is_file():
        subprocess.run([sys.executable, '-m', 'venv', str(converter)], check=True)
    subprocess.run([str(python), '-m', 'pip', 'install', 'tensorflow-cpu==2.19.1',
                    'tf2onnx==1.17.0', 'onnx==1.22.0'], check=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    with ZipFile(SOURCE) as bundle, TemporaryDirectory(dir=CACHE) as location:
        directory = Path(location)
        for name in FILES:
            tflite = directory / (name + '.tflite')
            tflite.write_bytes(bundle.read(tflite.name))
            model = directory / (name + '.onnx')
            subprocess.run([str(python), '-m', 'tf2onnx.convert', '--tflite', tflite.name,
                            '--opset', '13', '--inputs-as-nchw', 'input_1', '--output', model.name],
                           cwd=directory, check=True)
        for name in FILES:
            model = directory / (name + '.onnx')
            model.replace(CACHE / model.name)
    marker.write_text(digest + '\n', encoding='ascii')


if __name__ == '__main__':
    main()
