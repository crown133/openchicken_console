"""Unified browser pad contract. Only reads the explicitly selected native TOML file."""
import copy
import hashlib
import json
import math
from pathlib import Path

VERSION = 'openchicken-xbox-v3'
DEFAULTS = json.loads(Path(__file__).with_name('pad-defaults.json').read_text())
LIMITS = {'vx': .4, 'vy': .3, 'vyaw': 1.}
BINDINGS = dict(lb_a='sit_toggle', lb_down='ground_pick', lb_left='kick_left', lb_right='kick_right', lb_up='roulade')


def number(value, low, high):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('Invalid pad value or range')
    return value


def parameters(sections):
    result = copy.deepcopy(DEFAULTS)
    def merge(target, values):
        if not isinstance(values, dict) or set(values) - set(target):
            raise ValueError('Unknown native pad configuration')
        for key, value in values.items():
            if isinstance(target[key], dict):
                merge(target[key], value)
            else:
                target[key] = value
    merge(result, sections)
    axes = result['pad_axes']
    if axes['deadzone'] != .1:
        raise ValueError('Unified mapping requires native pad_axes.deadzone = 0.1')
    for mode in ('drive', 'head', 'head_drive', 'body_pose'):
        for binding in axes[mode].values():
            if binding['source'] not in ('none', 'left_x', 'left_y', 'right_x', 'right_y') or type(binding['invert']) is not bool:
                raise ValueError('Invalid native axis binding')
            number(binding['gain'], 0, 100)
    for value in result['pad_head'].values():
        number(value, 0, math.pi)
    body = result['pad_body']
    number(body['z_min'], -.1, 0)
    number(body['z_max'], 0, .1)
    for key in ('pitch_max', 'roll_max'):
        number(body[key], 0, math.pi)
    return result


def load_profile(path):
    # No path guessing, SSH or writes. Missing native data disables unified Xbox control.
    if not path:
        raise ValueError('Set pad_config to the robotd.toml used by native padd')
    try:
        import tomllib
    except ImportError:
        import tomli as tomllib
    raw = Path(path).read_bytes()
    config = tomllib.loads(raw.decode())
    bindings = dict(BINDINGS, **config.get('pad', {}))
    if set(bindings) != set(BINDINGS) or any(not isinstance(skill, str) or not skill for skill in bindings.values()):
        raise ValueError('Invalid native pad skill bindings')
    selected = {key: config[key] for key in DEFAULTS if key in config}
    params = parameters(selected)
    drive = config.get('pad_drive', {})
    for key, maximum in LIMITS.items():
        if drive.get(key+'_min', -maximum) != -maximum or drive.get(key+'_max', maximum) != maximum:
            raise ValueError('Native pad_drive differs from unified velocity limits')
    digest = hashlib.sha256(json.dumps(dict(parameters=params, bindings=bindings), sort_keys=True).encode()).hexdigest()
    return dict(version=VERSION, sha256=digest, source=str(path),
                source_sha256=hashlib.sha256(raw).hexdigest(), parameters=params,
                drive_limits=LIMITS, bindings=bindings, native_mapping_verified=False, hardware_verified=False)


def check_profile(payload, profile):
    if not profile or payload.get('version') != VERSION or payload.get('sha256') != profile['sha256']:
        raise ValueError('Unified pad profile is missing or changed; re-arm with current native configuration')


def release_calls():
    return [('robot.stop', {}), ('robot.pose', dict(z=0, roll=0, pitch=0, active=False)),
            ('robot.head', dict(neck_pitch=0, head_pitch=0, head_yaw=0, head_roll=0)),
            ('robot.mouth', dict(open=0)), ('robot.sound', dict(tag='wheee', hold=False)),
            ('robot.sound', dict(tag='chirp', hold=False))]


def calls(kind, payload, profile):
    check_profile(payload, profile)
    if kind == 'pad_command':
        actions = payload.get('actions')
        if not isinstance(actions, list) or not 1 <= len(actions) <= 6 or len(set(actions)) != len(actions):
            raise ValueError('Invalid pad actions')
        result = []
        for action in actions:
            if action == 'home':
                result += [('robot.pose', dict(z=0, roll=0, pitch=0, active=False)),
                           ('robot.head', dict(neck_pitch=0, head_pitch=0, head_yaw=0, head_roll=0)),
                           ('robot.enable', dict(on=False, toggle=False)), ('robot.init', {})]
            elif action == 'toggle':
                result.append(('robot.enable', dict(on=False, toggle=True)))
            elif action in ('init', 'rest', 'shutdown'):
                result.append(('robot.'+action, {}))
            elif action in ('sit_toggle', 'ground_pick', 'kick_left', 'kick_right', 'roulade'):
                button = next(key for key, skill in BINDINGS.items() if skill == action)
                result.append(('robot.do', dict(skill=profile['bindings'][button])))
            elif action == 'chirp':
                result.append(('robot.sound', dict(tag='chirp')))
            else:
                raise ValueError('Unknown pad action')
        return result
    if kind != 'pad_input':
        raise ValueError('Unknown pad request')
    velocity = payload['velocity']
    if not isinstance(velocity, dict) or set(velocity) != set(LIMITS):
        raise ValueError('Invalid pad velocity')
    move = {k: number(velocity[k], -v, v) for k, v in LIMITS.items()}
    result = [('robot.move', move)]
    cfg = profile['parameters']
    head, pose = payload.get('head'), payload.get('pose')
    if head is not None:
        expected = ('neck_pitch', 'head_pitch', 'head_yaw', 'head_roll')
        if not isinstance(head, dict) or set(head) != set(expected):
            raise ValueError('Invalid head command')
        result.append(('robot.head', {k: number(head[k], -cfg['pad_head'][k+'_max'], cfg['pad_head'][k+'_max']) for k in expected}))
    if pose is not None:
        if not isinstance(pose, dict) or set(pose) != {'z', 'roll', 'pitch', 'active'} or type(pose['active']) is not bool:
            raise ValueError('Invalid body command')
        body = cfg['pad_body']
        result.append(('robot.pose', dict(z=number(pose['z'], body['z_min'], body['z_max']),
                      roll=number(pose['roll'], -body['roll_max'], body['roll_max']),
                      pitch=number(pose['pitch'], -body['pitch_max'], body['pitch_max']), active=pose['active'])))
    # Both triggers open the mouth; RT holds the synthesized crow.
    result.append(('robot.mouth', dict(open=number(payload['mouth'], 0, 1))))
    if type(payload['wheee']) is not bool:
        raise ValueError('Invalid trigger hold')
    result.append(('robot.sound', dict(tag='wheee', hold=payload['wheee'])))
    if type(payload['crow']) is not bool:
        raise ValueError('Invalid crow hold')
    result.append(('robot.sound', dict(tag='chirp', hold=payload['crow'])))
    return result
