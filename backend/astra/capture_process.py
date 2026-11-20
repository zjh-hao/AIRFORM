"""Keep native OpenNI/DirectShow ownership on a dedicated process's main thread.

Windows capture backends have thread/apartment-specific state. A fresh child per
session also isolates driver failures and prevents old handles surviving restart.
The pipe is strictly request/reply: at most one RGB-D pair can be in flight.
"""
import multiprocessing
from types import SimpleNamespace

from .camera import AstraCamera


def capture_worker(connection, options):
    camera = None
    try:
        camera = AstraCamera(**options)
        connection.send(('ready', {'device': camera.info, 'metadata': camera.registration.metadata}))
        while True:
            command = connection.recv()
            if command == 'stop':
                break
            if command != 'read':
                raise ValueError('Unknown capture command')
            connection.send(('frame', camera.read()))
    except (EOFError, BrokenPipeError):
        pass
    except Exception as error:
        try:
            connection.send(('error', str(error)))
        except (EOFError, BrokenPipeError, OSError):
            pass
    finally:
        if camera is not None:
            camera.close()
        connection.close()


class IsolatedAstra:
    def __init__(self, **options):
        context = multiprocessing.get_context('spawn')
        self.connection, child = context.Pipe()
        self.process = context.Process(target=capture_worker, args=(child, options), name='astra-native')
        self.process.start()
        child.close()
        try:
            metadata = self._receive('ready', timeout=25)
            self.info = metadata['device']
            self.registration = SimpleNamespace(metadata=metadata['metadata'])
        except BaseException:
            self.close()
            raise

    def _receive(self, expected, timeout=3):
        if not self.connection.poll(timeout):
            raise RuntimeError('Astra capture process timed out; check USB connection')
        try:
            kind, data = self.connection.recv()
        except (EOFError, OSError) as error:
            raise RuntimeError('Astra native capture process exited') from error
        if kind == 'error':
            raise RuntimeError(data)
        if kind != expected:
            raise RuntimeError(f'Invalid capture response: {kind}')
        return data

    def read(self):
        try:
            self.connection.send('read')
        except (BrokenPipeError, OSError) as error:
            raise RuntimeError('Astra native capture process disconnected') from error
        return self._receive('frame')

    def close(self):
        try:
            if self.process.is_alive():
                try:
                    self.connection.send('stop')
                except (BrokenPipeError, OSError):
                    pass
                self.process.join(3)
                if self.process.is_alive():
                    # Native driver hung: ending this isolated process closes its
                    # OS handles. Never terminate unrelated camera processes.
                    self.process.terminate()
                    self.process.join(1)
        finally:
            self.connection.close()
