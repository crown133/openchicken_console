"""T1 system-only wire contract and pinned CURVE configuration; no command channel."""
import json
import math
from pathlib import Path
import re

import zmq
from protocol.runtime import PROTOCOL as RUNTIME_PROTOCOL
from protocol.model import MODEL_ID, joint_manifest

PROTOCOL = 'openchicken-system-t1-v1'
JOINT_PROTOCOL = 'openchicken-joints-t3-v1'
SENSOR_PROTOCOL = 'openchicken-sensors-t3-v1'
POWER_PROTOCOL = 'openchicken-power-t3-v1'
FUSION_PROTOCOL = 'openchicken-orientation-t5-v1'
OBSERVATION_PROTOCOL = 'openchicken-observation-t5-v1'


def load_config(path, role):
    config = json.loads(Path(path).read_text())
    if config.get('protocol') not in (PROTOCOL, JOINT_PROTOCOL, SENSOR_PROTOCOL, POWER_PROTOCOL, FUSION_PROTOCOL, OBSERVATION_PROTOCOL, RUNTIME_PROTOCOL) or config.get('role') != role:
        raise ValueError('incorrect T1 configuration role/protocol')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', config.get('robot_id', '')):
        raise ValueError('invalid robot identity')
    if not re.fullmatch(r'tcp://[A-Za-z0-9.*_-]+:[0-9]{1,5}', config.get('endpoint', '')):
        raise ValueError('T1 requires an explicit TCP endpoint')
    for name in ('public_key', 'secret_key', 'peer_public_key'):
        value = config.get(name)
        if not isinstance(value, str) or len(value) != 40:
            raise ValueError('invalid CURVE configuration')
    if zmq.curve_public(config['secret_key'].encode()).decode() != config['public_key']:
        raise ValueError('CURVE keypair mismatch')
    if config['protocol'] in (FUSION_PROTOCOL, OBSERVATION_PROTOCOL) and not re.fullmatch(r'[0-9a-f]{64}', config.get('calibration_id', '')):
        raise ValueError('fusion requires pinned calibration hash')
    if not config.get('hostname'):
        raise ValueError('expected robot hostname is required')
    return config


def unknown_state(robot_id):
    fields = ('position requested submitted register_target velocity current_ma torque error voltage '
              'temperature p i d pwm_slope pwm_limit drive_mode homing_offset').split()
    joints = [dict(id=j['id'], name=j['name'], label=j['label'], valid=False, status='unknown',
                   **dict.fromkeys(fields)) for j in joint_manifest()]
    return dict(protocol=PROTOCOL, schema_version=1, robot_id=robot_id, boot_id=None, seq=0,
                sample_time=None, clock_domain='agent_monotonic', source='robot',
                enabled=None, torqued=None, controlled=False, seated=None, bringup=None,
                action=None, runtime_status='not_connected', collection_valid=False,
                telemetry_hz=1, joints=joints, model=MODEL_ID, model_verified=False,
                manifest=joint_manifest(),
                capabilities=dict(motion=False, init=False, relax=False, estop=False, skills=[]),
                system=dict(cpu_percent=None, cpu_temp=None, memory_percent=None, voltage=None,
                            external_power=None, speaker='未知', microphone='未知'))


def validate_state(state, config):
    if not isinstance(state, dict):
        return False
    if any(state.get(k) != v for k, v in dict(protocol=config['protocol'], schema_version=1,
           robot_id=config['robot_id'], hostname=config['hostname'], source='robot',
           clock_domain='agent_monotonic', runtime_status='not_connected').items()):
        return False
    if not isinstance(state.get('boot_id'), str) or not state['boot_id']:
        return False
    if not isinstance(state.get('os_boot_id'), str) or not state['os_boot_id']:
        return False
    seq, sample = state.get('seq'), state.get('sample_time')
    if type(seq) is not int or seq < 1 or type(sample) not in (int, float) or not math.isfinite(sample):
        return False
    if config['protocol'] in (FUSION_PROTOCOL, OBSERVATION_PROTOCOL):
        return (validate_joints(state, config) and validate_imus(state) and
                validate_power(state) and validate_orientations(state, config))
    if any(state.get(k) is not None for k in ('imu','head_imu')):
        return False  # These monitor protocols do not supply calibrated orientations.
    if config['protocol'] == POWER_PROTOCOL:
        return validate_joints(state, config) and validate_imus(state) and validate_power(state)
    if 'power_input' in state:
        return False
    if config['protocol'] == SENSOR_PROTOCOL:
        return validate_joints(state, config) and validate_imus(state)
    if any(k in state for k in ('imu_raw','head_imu_raw')):
        return False
    if config['protocol'] == JOINT_PROTOCOL:
        return validate_joints(state, config)
    expected = unknown_state(config['robot_id'])
    for key in ('capabilities', 'joints', 'enabled', 'torqued', 'controlled', 'bringup'):
        if state.get(key) != expected[key]:
            return False
    system = state.get('system')
    if not isinstance(system, dict) or any(system.get(k) is not None for k in ('voltage', 'external_power')):
        return False
    for key, low, high in (('cpu_percent', 0, 100), ('memory_percent', 0, 100), ('cpu_temp', -50, 200)):
        if key not in system:
            return False
        value = system[key]
        if value is not None and (type(value) not in (float, int) or not math.isfinite(value) or not low <= value <= high):
            return False
    return all(system.get(key) in ('未知', '未枚举', '已枚举 · 未验证') for key in ('speaker', 'microphone'))


