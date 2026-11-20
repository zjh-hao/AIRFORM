"""Register the per-user Windows URL handler, or start the local AIRFORM workshop."""
from pathlib import Path
import os
import subprocess
import sys
import winreg

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / '.venv' / 'Scripts' / 'python.exe'


def register():
    pythonw = PYTHON.with_name('pythonw.exe')
    if not pythonw.is_file():
        raise FileNotFoundError(pythonw)
    scheme = r'Software\Classes\airform-workshop'
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, scheme) as key:
        winreg.SetValueEx(key, '', 0, winreg.REG_SZ, 'URL:AIRFORM Workshop')
        winreg.SetValueEx(key, 'URL Protocol', 0, winreg.REG_SZ, '')
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, scheme + r'\shell\open\command') as key:
        # The handler always starts this workshop. It does not consume URL arguments.
        command = f'"{pythonw}" "{Path(__file__).resolve()}"'
        winreg.SetValueEx(key, '', 0, winreg.REG_SZ, command)


def serve():
    import msvcrt
    folder = Path(os.environ['LOCALAPPDATA']) / 'AIRFORM'
    folder.mkdir(exist_ok=True)
    with (folder / 'launcher.lock').open('a+b') as lock:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return  # A previous click already started the service.
        with (folder / 'workshop.log').open('wb') as log:
            env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
            subprocess.run([str(PYTHON), '-u', '-m', 'backend.astra.server'],
                           cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                           creationflags=subprocess.CREATE_NO_WINDOW, check=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--register']:
        register()
    else:
        serve()
