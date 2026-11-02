"""Reviewed-scope candidate: two sensor-axis IMU streams, temporary setup/restore.

BMI088 datasheet rev1.9; LSM6DSV16X settings match scripts/test-j5-imu.py.
No fusion, GPIO, motor writes, reset, FIFO, interrupt or kernel-driver changes.
"""
from contextlib import contextmanager
import ctypes
import errno
import fcntl
import math
import os
from pathlib import Path
import struct
import time

# Exact idle baseline read on openchicken1; refuse drift before touching configuration.
BASELINE = {0x19:{0x00:0x1e,0x40:0xa8,0x41:1,0x7c:3,0x7d:0},
            0x68:{0x00:0x0f,0x0f:0,0x10:0x80,0x11:0},
            0x6a:{0x0f:0x70,0x01:0,0x10:0,0x11:0,0x12:0x44,0x15:0,0x17:0}}
# BMI: enable accel, normal power, gyro 100Hz/32Hz LPF (bit7 read-only).
# LSM: +/-500 dps, HP gyro/accel120Hz; existing BDU/auto-increment and +/-2g stay.
SETUP = ((0x19,0x7d,4),(0x19,0x7c,0),(0x68,0x10,0x87),
         (0x6a,0x15,2),(0x6a,0x10,6),(0x6a,0x11,6))
WRITES = {(address,reg):{value,BASELINE[address][reg]} for address,reg,value in SETUP}
READS = {address:{(reg,1) for reg in registers} for address,registers in BASELINE.items()}
READS[0x19].update({(0x03,1),(0x12,9),(0x22,2)})
READS[0x68].add((0x02,6))
READS[0x6a].update({(0x1e,1),(0x20,14)})


class Message(ctypes.Structure):
    _fields_ = [('addr',ctypes.c_uint16),('flags',ctypes.c_uint16),
                ('len',ctypes.c_uint16),('buf',ctypes.POINTER(ctypes.c_uint8))]


class Transfer(ctypes.Structure):
    _fields_ = [('msgs',ctypes.POINTER(Message)),('nmsgs',ctypes.c_uint32)]


class Bus:
    def __init__(self, fd):
        self.fd = fd
        self.libc = ctypes.CDLL(None, use_errno=True)
        for address in BASELINE:
            fcntl.ioctl(fd, 0x0703, address)  # I2C_SLAVE, never FORCE.

    def transfer(self, address, reg, size=0, value=None):
        if value is None:
            if (reg,size) not in READS.get(address,set()):
                raise ValueError('outside IMU read whitelist')
        elif size or value not in WRITES.get((address,reg),set()):
            raise ValueError('outside temporary IMU configuration whitelist')
        payload = bytes([reg]) if value is None else bytes([reg,value])
        tx = (ctypes.c_uint8*len(payload))(*payload)
        rx = (ctypes.c_uint8*size)()
        messages = (Message*(2 if size else 1))()
        messages[0] = Message(address,0,len(tx),tx)
        if size: messages[1] = Message(address,1,size,rx)
        data = Transfer(messages,len(messages))
        result = self.libc.ioctl(self.fd,0x0707,ctypes.byref(data))
        if result < 0:
            error = ctypes.get_errno()
            raise OSError(error,os.strerror(error))
        if result != len(messages): raise OSError(errno.EIO,'incomplete I2C transfer')
        return bytes(rx)

    def read(self, address, reg, size=1):
        return self.transfer(address,reg,size=size)

    def write(self, address, reg, value):
        self.transfer(address,reg,value=value)
        time.sleep(.001)  # BMI088 suspend-mode write spacing >450us.


def snapshot(bus):
    return {a:{r:bus.read(a,r)[0] for r in regs} for a,regs in BASELINE.items()}


