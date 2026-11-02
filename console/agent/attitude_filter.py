"""Offline candidate: six-axis complementary attitude, no device access or writes.

Quaternion [w,x,y,z] maps sensor -> local world (+Z up). Accel is specific
force (+up at rest); projected gravity is its negative direction. Heading is
unobservable without an external reference. Constant linear acceleration can
still be mistaken for tilt even with the magnitude gate below.
"""
import math

G = 9.80665


def vector(value, size=3):
    return (isinstance(value, (list, tuple)) and len(value) == size and
            all(type(v) in (int, float) and math.isfinite(v) for v in value))


def norm(v):
    return math.sqrt(sum(x*x for x in v))


def unit(v):
    size = norm(v)
    if size < 1e-12:
        raise ValueError('zero vector')
    return [x/size for x in v]


def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def multiply(q, r):
    w,x,y,z = q
    a,b,c,d = r
    return [w*a-x*b-y*c-z*d, w*b+x*a+y*d-z*c,
            w*c-x*d+y*a+z*b, w*d+x*c-y*b+z*a]


def up_in_sensor(q):
    w,x,y,z = q
    return [2*(x*z-w*y), 2*(y*z+w*x), 1-2*(x*x+y*y)]


def initial_orientation(accel):
    x,y,z = accel
    roll = math.atan2(y,z)
    pitch = math.atan2(-x, math.hypot(y,z))
    cr,sr,cp,sp = math.cos(roll/2),math.sin(roll/2),math.cos(pitch/2),math.sin(pitch/2)
    return [cr*cp, sr*cp, cr*sp, -sr*sp]


class AttitudeFilter:
    """Proportional Mahony-style gravity correction plus measured static gyro bias.

    Gain 2/s is an initial engineering setting, not validated robot dynamics.
    No online bias learning: motion cannot silently rewrite calibration.
    """
    def __init__(self, bias):
        if not vector(bias):
            raise ValueError('three finite gyro bias values required')
        self.bias = list(bias)
        self.reset()

    def reset(self):
        self.q = None
        self.time = None
        self.still_since = None
        self.last_accel = None
        self.last_gravity = None

    def invalid(self, reason):
        return dict(valid=False, quat=None, gravity=None, error=reason,
                    frame='sensor_to_world', heading_reference='relative_unobservable',
                    orientation_calibrated=False, strategy_ready=False)

    def update(self, sample):
        t = sample.get('sample_time')
        if (sample.get('valid') is not True or sample.get('saturated') is not False or
                not vector(sample.get('accel_m_s2')) or not vector(sample.get('gyro_rad_s')) or
                type(t) not in (int,float) or not math.isfinite(t)):
            self.reset()
            return self.invalid('invalid_raw_sample')
        if self.time is not None and t <= self.time:
            return self.invalid('non_increasing_time')
        if self.time is not None and t-self.time > .15:
            self.reset()
        dt = t-self.time if self.time is not None else 0.0
        self.time = t
        accel = sample['accel_m_s2']
        gyro = [x-b for x,b in zip(sample['gyro_rad_s'],self.bias)]
        magnitude = norm(accel)
        use_accel = .85*G <= magnitude <= 1.15*G
        measured_up = unit(accel) if use_accel else None
        if self.q is None:
            stationary = (use_accel and norm(gyro) < .05 and
                          (self.last_accel is None or norm([x-y for x,y in zip(accel,self.last_accel)]) < .2))
            self.last_accel = list(accel)
            if not stationary:
                self.still_since = None
                return self.invalid('waiting_for_stationary_initialization')
            if self.still_since is None:
                self.still_since = t
            if t-self.still_since < .5:
                return self.invalid('waiting_for_stationary_initialization')
            self.q = initial_orientation(accel)
            self.last_gravity = t
        else:
            if use_accel:
                error = cross(measured_up,up_in_sensor(self.q))
                gyro = [w+2.0*e for w,e in zip(gyro,error)]
                self.last_gravity = t
            speed = norm(gyro)
            angle = speed*dt
            delta = [math.cos(angle/2), *[w*math.sin(angle/2)/speed for w in gyro]] if speed > 1e-12 else [1.,0.,0.,0.]
            self.q = unit(multiply(self.q,delta))
        if t-self.last_gravity > .5:
            self.reset()
            return self.invalid('gravity_correction_unavailable')
        return dict(valid=True, quat=list(self.q), gravity=[-v for v in up_in_sensor(self.q)],
                    sample_time=t, frame='sensor_to_world', quat_order='wxyz',
                    accel_correction_used=use_accel, heading_reference='relative_unobservable',
                    orientation_calibrated=False, strategy_ready=False, error=None)
