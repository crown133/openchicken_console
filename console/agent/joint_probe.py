"""T3 candidate: individual READ only, fixed UART5 and 14 IDs; never changes torque."""
import math
import os
import select
import struct
import subprocess
import termios
import time

from agent import dxl_wire as wire
from protocol.readonly import unknown_state

READS = {(0, 64), (64, 83)}
wire.READS = READS
PARAMETERS = ('torque', 'p', 'i', 'd', 'homing_offset', 'drive_mode', 'pwm_slope', 'pwm_limit')


def read_packet(device_id, address, size):
    if device_id not in wire.JOINTS or (address, size) not in READS:
        raise ValueError('outside T3 read whitelist')
    return wire.packet(device_id, 2, struct.pack('<HH', address, size))


def read(fd, device_id, address, size, stats):
    packet = read_packet(device_id, address, size)
    termios.tcflush(fd, termios.TCIFLUSH)
    deadline, sent = time.monotonic() + .02, 0
    while sent < len(packet):
        if not select.select([], [fd], [], max(0, deadline-time.monotonic()))[1]:
            raise TimeoutError('serial transmit timeout')
        sent += os.write(fd, packet[sent:])
    stats['requests'] += 1
    buffer = bytearray()
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], max(0, deadline-time.monotonic()))[0]:
            break
        buffer.extend(os.read(fd, 512))
        while True:
            frame = wire.take_frame(buffer, stats)
            if frame is None:
                break
            returned_id, body = frame
            if returned_id != device_id or not body or body[0] != 0x55:
                continue
            if len(body) != size+2 or body[1] & 0x7f:
                raise ValueError('invalid DXL status response')
            stats['status_packets'] += 1
            return body[2:], bool(body[1] & 0x80)
    stats['timeouts'] += 1
    raise TimeoutError(f'ID {device_id} read timeout')


def decode(config, runtime, alert=False, *, include_velocity=False):
    if len(config) != 64 or len(runtime) != 83:
        raise ValueError('incomplete read blocks')
    image = config + runtime
    def u(address, size=1, signed=False):
        return int.from_bytes(image[address:address+size], 'little', signed=signed)
    if u(64) not in (0, 1):
        raise ValueError('invalid torque register')
    count, error = u(132, 4, True), u(70)
    result = dict(valid=True, status='error' if error or alert else 'warning',
                raw_position=count, position=(count-2048)*2*math.pi/4096,
                voltage=u(144, 2)/10, temperature=u(146), torque=bool(u(64)), error=error,
                alert=alert, p=u(84, 2), i=u(82, 2), d=u(80, 2),
                drive_mode=u(10), homing_offset=u(20, 4, True), pwm_limit=u(36, 2), pwm_slope=u(62))
    if include_velocity:
        raw = u(128, 4, True)
        result.update(raw_velocity=raw, velocity=raw*.229*2*math.pi/60,
                      velocity_unit='rad/s', velocity_frame='servo_register',
                      velocity_source='dxl_present_velocity_128')
    return result


class JointProbe:
    def __init__(self, fd, *, include_velocity=False):
        self.fd = fd
        self.include_velocity = include_velocity
        self.configs = {}
        self.stats = dict.fromkeys(('requests', 'status_packets', 'timeouts', 'crc_errors', 'invalid_lengths'), 0)

    def audit(self):
        rows = []
        for device_id in wire.JOINTS:
            config, _ = read(self.fd, device_id, 0, 64, self.stats)
            runtime, alert = read(self.fd, device_id, 64, 83, self.stats)
            if config[7] != device_id or config[8] != 3 or config[13] != 2:
                raise ValueError(f'ID {device_id}: unexpected ID/baud/protocol')
            row = dict(id=device_id, **decode(config, runtime, alert, include_velocity=self.include_velocity))
            rows.append(row)
            self.configs[device_id] = config
        return rows

    def sample(self):
        joints = unknown_state('unused')['joints']
        for joint in joints:
            try:
                started = time.monotonic()
                runtime, alert = read(self.fd, joint['id'], 64, 83, self.stats)
                joint.update(decode(self.configs[joint['id']], runtime, alert, include_velocity=self.include_velocity))
                joint['sample_time'] = time.monotonic()
                if self.include_velocity:
                    joint['read_started_at'] = started
            except (TimeoutError, ValueError) as exc:
                joint['read_error'] = str(exc)
        require_no_torque(joints)
        return joints


def require_no_torque(joints):
    if any(j.get('torque') is True for j in joints):
        raise RuntimeError('T3 stopped: torque enabled; no torque command was sent')


def check_services():
    result = subprocess.run(['systemctl', 'is-active', 'robotd', 'padd', 'netpadd'],
                            capture_output=True, text=True, timeout=5)
    states = result.stdout.splitlines()
    if len(states) != 3 or any(s not in ('inactive', 'failed', 'unknown') for s in states):
        raise RuntimeError('robot service state does not permit exclusive T3 read access')
