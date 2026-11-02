"""Read an inherited Pin31 request fd; never open/configure/output a GPIO line."""
import fcntl
import struct
import time


class PowerProbe:
    def __init__(self, fd):
        self.fd = fd
        self.last = float('-inf')
        self.candidate = None
        self.count = 0
        self.value = None
        self.state = None

    def sample(self):
        now = time.monotonic()
        if now-self.last < .1:
            return dict(self.state)
        self.last = now
        raw, error = None, None
        try:
            data = bytearray(struct.pack('<QQ', 0, 1))
            fcntl.ioctl(self.fd, 0xc010b40e, data, True)  # GET_VALUES only
            bits, mask = struct.unpack('<QQ', data)
            if mask != 1 or bits not in (0, 1):
                raise ValueError('invalid Pin31 value')
            raw = bool(bits)
            self.count = min(3, self.count+1) if raw is self.candidate else 1
            self.candidate = raw
            if self.count == 3:
                self.value = raw
        except (OSError, ValueError) as exc:
            self.value = self.candidate = None
            self.count = 0
            error = str(exc)
        self.state = dict(controller='gpio@fe760000', offset=12, line='PIN_31',
                          sample_time=time.monotonic(), raw=raw, value=self.value,
                          valid=self.value is not None, stable_samples=self.count, error=error)
        return dict(self.state)
