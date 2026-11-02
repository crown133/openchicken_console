"""Inspect validated real telemetry in policy joint order; never issue a policy input.

Positions/velocities retain servo-register axes until model mapping is accepted.
No previous actions or commands are fabricated to complete a 61-value vector.
"""
from protocol.model import joint_manifest

# openchicken-ipc-proto JOINT_IDS, with mouth ID34 excluded.
POLICY_IDS = (20,21,22,23,24,30,31,32,33,10,11,12,13,14)


def sensor_observation(state):
    joints={j['id']:j for j in state['joints']}
    if len(joints)!=14 or set(joints)!=set(POLICY_IDS):
        raise ValueError('missing/duplicate/unexpected observation joints')
    homes={j['id']:j['home'] for j in joint_manifest()}
    positions=[];velocities=[];relative=[];times=[]
    reasons=['policy_command_and_previous_action_not_supplied',
             'joint_model_mapping_not_accepted','body_dynamic_and_timing_acceptance_pending']
    for device_id in POLICY_IDS:
        j=joints[device_id]
        fresh=(j['valid'] and 0 <= state['sample_time']-j['sample_time'] <= .25)
        position=j['position'] if fresh else None
        velocity=j.get('velocity') if fresh else None
        positions.append(position);velocities.append(velocity)
        relative.append(position-homes[device_id] if position is not None else None)
        times.append(j.get('sample_time') if fresh else None)
        if not fresh:reasons.append(f'joint_{device_id}_missing_or_stale')
        if velocity is None:reasons.append(f'joint_{device_id}_velocity_unavailable')
        if j.get('error') or j.get('alert'):reasons.append(f'joint_{device_id}_hardware_alert')
    body=state.get('imu') or {}
    fresh_body=(body.get('valid') is True and body.get('frame')=='body_to_world' and
                0 <= state['sample_time']-body['sample_time'] <= .25)
    if not fresh_body:reasons.append('body_imu_missing_or_stale')
    if body.get('strategy_ready') is not True:reasons.append('body_imu_monitor_only')
    stamps=[t for t in times if t is not None]
    if fresh_body:stamps.append(body['sample_time'])
    return dict(source='robot',boot_id=state['boot_id'],seq=state['seq'],
                policy_joint_ids=list(POLICY_IDS),joint_frame='servo_register',
                position_rad=positions,relative_position_rad=relative,velocity_rad_s=velocities,
                joint_sample_times=times,body_sample_time=body.get('sample_time'),
                body_gyro_rad_s=body['gyro_rad_s'] if fresh_body else None,
                body_projected_gravity=body['gravity'] if fresh_body else None,
                sensor_time_span_s=max(stamps)-min(stamps) if stamps else None,
                measured_fields_available=(fresh_body and None not in positions and None not in velocities),
                strategy_ready=False,policy_input=None,blocking_reasons=reasons,
                head_imu_used=False,head_imu_issue='IMU-HEAD-01 deferred')
