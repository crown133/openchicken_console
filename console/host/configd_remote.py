"""Configd-only provisioning. Inspect first; apply a matching, explicitly approved snapshot.

Called over pinned SSH by the console; never touches padd, robotd, or hardware.
"""
import difflib
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import tempfile
import time

UNIT = Path('/etc/systemd/system/configd.service')
BACKUPS = Path('/var/backups/openchicken-configd')


def run(args, **kwargs):
    p = subprocess.run(args, capture_output=True, text=True, timeout=15, **kwargs)
    if p.returncode: raise ValueError((p.stderr or p.stdout or 'Command failed')[-2000:])
    return p.stdout


def unit_state(name):
    p = subprocess.run(['systemctl', 'show', name, '--property=LoadState,ActiveState,UnitFileState,FragmentPath,DropInPaths'],
                       capture_output=True, text=True, timeout=10)
    values = dict(line.split('=', 1) for line in p.stdout.splitlines() if '=' in line)
    if not values.get('LoadState'): raise ValueError('Cannot inspect '+name+': '+p.stderr[-1000:])
    return values


def absolute(value):
    if not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in Path(value).parts or value == '/':
        raise ValueError('Invalid absolute deployment path')
    return value.rstrip('/')


def config(values):
    root = absolute(values['deploy_root']); socket = absolute(values['config_socket'])
    if not re.fullmatch(r'/run/configd/[A-Za-z0-9_-]+\.sock', socket):
        raise ValueError('Use a configd-owned socket such as /run/configd/configd.sock in Robot paths & accounts')
    user = values['allow_user']
    if not re.fullmatch(r'[a-z_][a-zA-Z0-9_-]*', user): raise ValueError('Invalid configuration user')
    account = pwd.getpwnam(user)
    if account.pw_uid == 0: raise ValueError('Choose the ordinary robot SSH account, not root')
    group = grp.getgrgid(account.pw_gid).gr_name
    if not re.fullmatch(r'[a-z_][a-zA-Z0-9_-]*', group): raise ValueError('Unsupported primary group name')
    return root, socket, user, group


def desired(values):
    root, socket, user, group = config(values)
    return ('[Unit]\nDescription=OpenChicken native configuration and Bluetooth pairing\n'
            'After=dbus.service bluetooth.service\n\n[Service]\nType=exec\nUser=root\n'
            f'Group={group}\nExecStart={root}/current/bin/configd --socket {socket} '
            f'--state-dir {root}/state/configd --allow-user {user}\n'
            'RuntimeDirectory=configd\nRestart=always\nRestartSec=2s\nNoNewPrivileges=yes\n'
            'Environment=RUST_LOG=info\n\n[Install]\nWantedBy=multi-user.target\n')


def inspect(values):
    root, socket, user, group = config(values)
    wanted = desired(values); service = unit_state('configd.service'); bluez = unit_state('bluetooth.service')
    blockers = []
    if UNIT.is_symlink(): blockers.append('Custom/symlinked configd unit requires manual review')
    if service.get('DropInPaths'): blockers.append('Existing configd drop-ins require manual review')
    if service.get('LoadState') not in ('loaded', 'not-found'): blockers.append('Resolve the existing unit load state first')
    source = service.get('FragmentPath')
    if UNIT.exists() and source != str(UNIT): blockers.append('Existing local unit differs from the loaded unit; review manually first')
    previous = Path(source).read_text() if source else ''
    if len(previous)>32768: raise ValueError('Existing unit too large')
    binary = Path(root)/'current/bin/configd'
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest() if binary.is_file() else None
    if not binary_hash or not os.access(binary, os.X_OK): blockers.append('Deploy the configd executable first')
    ctl = Path(root)/'current/bin/robotctl'
    if not ctl.is_file() or not os.access(ctl, os.X_OK): blockers.append('Deploy robotctl for verification first')
    if bluez.get('ActiveState') != 'active': blockers.append('Initialize and start system BlueZ first')
    path = Path(socket)
    socket_exists = path.exists()
    socket_valid = socket_exists and stat.S_ISSOCK(path.stat().st_mode)
    if socket_exists and not socket_valid: blockers.append('Configured socket path is occupied by a non-socket file')
    snapshot = dict(service=service, bluez=bluez, previous=previous, binary_sha256=binary_hash,
                    release=str((Path(root)/'current').resolve()), desired=wanted, socket_exists=socket_exists, socket_valid=socket_valid)
    fingerprint = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
    changed = previous != wanted
    return dict(**snapshot, fingerprint=fingerprint, blockers=blockers, can_apply=not blockers,
                ready=service.get('ActiveState')=='active' and socket_valid,
                unit_path=str(UNIT), backup_directory=str(BACKUPS), config_socket=socket, allow_user=user,
                diff=''.join(difflib.unified_diff(previous.splitlines(True), wanted.splitlines(True),
                                                fromfile=source or '(not installed)', tofile=str(UNIT))),
                actions=(['Back up existing unit', 'Install proposed unit', 'systemctl daemon-reload'] if changed else [])+
                        ['systemctl enable configd.service', 'systemctl '+('restart' if changed and service.get('ActiveState')=='active' else 'start')+' configd.service',
                         'Verify active service, socket and robotctl pad status as '+user],
                scope='configd only; no padd/robotd changes; no motion; allow-user grants native configuration rights beyond pairing')


