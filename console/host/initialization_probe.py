"""Read-only first-boot inventory, also sent verbatim to the robot over SSH.

Never open hardware devices, load models, mutate services or return credentials.
"""
import importlib.util
import json
import os
import platform
from pathlib import Path
import pwd
import socket
import stat
import subprocess
import sys
import time


UNITS = ('robotd', 'tofd', 'openchicken-agent', 'configd', 'padd', 'bluetooth',
         'openchicken-speaker-init', 'aic3104-init')


def command(args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=3)
        return dict(exit_code=p.returncode, stdout=p.stdout[:6000], stderr=p.stderr[:1000])
    except (OSError, subprocess.TimeoutExpired) as error:
        return dict(error=str(error))


def metadata(path):
    try:
        p = Path(path); s = p.stat()
        return dict(path=str(p), exists=True, target=str(p.resolve()),
                    mode=oct(stat.S_IMODE(s.st_mode)), uid=s.st_uid, gid=s.st_gid,
                    readable=os.access(p, os.R_OK), writable=os.access(p, os.W_OK),
                    executable=os.access(p, os.X_OK), socket=stat.S_ISSOCK(s.st_mode))
    except FileNotFoundError:
        return dict(path=str(path), exists=False)
    except OSError as error:
        return dict(path=str(path), exists=None, error=str(error))


def files_state(files):
    if any(f.get('exists') is False for f in files): return 'attention'
    if any(f.get('exists') is not True for f in files): return 'unknown'
    return 'observed'


def inventory(directory, pattern):
    try: return [str(p) for p in sorted(Path(directory).glob(pattern))[:40]]
    except OSError: return []


STAGES = {
    'N01': {'deployment', 'identity', 'system'},
    'N02': {'interfaces'},
    'N04': {'audio', 'openchicken-speaker-init', 'aic3104-init', 'pin31', 'optional'},
    'N05': {'robotd', 'tofd', 'openchicken-agent', 'configd', 'padd', 'bluetooth', 'sockets', 'adapter', 'input', 'pad_config'},
    'N06': {'runtime'},
}


