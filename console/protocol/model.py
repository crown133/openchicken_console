"""Explicit physical joints; never infer IDs from array positions."""
import math

MODEL_ID = 'alpha-full-65942920'
MODEL_DIRECTORY = 'alpha-full'

JOINTS = [
    (10, 'right_hip_yaw', '右髋偏航', 0.0),
    (11, 'right_hip_roll', '右髋侧摆', 0.0873),
    (12, 'right_hip_pitch', '右髋俯仰', 0.4579),
    (13, 'right_knee', '右膝', 0.0049),
    (14, 'right_ankle', '右踝', -0.4530),
    (20, 'left_hip_yaw', '左髋偏航', 0.0),
    (21, 'left_hip_roll', '左髋侧摆', -0.0873),
    (22, 'left_hip_pitch', '左髋俯仰', -0.4579),
    (23, 'left_knee', '左膝', -0.0049),
    (24, 'left_ankle', '左踝', 0.4530),
    (30, 'neck_pitch', '颈俯仰', 0.3491),
    (31, 'head_pitch', '头俯仰', 0.3491),
    (32, 'head_yaw', '头偏航', 0.0),
    (33, 'head_roll', '头侧倾', 0.0),
]
SKILLS = {
    'sit_toggle': ('坐下 / 站起', 2.0),
    'ground_pick': ('地面拾取', 3.0),
    'kick_left': ('左脚踢球', 0.8),
    'kick_right': ('右脚踢球', 0.8),
    'roulade': ('翻滚', 1.5),
}


def validate_velocity(value):
    if not isinstance(value, dict) or set(value) not in ({'vx', 'vyaw'}, {'vx', 'vy', 'vyaw'}):
        raise ValueError('速度字段必须为 vx / vy / vyaw')
    for key, limit in [('vx', 0.4), ('vy', 0.3), ('vyaw', 1.0)]:
        number = value.get(key, 0.)
        if isinstance(number, bool) or not isinstance(number, (int, float)):
            raise ValueError('速度必须是数值')
        if not math.isfinite(number) or abs(number) > limit:
            raise ValueError('速度超出模拟端范围')
    return dict(value)


def joint_manifest():
    return [dict(id=i, name=n, label=l, home=h,
                 homing_offset=-512 if i in (13, 23) else 0)
            for i, n, l, h in JOINTS]