def validate_joints(state, config):
    expected = unknown_state(config['robot_id'])
    if any(state.get(k) != expected[k] for k in ('capabilities', 'enabled', 'controlled', 'bringup')):
        return False
    if state.get('model_verified') is not False:
        return False
    joints, system = state.get('joints'), state.get('system')
    if not isinstance(joints, list) or len(joints) != 14 or not isinstance(system, dict):
        return False
    voltages = []
    for joint, blank in zip(joints, expected['joints']):
        if not isinstance(joint, dict) or any(joint.get(k) != blank[k] for k in ('id', 'name')):
            return False
        if type(joint.get('valid')) is not bool:
            return False
        if not joint['valid']:
            if any(joint.get(k) is not None for k in ('raw_velocity','read_started_at','velocity_unit','velocity_frame','velocity_source')):
                return False
            if any(joint.get(k) != v for k, v in blank.items() if k != 'label'):
                return False
            continue
        if joint.get('torque') is not False or joint.get('status') not in ('warning', 'error'):
            return False
        if any(joint.get(k) is not None for k in ('requested', 'submitted', 'register_target', 'current_ma')):
            return False
        if config['protocol'] == OBSERVATION_PROTOCOL:
            raw, velocity = joint.get('raw_velocity'), joint.get('velocity')
            if type(raw) is not int or not -(2**31) <= raw < 2**31:
                return False
            if type(velocity) not in (int,float) or not math.isfinite(velocity):
                return False
            if any(joint.get(k)!=v for k,v in dict(velocity_unit='rad/s',velocity_frame='servo_register',velocity_source='dxl_present_velocity_128').items()):
                return False
            started, ended = joint.get('read_started_at'), joint.get('sample_time')
            if type(started) not in (int,float) or not math.isfinite(started) or type(ended) not in (int,float) or not math.isfinite(ended) or not 0 <= started <= ended <= state['sample_time'] or state['sample_time']-started > .25:
                return False
        elif joint.get('velocity') is not None or any(k in joint for k in ('raw_velocity','velocity_unit','velocity_frame','velocity_source','read_started_at')):
            return False
        count = joint.get('raw_position')
        if type(count) is not int or not -(2**31) <= count < 2**31:
            return False
        angle = joint.get('position')
        if type(angle) not in (int, float) or not math.isfinite(angle):
            return False
        for key, low, high in (('voltage', 0, 6553.5), ('temperature', 0, 255), ('sample_time', 0, float('inf'))):
            value = joint.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
                return False
        for key, low, high in (('error', 0, 255), ('p', 0, 65535), ('i', 0, 65535), ('d', 0, 65535),
                               ('drive_mode', 0, 255), ('homing_offset', -(2**31), 2**31-1),
                               ('pwm_slope', 0, 255), ('pwm_limit', 0, 65535)):
            value = joint.get(key)
            if type(value) is not int or not low <= value <= high:
                return False
        if type(joint.get('alert')) is not bool or joint['status'] != ('error' if joint['error'] or joint['alert'] else 'warning'):
            return False
        voltages.append(joint['voltage'])
    valid = len(voltages) == 14
    if state.get('joints_valid') is not valid or state.get('torqued') is not (False if valid else None):
        return False
    if (config['protocol'] not in (POWER_PROTOCOL, FUSION_PROTOCOL, OBSERVATION_PROTOCOL) and system.get('external_power') is not None) or system.get('voltage_source') != 'dxl_mean':
        return False
    if type(system.get('voltage_samples')) is not int or system['voltage_samples'] != len(voltages):
        return False
    # Conversion and aggregation belong to the producer; validate wire values here.
    for key in ('voltage', 'voltage_min', 'voltage_max'):
        value = system.get(key)
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
            return False
    for key, low, high in (('cpu_percent', 0, 100), ('memory_percent', 0, 100), ('cpu_temp', -50, 200)):
        if key not in system:
            return False
        value = system[key]
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high):
            return False
    return all(system.get(k) in ('未知', '未枚举', '已枚举 · 未验证') for k in ('speaker', 'microphone'))


