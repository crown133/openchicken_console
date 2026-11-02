"""Read-only monitoring fusion in explicit robot/head axes; never strategy-ready."""
import hashlib
import json
from pathlib import Path

from agent.attitude_filter import AttitudeFilter,initial_orientation,multiply,norm,vector
from agent.imu_mounting import rotation,transform


class Orientations:
    def __init__(self,path,robot_id,calibration_id):
        data=Path(path).read_bytes()
        if hashlib.sha256(data).hexdigest()!=calibration_id:
            raise ValueError('orientation calibration hash mismatch')
        profile=json.loads(data)
        if (profile.get('schema_version')!=1 or profile.get('robot_id')!=robot_id or
                profile.get('purpose')!='readonly_orientation_monitor' or
                set(profile.get('sensors',{}))!={'imu_raw','head_imu_raw'}):
            raise ValueError('wrong orientation calibration identity/schema')
        self.calibration_id=calibration_id
        self.entries={}
        for key,sensor in [('imu_raw','LSM6DSV16X'),('head_imu_raw','BMI088')]:
            entry=profile['sensors'][key]
            if entry.get('sensor')!=sensor or entry.get('mounting_status') not in ('user_confirmed','provisional'):
                raise ValueError('wrong sensor/mounting status')
            if entry.get('gyro_bias_status') not in ('static_screen_passed','provisional_noise_flagged'):
                raise ValueError('wrong gyro bias status')
            bias=entry.get('gyro_bias_rad_s')
            if not vector(bias) or max(map(abs,bias))>.1:
                raise ValueError('invalid gyro bias')
            matrix=rotation(entry['mounting'])
            reference=entry.get('level_reference_accel_m_s2')
            if reference is not None:
                if (key!='imu_raw' or entry.get('level_reference_status')!='operator_upright_approximate' or
                        not vector(reference) or not 9.0<norm(reference)<10.6):
                    raise ValueError('invalid upright gravity reference')
                q=initial_orientation(transform(matrix,reference));w,x,y,z=q
                def rotate(v):return multiply(multiply(q,[0,*v]),[w,-x,-y,-z])[1:]
                columns=[rotate([matrix[row][col] for row in range(3)]) for col in range(3)]
                matrix=[[columns[col][row] for col in range(3)] for row in range(3)]
            elif entry.get('level_reference_status')!='not_set':
                raise ValueError('level reference status mismatch')
            self.entries[key]=(entry,matrix,AttitudeFilter(transform(matrix,bias)))

    def sample(self,state):
        result={}
        for key,(entry,matrix,fusion) in self.entries.items():
            raw=state[key];converted=dict(raw)
            if raw.get('valid') is True:
                converted.update(accel_m_s2=transform(matrix,raw['accel_m_s2']),
                                 gyro_rad_s=transform(matrix,raw['gyro_rad_s']))
            value=fusion.update(converted)
            value.update(sample_time=raw['sample_time'],frame='body_to_world' if key=='imu_raw' else 'head_to_world',
                         quat_order='wxyz',sensor=entry['sensor'],method='complementary6d-v1',
                         calibration_id=self.calibration_id,mounting_status=entry['mounting_status'],
                         gyro_bias_status=entry['gyro_bias_status'],level_reference_status=entry['level_reference_status'],
                         monitor_only=True,nominal_update_hz=20,gyro_rad_s=None,accel_m_s2=None,
                         vectors_frame='body_axes' if key=='imu_raw' else 'head_axes')
            if value['valid']:
                value['accel_m_s2']=list(converted['accel_m_s2'])
                value['gyro_rad_s']=[a-b for a,b in zip(converted['gyro_rad_s'],fusion.bias)]
            result[key.removesuffix('_raw')]=value
        return result
