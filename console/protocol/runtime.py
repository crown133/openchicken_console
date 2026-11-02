"""Map the existing robotd IPC snapshots to console fields. No sensor acquisition."""
import math
from protocol.model import MODEL_ID, joint_manifest, validate_velocity

PROTOCOL = 'openchicken-runtime-v1'


def vector(value, size):
    return isinstance(value, list) and len(value) == size and all(
        type(v) in (int, float) and math.isfinite(v) for v in value)


def orientation(sample, stamp, head=False):
    if not sample:
        return None
    q, gyro, accel = sample.get('quat'), sample.get('gyro'), sample.get('accel')
    if not vector(q, 4) or not vector(gyro, 3):
        return None
    if head:
        # The upstream head stream is sensor->world. Head = Rz(pi) * sensor.
        w, x, y, z = q
        q = [z, -y, x, -w]  # q_sensor_world * inverse(q_sensor_head)
        gyro = [-gyro[0], -gyro[1], gyro[2]]
        accel = [-accel[0], -accel[1], accel[2]] if vector(accel, 3) else None
    return dict(valid=True, sensor='BMI088' if head else 'LSM6DSV16X',
                frame='head_to_world' if head else 'body_to_world', quat_order='wxyz',
                vectors_frame='head_axes' if head else 'body_axes', sample_time=stamp,
                quat=q, gyro_rad_s=gyro, accel_m_s2=accel,
                temperature_c=sample.get('temp_c'))


def snapshot(robot_id, boot_id, seq, now, frame, model, health, policies, head, system,
             connected, control):
    manifest = joint_manifest()
    names = model.get('joint_names', [])
    indices = {name: i for i, name in enumerate(names)}
    stamp = frame.get('t_ns', 0)/1e9 if frame else None
    def at(field, index):
        values = frame.get(field) or []
        return values[index] if index is not None and index < len(values) else None
    joints = []
    for item in manifest:
        i = indices.get(item['name'])
        position = at('joints', i)
        valid = connected and at('joint_feedback_valid', i) is True and position is not None
        row = dict(id=item['id'], name=item['name'], label=item['label'], valid=valid,
                   position=position if valid else None, requested=at('targets', i),
                   submitted=at('submitted', i), velocity=at('velocities', i),
                   current_ma=at('currents_ma', i), temperature=at('temperatures', i),
                   error=at('hardware_errors', i), sample_time=stamp,
                   torque=None, register_target=None, voltage=None,
                   p=None, i=None, d=None, homing_offset=None, pwm_slope=None,
                   pwm_limit=None, drive_mode=None)
        row['status'] = 'unknown' if not valid else 'error' if row['error'] else 'ok'
        joints.append(row)
    system = dict(system)
    system.update(voltage=(health.get('battery') or {}).get('volts'),
                  voltage_source='robotd', cpu_temp=health.get('cpu_temp_c', system.get('cpu_temp')))
    body = orientation(frame.get('imu'), stamp) if connected else None
    if body:
        body['gravity'] = (frame.get('safety') or {}).get('gravity')
        # This is the runtime's original readiness, not a console calibration gate.
        body['valid'] = (health.get('imu') or {}).get('ready', False)
    return dict(protocol=PROTOCOL, schema_version=1, robot_id=robot_id, boot_id=boot_id,
                seq=seq, sample_time=now, clock_domain='robot_monotonic', source='robot',
                runtime_status='connected' if connected else 'disconnected',
                enabled=frame.get('enabled') if connected else None,
                bringup=frame.get('bringup') if connected else None,
                seated=policies.get('sitting'), torqued=None, controlled=False, action=None,
                joints=joints, joints_valid=all(j['valid'] for j in joints),
                model=MODEL_ID, manifest=manifest, system=system, collection_valid=True,
                imu=body, head_imu=orientation(head, head.get('t_ns', 0)/1e9, True) if head else None,
                control_loop=frame.get('loop'), policy=frame.get('policy'),
                capabilities=dict(motion=control, init=control, relax=control, estop=control,
                                  skills=policies.get('skills', []) if control else []))


def validate_state(state):
    # A malformed field must not turn into a fabricated measurement. No physics re-checks.
    return (isinstance(state, dict) and state.get('protocol') == PROTOCOL and
            isinstance(state.get('joints'), list) and isinstance(state.get('system'), dict) and
            isinstance(state.get('seq'), int) and isinstance(state.get('boot_id'), str))


def command(kind, payload):
    if kind in ('init', 'relax', 'stop'):
        return 'robot.'+kind, {}
    if kind == 'estop':
        return 'robot.relax', {}
    if kind == 'enable':
        return 'robot.enable', {'on': True}
    if kind == 'drive':
        velocity = validate_velocity(payload)
        return 'robot.move', {k: velocity.get(k, 0.) for k in ('vx', 'vy', 'vyaw')}
    if kind == 'action':
        return 'robot.do', {'skill': payload['skill']}
    if kind == 'head':
        return 'robot.head', payload
    raise ValueError('unsupported runtime command')
