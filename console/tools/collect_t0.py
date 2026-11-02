"""T0 stdout-only inventory. Does not open devices, start services or change settings."""
from datetime import datetime, timezone
import grp
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess


def read(path):
    try:
        return Path(path).read_text().strip()
    except (OSError, UnicodeError):
        return None


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=10)
        return dict(exit_code=result.returncode, stdout=result.stdout, stderr=result.stderr)
    except (OSError, subprocess.TimeoutExpired) as error:
        return dict(error=str(error))


def main():
    paths = ['/boot/armbianEnv.txt', '/etc/armbian-release', '/etc/os-release',
             '/proc/sys/kernel/random/boot_id', '/proc/asound/cards', '/proc/asound/pcm',
             '/etc/udev/rules.d/99-openchicken-hat.rules',
             '/etc/systemd/system/openchicken-speaker-init.service']
    devices = {}
    for path in ('/dev/openchicken-dxl', '/dev/i2c-openchicken'):
        try:
            p = Path(path)
            stat = p.stat()
            devices[path] = dict(target=str(p.resolve()), mode=oct(stat.st_mode & 0o777),
                                 uid=stat.st_uid, gid=stat.st_gid,
                                 accessible=os.access(path, os.R_OK | os.W_OK))
        except OSError as error:
            devices[path] = dict(error=str(error))
    owners, inaccessible = [], 0
    for process in Path('/proc').glob('[0-9]*'):
        try:
            for fd in (process/'fd').iterdir():
                try:
                    target = os.readlink(fd)
                except OSError:
                    continue
                if target == '/dev/ttyS5' or target.startswith(('/dev/i2c-', '/dev/snd/pcm')):
                    owners.append(dict(pid=int(process.name), process=read(process/'comm'), device=target))
        except (PermissionError, FileNotFoundError):
            inaccessible += 1
    zmq_info = dict(available=False)
    if importlib.util.find_spec('zmq'):
        try:
            import zmq
            zmq_info = dict(available=True, python_version=zmq.__version__, library_version=zmq.zmq_version(),
                            curve=zmq.has('curve'))
        except ImportError as error:
            zmq_info['error'] = str(error)
    report = dict(utc=datetime.now(timezone.utc).isoformat(), hostname=platform.node(),
                  architecture=platform.machine(), kernel=platform.release(), python=platform.python_version(),
                  uid=os.getuid(), groups=[grp.getgrgid(g).gr_name for g in os.getgroups()],
                  files={p:read(p) for p in paths}, devices=devices, device_owners=owners,
                  inaccessible_processes=inaccessible, zmq=zmq_info,
                  filesystem=dict(zip(('total','used','free'), shutil.disk_usage('/'))),
                  commands={
                      'root_mount':command(['findmnt','-no','SOURCE,FSTYPE,OPTIONS','/']),
                      'services':command(['systemctl','show','robotd.service','padd.service','netpadd.service',
                                          'openchicken-speaker-init.service','--property=Id,ActiveState,SubState,FragmentPath,DropInPaths']),
                      'failed_units':command(['systemctl','--failed','--no-pager','--plain']),
                      'packages':command(['dpkg-query','-W','python3','python3-zmq','libzmq5','libc6','alsa-utils']),
                      'listeners':command(['ss','-ltn']),
                  }, actuator_access=False, configuration_changes=False)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