@contextmanager
def temporary_setup(bus, report):
    before = snapshot(bus)
    report['before'] = before
    if before != BASELINE:
        raise ValueError('IMU identity/config differs from reviewed idle baseline; no writes sent')
    attempted = []
    try:
        for address,reg,value in SETUP:
            attempted.append((address,reg))  # A failed write might still have reached hardware.
            bus.write(address,reg,value)
            if bus.read(address,reg)[0] != value:
                raise ValueError('IMU configuration readback mismatch')
        report['configured'] = snapshot(bus)
        time.sleep(.1)
        yield ImuProbe(bus)
    finally:
        errors = []
        for address,reg in reversed(attempted):
            try:
                bus.write(address,reg,before[address][reg])
                if bus.read(address,reg)[0] != before[address][reg]:
                    raise ValueError('restore readback mismatch')
            except (OSError,ValueError) as exc:
                errors.append(f'{address:#x}/{reg:#x}: {exc}')
        try:
            report['after'] = snapshot(bus)
            if report['after'] != before: errors.append('final configuration differs from baseline')
        except (OSError,ValueError) as exc:
            errors.append(str(exc))
        report.update(restored=not errors,restore_errors=errors)
        if errors: raise RuntimeError('IMU restore failed: '+'; '.join(errors))


@contextmanager
def imu_session(report):
    bus = Path('/dev/i2c-openchicken').resolve(strict=True)
    if (Path('/sys/class/i2c-dev')/bus.name/'device/of_node').resolve().name != 'i2c@fe5d0000':
        raise ValueError('IMU bus is not the configured I2C4 controller')
    with bus.open('r+b',buffering=0) as handle:
        fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        with temporary_setup(Bus(handle.fileno()),report) as probe:
            yield probe


def empty_sample(sensor):
    return dict(sensor=sensor,frame='sensor_axes',valid=False,sample_time=None,read_started_at=None,
                raw_accel=None,raw_gyro=None,accel_m_s2=None,gyro_rad_s=None,temperature_c=None,
                saturated=None,error=None,orientation_calibrated=False)


def converted(sensor, accel, gyro, temp, accel_scale, gyro_scale):
    return dict(empty_sample(sensor),valid=True,raw_accel=list(accel),raw_gyro=list(gyro),
                accel_m_s2=[v*accel_scale*9.80665 for v in accel],
                gyro_rad_s=[math.radians(v*gyro_scale) for v in gyro],temperature_c=temp,
                saturated=any(abs(v)>=32760 for v in (*accel,*gyro)))


def decode_bmi(accel, gyro, temperature):
    raw_temp=(temperature[0]<<3)|(temperature[1]>>5)
    if raw_temp>1023: raw_temp-=2048
    return dict(converted('BMI088',struct.unpack('<3h',accel[:6]),struct.unpack('<3h',gyro),
                          raw_temp*.125+23,6/32768,2000/32768),
                sensor_time_ticks=int.from_bytes(accel[6:9],'little'))


def decode_lsm(data):
    values=struct.unpack('<7h',data)
    return converted('LSM6DSV16X',values[4:7],values[1:4],values[0]/256+25,.000061,.0175)


class ImuProbe:
    def __init__(self,bus):
        self.bus=bus

    def sample(self):
        result={}
        for key,sensor in (('head_imu_raw','BMI088'),('imu_raw','LSM6DSV16X')):
            started=time.monotonic()
            try:
                if key=='head_imu_raw':
                    if not self.bus.read(0x19,0x03)[0]&0x80:
                        raise ValueError('accelerometer data not ready')
                    # Gyro DRDY is a 280–400us pulse, unsuitable as a 20Hz polling gate.
                    sample=decode_bmi(self.bus.read(0x19,0x12,9),self.bus.read(0x68,0x02,6),self.bus.read(0x19,0x22,2))
                else:
                    if self.bus.read(0x6a,0x1e)[0]&3 != 3:
                        raise ValueError('accelerometer/gyro data not ready')
                    sample=decode_lsm(self.bus.read(0x6a,0x20,14))
            except (OSError,ValueError,struct.error) as exc:
                sample=dict(empty_sample(sensor),error=str(exc))
            sample.update(read_started_at=started,sample_time=time.monotonic())
            result[key]=sample
        return result