def validate_imus(state):
    for key,sensor in (('head_imu_raw','BMI088'), ('imu_raw','LSM6DSV16X')):
        sample=state.get(key)
        if not isinstance(sample,dict) or sample.get('sensor')!=sensor or sample.get('frame')!='sensor_axes':
            return False
        if sample.get('orientation_calibrated') is not False or type(sample.get('valid')) is not bool:
            return False
        if sample.get('quat') is not None:
            return False
        times=[sample.get('read_started_at'),sample.get('sample_time')]
        if any(type(t) not in (int,float) or not math.isfinite(t) for t in times):
            return False
        if not 0<=times[0]<=times[1]<=state['sample_time']:
            return False
        fields=('raw_accel','raw_gyro','accel_m_s2','gyro_rad_s','temperature_c','saturated')
        if not sample['valid']:
            if any(sample.get(k) is not None for k in fields) or not isinstance(sample.get('error'),str):
                return False
            continue
        if state['sample_time']-times[1]>.25 or sample.get('error') is not None:
            return False
        for raw_key,scaled_key in (('raw_accel','accel_m_s2'), ('raw_gyro','gyro_rad_s')):
            raw,scaled=sample.get(raw_key),sample.get(scaled_key)
            if not isinstance(raw,list) or not isinstance(scaled,list) or len(raw)!=3 or len(scaled)!=3:
                return False
            if any(type(v) is not int or not -32768<=v<=32767 for v in raw):
                return False
            if any(type(v) not in (int,float) or not math.isfinite(v) for v in scaled):
                return False
        temp=sample.get('temperature_c')
        if type(temp) not in (int,float) or not math.isfinite(temp) or not -105<=temp<=153:
            return False
        saturated=any(abs(v)>=32760 for v in sample['raw_accel']+sample['raw_gyro'])
        if sample.get('saturated') is not saturated:
            return False
        if sensor=='BMI088' and (type(sample.get('sensor_time_ticks')) is not int or not 0<=sample['sensor_time_ticks']<2**24):
            return False
    return True


def validate_power(state):
    power = state.get('power_input')
    if not isinstance(power, dict) or any(power.get(k) != v for k,v in
            dict(controller='gpio@fe760000', offset=12, line='PIN_31').items()):
        return False
    sample = power.get('sample_time')
    if type(sample) not in (int,float) or not math.isfinite(sample) or not 0 <= state['sample_time']-sample <= .35:
        return False
    raw, value, count = power.get('raw'), power.get('value'), power.get('stable_samples')
    if any(v is not None and type(v) is not bool for v in (raw, value)):
        return False
    if power.get('valid') is not (value is not None) or state['system'].get('external_power') is not value:
        return False
    if type(count) is not int or not 0 <= count <= 3:
        return False
    if raw is None:
        return value is None and count == 0 and isinstance(power.get('error'), str)
    return (power.get('error') is None and count >= 1 and
            (count != 3 or value is raw))


def validate_orientations(state, config):
    for key,sensor,frame in (('imu','LSM6DSV16X','body_to_world'),('head_imu','BMI088','head_to_world')):
        value=state.get(key)
        if not isinstance(value,dict):
            return False
        fixed=dict(sensor=sensor,frame=frame,quat_order='wxyz',
                   calibration_id=config.get('calibration_id'))
        if any(value.get(k)!=v for k,v in fixed.items()):
            return False
        if (value.get('orientation_calibrated') is not False or value.get('strategy_ready') is not False or
                value.get('monitor_only') is not True or type(value.get('valid')) is not bool):
            return False
        raw=state[key+'_raw']
        if value.get('sample_time')!=raw['sample_time']:
            return False
        # Older recordings/agents omit both mounted-acceleration fields.
        mounted='accel_m_s2' in value or 'vectors_frame' in value
        if mounted:
            if value.get('vectors_frame')!=('body_axes' if key=='imu' else 'head_axes') or 'accel_m_s2' not in value:
                return False
            accel=value['accel_m_s2']
            if value['valid']:
                if not isinstance(accel,list) or len(accel)!=3 or any(type(x) not in (int,float) or not math.isfinite(x) for x in accel):
                    return False
            elif accel is not None:
                return False
        if not value['valid']:
            if any(value.get(k) is not None for k in ('quat','gravity','gyro_rad_s')) or not isinstance(value.get('error'),str):
                return False
            continue
        if (not raw['valid'] or raw['saturated'] or value.get('error') is not None or
                type(value.get('accel_correction_used')) is not bool):
            return False
        for name,size in (('quat',4),('gravity',3),('gyro_rad_s',3)):
            v=value.get(name)
            if not isinstance(v,list) or len(v)!=size or any(type(x) not in (int,float) or not math.isfinite(x) for x in v):
                return False
        q=value['quat']
        if not math.isclose(sum(x*x for x in q),1,abs_tol=1e-6):
            return False
        if max(map(abs,value['gyro_rad_s']))>40:
            return False
    return True
