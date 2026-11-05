"""Translate the supported local-file manifest contract to native robotctl arguments."""
import math
import re

SLOTS = {'walk', 'stand', 'sitstand', 'ground_pick', 'kick_left', 'kick_right', 'roulade'}
JOINTS = [f'{side}_{joint}' for side in ('left',) for joint in ('hip_yaw','hip_roll','hip_pitch','knee','ankle')] + ['neck_pitch','head_pitch','head_yaw','head_roll'] + [f'right_{joint}' for joint in ('hip_yaw','hip_roll','hip_pitch','knee','ankle')]
TRACKING_SCHEMA = 'microduck_supertracking_embedded_v1'


def name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', value):
        raise ValueError('Use a lowercase skill name, digits and underscores')
    return value


def number(value, minimum, maximum):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f'Expected a finite number in [{minimum}, {maximum}]')
    return value


def twist(value):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError('Command requires three velocity values')
    return [number(v, -limit, limit) for v, limit in zip(value, (.4, .3, 1.0))]


def bindings(value):
    if not isinstance(value, dict) or set(value) - {'keyboard', 'browser_gamepad'}:
        raise ValueError('Only keyboard and browser_gamepad bindings are supported here')
    result = {'keyboard': [], 'browser_gamepad': []}
    for item in value.get('keyboard', []):
        if set(item) != {'code', 'event'} or item['event'] != 'press' or item['code'] not in ('Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'):
            raise ValueError('Custom keyboard bindings use Digit6–Digit0, event=press')
        result['keyboard'].append(item)
    for item in value.get('browser_gamepad', []):
        if set(item) != {'mapping', 'buttons', 'event'} or item['mapping'] != 'standard' or item['event'] != 'press' or item['buttons'] not in (['LB', 'RB'], ['LB', 'X'], ['LB', 'Y']):
            raise ValueError('Custom browser chords: LB+RB, LB+X or LB+Y; protected native controls cannot be replaced')
        result['browser_gamepad'].append(item)
    for items in result.values():
        if len({str(i) for i in items}) != len(items):
            raise ValueError('Duplicate binding')
    return result


def manifest(value):
    if not isinstance(value, dict):
        raise ValueError('Expected a JSON manifest object')
    tracking = value.get('schema') == TRACKING_SCHEMA
    if tracking:
        inputs, outputs = value.get('inputs', {}), value.get('outputs', {})
        if set(inputs) != {'history', 'time_step'} or set(outputs) != {'action'}:
            raise ValueError('Embedded tracking requires history, time_step and action tensors')
        for tensor, dimensions, dtype in ((inputs['history'], [10,48], 'float32'),
                                           (inputs['time_step'], [1], 'int64'),
                                           (outputs['action'], [14], 'float32')):
            shape = tensor.get('shape', [])
            if shape not in ([1] + dimensions, ['batch'] + dimensions) or tensor.get('dtype') != dtype:
                raise ValueError('Embedded tracking requires history[1,10,48], time_step int64[1,1] and action[1,14]')
        if value.get('control_frequency_hz') != 50 or value.get('reference_storage') != 'embedded':
            raise ValueError('Embedded tracking requires embedded reference data at 50 Hz')
        if value.get('joint_names', JOINTS) != JOINTS:
            raise ValueError('Action order does not match the runtime contract')
    elif value.get('schema_version') != 2 or value.get('model_api') != 1:
        raise ValueError('Expected schema_version=2 and model_api=1')
    allowed = {'schema_version', 'model_api', 'name', 'description', 'file', 'obs_len', 'action_len', 'robot', 'kind', 'duration_s', 'chain', 'entry_pose', 'unwind_s', 'command', 'openchicken', 'slot', 'ramp_s', 'mode', 'training', 'eval'}
    if not tracking and set(value) - allowed:
        raise ValueError('Unsupported manifest fields: ' + ', '.join(sorted(set(value) - allowed)))
    if not tracking and (value.get('obs_len') != 61 or value.get('action_len') != 14):
        raise ValueError('This runtime requires 61 observations and 14 actions')
    robot = value.get('robot', {})
    if not tracking and robot != {'model': 'microduck', 'servos': 'xl330', 'control_hz': 50}:
        raise ValueError('Expected microduck / xl330 / 50 Hz')
    kind = value.get('kind', 'episodic' if tracking else None)
    if kind not in ('episodic', 'perpetual', 'scripted'):
        raise ValueError('Native model kind must be episodic, perpetual or scripted')
    if value.get('chain', False) is not False or value.get('entry_pose', 'standing') != 'standing':
        raise ValueError('Local robotctl cannot express chain=true or another entry pose')
    extra = value.get('openchicken', {})
    if not isinstance(extra, dict) or set(extra) - {'package_version', 'runtime_profile', 'label', 'observations', 'actions', 'execution', 'runtime_tuning', 'bindings'}:
        raise ValueError('Unsupported openchicken metadata')
    profile = TRACKING_SCHEMA if tracking else 'microduck_alpha_61x14_v1'
    if extra.get('runtime_profile', profile) != profile or value.get('mode', 'walk') != 'walk':
        raise ValueError(f'This console contract requires {profile} in walk mode')
    actions = extra.get('actions')
    if actions is not None and (not isinstance(actions, dict) or actions.get('shape') != [1,14] or actions.get('joint_names') != JOINTS or actions.get('target_unit') != 'rad' or actions.get('interpretation') != 'scaled_offset_from_home'):
        raise ValueError('Action order, units or shape do not match the runtime contract')
    observations = extra.get('observations')
    layout = [('body.angular_velocity',3,'rad/s'),('body.projected_gravity',3,'unit_vector'),('joints.position_minus_home',14,'rad'),('joints.velocity',14,'rad/s'),('policy.previous_raw_action',14,None),('command.microduck13',13,None)]
    if observations is not None:
        if tracking:
            raise ValueError('Declare tracking tensors in inputs/outputs, not the native observations metadata')
        if not isinstance(observations,dict) or observations.get('shape') != [1,61] or observations.get('dtype') != 'float32' or observations.get('normalization') != 'embedded_in_onnx':
            raise ValueError('Observation shape, type or normalization does not match the runtime contract')
        declared = observations.get('layout', [])
        if not isinstance(declared,list) or any(not isinstance(item,dict) for item in declared) or [(item.get('source'),item.get('size'),item.get('unit')) for item in declared] != layout:
            raise ValueError('Observation order or units do not match the runtime contract')
    execution = extra.get('execution', {})
    if not isinstance(execution, dict) or set(execution) - {'command'}:
        raise ValueError('Only execution.command is supported; gain_ratio/action_scale are not writable')
    command = value.get('command', {'encoding': 'constant', 'idle': [0, 0, 0]})
    if not isinstance(command, dict) or set(command) - {'encoding', 'idle', 'period_s', 'end_phase', 'sit', 'stand', 'slot', 'twist', 'head', 'body'}:
        raise ValueError('Unsupported command declaration')
    encoding = command.get('encoding', 'constant')
    if encoding not in ('constant', 'phase', 'posture_flag'): raise ValueError('Unknown command encoding')
    if encoding == 'phase':
        number(command.get('period_s'), .001, 3600); number(command.get('end_phase'), .001, 1)
    if encoding == 'posture_flag':
        number(command.get('sit'), -1, 1); number(command.get('stand'), -1, 1)
        if command.get('slot') not in (0, 1, 2): raise ValueError('Declare posture_flag command.slot (0, 1 or 2)')
        number(value.get('ramp_s'), .001, 3600)
    duration = value.get('duration_s')
    if duration is not None: number(duration, .001, 3600)
    if kind == 'episodic' and duration is None: raise ValueError('An episodic model requires duration_s')
    if value.get('slot') is not None: validate_slot(value, value['slot'])
    return dict(name=name(value.get('name')), duration=duration,
                command=twist(execution.get('command', [0, 0, 0])), unwind=twist(command.get('idle', [0, 0, 0])),
                unwind_s=number(value.get('unwind_s', 0), 0, 3600),
                bindings=bindings(extra.get('bindings', {})))


