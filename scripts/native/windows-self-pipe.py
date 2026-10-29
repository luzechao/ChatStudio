import _winapi
from asyncio.windows_utils import PipeHandle, pipe


class WakeupWriter(PipeHandle):
    def send(self, data):
        written, _ = _winapi.WriteFile(self.fileno(), data)
        return written


def pipe_pair():
    reader, writer = pipe(overlapped=(True, False))
    incoming = PipeHandle(reader)
    outgoing = WakeupWriter(writer)
    try:
        # PIPE_NOWAIT: a full wakeup pipe must not block the event-loop thread.
        _winapi.SetNamedPipeHandleState(writer, 0x00000001, None, None)
    except BaseException:
        incoming.close()
        outgoing.close()
        raise
    return incoming, outgoing