def collect(context, stage=None):
    if stage is not None and stage not in STAGES: raise ValueError('Unknown inventory stage')
    wanted = lambda identity: stage is None or identity in STAGES[stage]
    root = Path(context['deploy_root'])
    sections = []
    def add(identity, state, evidence):
        sections.append(dict(id=identity, state=state, evidence=evidence))

    if wanted('deployment'):
        binaries = [metadata(root/'current/bin'/name) for name in ('robotctl', 'robotd', 'tofd', 'configd', 'padd')]
        base = [metadata(context['robot_config']), metadata(root/'current/console/agent/runtime_agent.py')]
        add('deployment', files_state(binaries + base), dict(files=binaries + base, current=metadata(root/'current')))

    if wanted('interfaces'):
        devices = [metadata(p) for p in ('/dev/openchicken-dxl', '/dev/i2c-openchicken')]
        add('interfaces', files_state(devices), dict(devices=devices, login_groups=command(['id']),
            aliases=metadata('/etc/udev/rules.d/99-openchicken-hat.rules'),
            owners=command(['fuser', '-v', '/dev/openchicken-dxl', '/dev/i2c-openchicken'])))

    services = {}
    for name in UNITS:
        if not wanted(name): continue
        raw = command(['systemctl', 'show', name+'.service',
                       '--property=LoadState,ActiveState,SubState,UnitFileState,User,Group,SupplementaryGroups,ExecStart,FragmentPath'])
        values = dict(line.split('=', 1) for line in raw.get('stdout', '').splitlines() if '=' in line)
        state = 'unknown' if raw.get('error') or not values.get('LoadState') else (
            'attention' if values['LoadState'] != 'loaded' or values.get('ActiveState') not in ('active', 'activating') else 'observed')
        services[name] = values
        add(name, state, dict(service=values, query_error=raw.get('error') or raw.get('stderr') or None))

    for item in sections:
        if item['id'] in ('openchicken-speaker-init', 'aic3104-init'):
            other = 'aic3104-init' if item['id'] == 'openchicken-speaker-init' else 'openchicken-speaker-init'
            if services[item['id']].get('LoadState') == 'not-found' and services[other].get('ActiveState') == 'active':
                item['state'] = 'manual'
                item['evidence']['alternative_active'] = other

    if wanted('sockets'):
        sockets = [dict(metadata(p), required=p in (context['robot_socket'], context['config_socket'], '/run/tofd/tofd.sock')) for p in dict.fromkeys((context['robot_socket'], context['config_socket'], '/run/tofd/tofd.sock', '/run/configd.sock', '/run/configd/configd.sock'))]
        # Both configd candidates are evidence, not two mandatory sockets.
        required = [s for s in sockets if s['path'] in (context['robot_socket'], context['config_socket'], '/run/tofd/tofd.sock')]
        state = files_state(required)
        if any(s.get('exists') and not s.get('socket') for s in required): state = 'attention'
        add('sockets', state, sockets)

    if wanted('adapter'):
        show = command(['bluetoothctl', 'show'])
        powered = any(line.strip() == 'Powered: yes' for line in show.get('stdout', '').splitlines())
        add('adapter', 'observed' if powered else 'unknown' if show.get('error') else 'attention', show)
    if wanted('input'):
        # List device permissions only; never read event streams or grab a controller.
        add('input', 'manual', dict(events=[metadata(p) for p in inventory('/dev/input', 'event*')],
            padd_user=services.get('padd', {}).get('User'),
            supplementary_groups=services.get('padd', {}).get('SupplementaryGroups'),
            note='Access flags describe this SSH user; verify access for the actual padd service user.'))

    if wanted('pad_config'):
        try:
            try: import tomllib
            except ImportError: import tomli as tomllib
            config = tomllib.loads(Path(context['pad_config'] or context['robot_config']).read_text())
            netpad = config.get('netpad', {}).get('enabled')
            add('pad_config', 'observed' if netpad is False else 'attention' if netpad is True else 'unknown',
                dict(path=context['pad_config'] or context['robot_config'], netpad_enabled=netpad,
                     pad_axes=config.get('pad_axes', {}), pad_head=config.get('pad_head', {}), pad_body=config.get('pad_body', {}),
                     note='Absent fields use native defaults; verify the deployed version before adding overrides.'))
        except (OSError, ValueError, ImportError) as error:
            add('pad_config', 'unknown', dict(error=str(error)))

    if wanted('audio'):
        add('audio', 'manual', dict(playback=command(['aplay', '-l']), capture=command(['arecord', '-l']),
            note='Enumeration only; mixer, playback, recording and reboot persistence still require N02/N04.'))
    if wanted('runtime'):
        libraries = inventory(root/'deps', '**/libonnxruntime.so*')
        models = inventory(root/'policies', '**/*.onnx')
        add('runtime', 'manual', dict(runtime_libraries=libraries, policy_files=models,
            ssh_python=sys.executable, ssh_python_zmq_available=importlib.util.find_spec('zmq') is not None,
            note='SSH Python may differ from the agent launcher PYTHONPATH/interpreter. Missing zmq here is not proof that the running agent lacks it. File presence does not verify loading or inference.'))

    if wanted('identity'):
        agent_path = root/'config/agent.private.json'
        try:
            config = json.loads(agent_path.read_text())
            # Only export public identity fields and presence flags; never serialize key values.
            public = {key: config.get(key) for key in ('robot_id', 'hostname', 'role', 'protocol', 'endpoint', 'control_endpoint', 'robot_socket', 'head_socket')}
            public['keys_present'] = {key: isinstance(config.get(key), str) and len(config[key]) == 40
                                      for key in ('public_key', 'secret_key', 'peer_public_key')}
            matches = public['robot_id'] == context['robot_id'] and public['hostname'] == socket.gethostname()
            add('identity', 'observed' if matches and all(public['keys_present'].values()) else 'attention',
                dict(path=str(agent_path), identity=public, mode=metadata(agent_path).get('mode'),
                     note='Key presence is not proof of matching host keys or authenticated telemetry.'))
        except (OSError, ValueError, AttributeError) as error:
            add('identity', 'unknown', dict(path=str(agent_path), error=str(error)))

    if wanted('pin31'):
        add('pin31', 'manual', dict(launcher=metadata('/usr/local/lib/openchicken/open_runtime_pin31.py'),
            note='Review launcher GPIO input, user and agent configuration paths before installation. No GPIO requested by this check.'))
    for identity in ('calibration', 'boot', 'optional'):
        if wanted(identity): add(identity, 'manual', {})
    if stage == 'N01':
        add('system', 'observed', dict(hostname=socket.gethostname(), kernel=platform.release(), architecture=platform.machine()))
    return dict(check='stage_'+stage if stage else 'initialization', hostname=socket.gethostname(), user=pwd.getpwuid(os.getuid()).pw_name,
                read_only=True, remote_time=time.time(), sections=sections)