def validate_slot(value, slot):
    if slot not in SLOTS or value.get('slot') != slot:
        raise ValueError('The manifest must explicitly declare the selected slot')
    encoding = value.get('command', {}).get('encoding', 'constant')
    expected = 'phase' if slot == 'ground_pick' else 'posture_flag' if slot == 'sitstand' else 'constant'
    if encoding != expected: raise ValueError('Model command encoding does not match the selected slot')
    if slot in ('walk', 'stand') and value.get('kind') != 'perpetual':
        raise ValueError('Walk and stand slots require a perpetual model, not an episodic skill')
    if slot in ('kick_left', 'kick_right', 'roulade') and value.get('kind') != 'episodic':
        raise ValueError('This action slot requires an episodic model')


def validate_skill(value):
    kind = value.get('kind', 'episodic' if value.get('schema') == TRACKING_SCHEMA else None)
    if kind != 'episodic' or value.get('command', {}).get('encoding', 'constant') != 'constant':
        raise ValueError('Generic skills require an episodic, constant-command model; use its dedicated slot')


def definition_matches(version, result):
    params = version['params']
    actual = next((s for s in (result.get('skills') or {}).get('skills', []) if s.get('name') == params['name']), {})
    return actual.get('path') == version.get('remote_path') and all(actual.get(k) == params[k] for k in ('duration', 'command', 'unwind', 'unwind_s'))


def add_arguments(params, remote):
    return ['add', params['name'], remote, '--hold', str(params['duration']),
            '--command=' + ','.join(map(str, params['command'])), '--unwind', str(params['unwind_s']),
            '--unwind-command=' + ','.join(map(str, params['unwind']))]


def editable(skill):
    unsupported = [k for k in ('action_scale', 'gain_ratio') if skill.get(k) is not None]
    if skill.get('chain'): unsupported.append('chain')
    if unsupported:
        raise ValueError('Native CLI cannot preserve existing fields: ' + ', '.join(unsupported))


def assess(result, operation, params, remote=None, slot=None):
    """Disk evidence and runtime evidence deliberately have different results."""
    policies = result.get('policies', {})
    skills = (result.get('skills') or {}).get('skills', [])
    error = policies.get('change_error')
    if operation in ('add_skill', 'restore'):
        actual = next((s for s in skills if s.get('name') == params['name']), {})
        matches = actual.get('path') == remote and all(actual.get(k) == params[k] for k in ('duration', 'command', 'unwind', 'unwind_s'))
        return ('confirmed' if matches else 'unknown', 'failed' if error else 'unknown')
    if operation == 'remove_skill':
        absent = not any(s.get('name') == params['name'] for s in skills)
        return ('confirmed' if absent else 'unknown', 'failed' if error else 'unknown')
    actual = next((s for s in policies.get('slots', []) if s.get('slot') == slot), {})
    if error or actual.get('error'): return 'unknown', 'failed'
    if operation == 'reset_slot':
        ok = bool(actual) and actual.get('overridden') is False
    elif operation == 'disable_slot':
        ok = bool(actual) and actual.get('path') is None and actual.get('overridden') is True
    else:
        ok = bool(actual) and actual.get('path') == remote
    # A disabled policy system does not prove that a model loaded.
    return ('confirmed' if ok else 'unknown', 'confirmed' if ok and policies.get('enabled') is True else 'unknown')
