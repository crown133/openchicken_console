"""Prepare a versioned T1 test bundle and paired CURVE keys, entirely in the workspace."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import zmq
from protocol.readonly import PROTOCOL


def private_json(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(data, stream, indent=2)
        stream.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--address', default='192.168.3.181')
    parser.add_argument('--hostname', default='radxa-zero3')
    parser.add_argument('--robot-id', default='openchicken1')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    output = args.output or ROOT.parent/'artifacts'/f'console-t1-{stamp}'
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    bundle = output/'system-agent'
    bundle.mkdir()
    files = ['agent/__init__.py', 'agent/system_probe.py', 'agent/system_agent.py',
             'protocol/__init__.py', 'protocol/model.py', 'protocol/readonly.py']
    manifest = []
    for name in files:
        data = (ROOT/name).read_bytes()
        path = bundle/name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)
        manifest.append(dict(path=name, size=len(data), sha256=hashlib.sha256(data).hexdigest()))
    public, secret = zmq.curve_keypair()
    host_public, host_secret = zmq.curve_keypair()
    common = dict(protocol=PROTOCOL, robot_id=args.robot_id, hostname=args.hostname)
    private_json(bundle/'agent.private.json', dict(common, role='agent', endpoint='tcp://0.0.0.0:5557',
                 public_key=public.decode(), secret_key=secret.decode(), peer_public_key=host_public.decode()))
    private_json(output/'host.private.json', dict(common, role='host', endpoint=f'tcp://{args.address}:5557',
                 public_key=host_public.decode(), secret_key=host_secret.decode(), peer_public_key=public.decode()))
    (bundle/'SHA256SUMS').write_text(''.join(f'{r["sha256"]}  {r["path"]}\n' for r in manifest))
    archive = output/'system-agent.tar.gz'
    with tarfile.open(archive, 'w:gz') as stream:
        stream.add(bundle, arcname='system-agent')
    os.chmod(archive, 0o600)
    data = archive.read_bytes()
    report = dict(protocol=PROTOCOL, robot_id=args.robot_id, prepared_utc=stamp,
                  archive=archive.name, size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                  source_files=manifest, robot_public_key=public.decode(), host_public_key=host_public.decode(),
                  requires='Python 3.10+ and pyzmq with CURVE; check in T0, no auto-install',
                  status='prepared, not deployed; no physical tests',
                  no_actuator_access=True, no_command_channel=True)
    (output/'manifest.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(dict(directory=str(output), archive=archive.name, size=len(data), sha256=report['sha256']), indent=2))


if __name__ == '__main__':
    main()