def write_atomic(path, content, mode):
    fd, name = tempfile.mkstemp(prefix='.configd-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            os.fchmod(f.fileno(), mode); f.write(content); f.flush(); os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def verify(values):
    root, socket, user, group = config(values)
    state = unit_state('configd.service')
    if state.get('ActiveState') != 'active' or not Path(socket).is_socket(): raise ValueError('configd is not active or its socket is missing')
    account = pwd.getpwnam(user)
    kwargs = dict(user=account.pw_uid, group=account.pw_gid, extra_groups=os.getgrouplist(user, account.pw_gid)) if os.geteuid()==0 else {}
    result = json.loads(run([root+'/current/bin/robotctl', '--config-socket', socket, 'pad', 'status', '--json'],
                            env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'}, **kwargs))
    if not isinstance(result, dict) or not isinstance(result.get('pads'), list) or 'driver' not in result:
        raise ValueError('Unsupported native Bluetooth status response')
    return dict(service=state, pad_status=result, queried_as=user)


def apply(request):
    if os.geteuid()!=0: raise ValueError('Use the configured administrator root SSH account; no sudo is used')
    values=request['config']; before=inspect(values)
    if request['fingerprint']!=before['fingerprint']: raise ValueError('Robot state changed; inspect and review a new diff')
    if before['blockers']: raise ValueError('; '.join(before['blockers']))
    job=request['job_id']
    if not re.fullmatch('[0-9a-f]{32}',job): raise ValueError('Invalid operation ID')
    root, _, _, _=config(values)
    backup=BACKUPS/job
    backup.mkdir(parents=True,mode=0o700,exist_ok=False)
    record=dict(status='in_progress', before=before, backup=str(backup))
    write_atomic(backup/'record.json',json.dumps(record,indent=2),0o600)
    write_atomic(backup/'previous.service',before['previous'],0o600)
    try:
        if before['diff']:
            write_atomic(UNIT,before['desired'],0o644)
            run(['systemctl','daemon-reload'])
        run(['systemctl','enable','configd.service'])
        verb='restart' if before['diff'] and before['service'].get('ActiveState')=='active' else 'start'
        run(['systemctl',verb,'configd.service'])
        for attempt in range(2):
            try: record['verification']=verify(values);break
            except (ValueError,OSError,subprocess.TimeoutExpired) as error:
                if attempt==1: raise
                time.sleep(.3)
        record['status']='success'
        record['after']=inspect(values)
    except (OSError,ValueError,subprocess.SubprocessError) as error:
        record.update(status='failed',error=str(error))
    write_atomic(backup/'record.json',json.dumps(record,indent=2),0o600)
    return record


def dispatch(request):
    if request['action']=='inspect': return inspect(request['config'])
    if request['action']=='apply': return apply(request)
    raise ValueError('Unknown configd setup operation')
