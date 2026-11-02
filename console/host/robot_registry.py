"""Local commissioning dossiers. No credentials, SSH execution or runtime mutation."""
import copy
import fcntl
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile
import uuid

from aiohttp import web

STATUSES = {'pending', 'passed', 'failed', 'deferred', 'not_applicable', 'accepted'}
FIELDS = {'robot_id', 'name', 'hostname', 'address', 'ssh_user', 'ssh_port',
          'state_port', 'control_port', 'robot_public_key', 'notes'}


class Conflict(ValueError):
    pass


class RobotRegistry:
    def __init__(self, path):
        self.path = Path(path)
        self.data = json.loads(self.path.read_text()) if self.path.exists() else {
            'version': 1, 'revision': 0, 'default_id': None, 'robots': [], 'archives': []}
        if self.data.get('version') != 1:
            raise ValueError('Unsupported robot registry version')

    def public(self):
        if self.path.exists():
            self.data = json.loads(self.path.read_text())
        return {k: copy.deepcopy(self.data[k]) for k in ('revision', 'default_id', 'robots')}

    def change(self, body, reserved=(), active=()):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.with_suffix('.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.public()
            return self._change(body, reserved, active)

    def _change(self, body, reserved=(), active=()):
        if not isinstance(body, dict) or type(body.get('revision')) is not int:
            raise ValueError('A registry revision is required')
        if body['revision'] != self.data['revision']:
            raise Conflict('The registry changed in another window. Reload before saving.')
        data = copy.deepcopy(self.data)
        action = body.get('action')
        row = next((r for r in data['robots'] if r['id'] == body.get('id')), None)
        now = datetime.now(timezone.utc).isoformat()
        if action == 'save':
            if body.get('id') and row is None:
                raise ValueError('Robot dossier not found')
            values = body.get('robot')
            if not isinstance(values, dict) or set(values) != FIELDS:
                raise ValueError('Invalid dossier fields; credentials are not accepted')
            values = dict(values)
            for key in FIELDS - {'ssh_port', 'state_port', 'control_port'}:
                if not isinstance(values[key], str) or len(values[key]) > (4000 if key == 'notes' else 200):
                    raise ValueError('Invalid field: ' + key)
                values[key] = values[key].strip()
                if '\x00' in values[key]:
                    raise ValueError('Invalid field: ' + key)
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', values['robot_id']):
                raise ValueError('robot_id requires 1–64 letters, digits, underscores or hyphens')
            if values['address'] and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', values['address']):
                raise ValueError('Use an IPv4 address or hostname without a URL or port')
            for key in ('ssh_port', 'state_port', 'control_port'):
                if type(values[key]) is not int or not 1 <= values[key] <= 65535:
                    raise ValueError('Ports must be integers from 1 to 65535')
            if values['state_port'] == values['control_port']:
                raise ValueError('State and control ports must differ')
            key = values['robot_public_key']
            if key:
                from zmq.utils import z85
                try:
                    valid = len(key) == 40 and len(z85.decode(key)) == 32
                except (ValueError, KeyError, UnicodeError):
                    valid = False
                if not valid:
                    raise ValueError('Invalid CURVE public key')
            if any(r['robot_id'] == values['robot_id'] and r is not row for r in data['robots']) or values['robot_id'] in reserved:
                raise Conflict('robot_id already exists or belongs to a loaded connection')
            if row and row['robot_id'] in active:
                raise Conflict('This connection is loaded. Live connection editing is not available yet.')
            if row is None:
                row = dict(id=uuid.uuid4().hex, created_at=now, results={})
                data['robots'].append(row)
            row.update(values, protocol='openchicken-runtime-v1', updated_at=now)
        elif action == 'default':
            if body.get('id') is not None and row is None:
                raise ValueError('Robot dossier not found')
            data['default_id'] = body.get('id')
        elif action == 'delete':
            if row is None:
                raise ValueError('Robot dossier not found')
            if row['robot_id'] in active:
                raise Conflict('This connection is loaded. Disconnect it before removing its dossier.')
            data['robots'].remove(row)
            data['archives'].append(dict(row, deleted_at=now))
            if data['default_id'] == row['id']:
                data['default_id'] = None
        elif action == 'result':
            if row is None:
                raise ValueError('Create a dossier before recording results')
            step, result = body.get('step', ''), body.get('result')
            if not re.fullmatch(r'N(?:0[1-9]|10)\.[0-2]', step):
                raise ValueError('Unknown test item')
            if not isinstance(result, dict) or set(result) != {'status', 'notes'}:
                raise ValueError('Invalid result fields')
            if result['status'] not in STATUSES or not isinstance(result['notes'], str) or len(result['notes']) > 8000:
                raise ValueError('Invalid test result')
            if result['status'] != 'pending' and not result['notes'].strip():
                raise ValueError('Record the observation, evidence or reason before saving')
            row['results'][step] = dict(result, updated_at=now, source='operator')
            row['updated_at'] = now
        else:
            raise ValueError('Unknown registry action')
        data['revision'] += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.robots-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(data, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        self.data = data
        return self.public()


def install_registry(app, console, path):
    registry = RobotRegistry(path)
    console.registry = registry

    async def get_registry(request):
        return web.json_response(registry.public(), headers={'Cache-Control': 'no-store'})

    async def change_registry(request):
        if request.headers.get('Origin') not in (f'http://{request.host}', f'https://{request.host}'):
            raise web.HTTPForbidden(text='Same-origin requests only')
        if request.content_type != 'application/json':
            raise web.HTTPUnsupportedMediaType()
        try:
            body = await request.json()
            return web.json_response(registry.change(body,
                reserved=set(console.connections) | set(console.snapshots), active=set(console.connections)))
        except Conflict as exc:
            return web.json_response({'error': str(exc)}, status=409)
        except (ValueError, TypeError) as exc:
            return web.json_response({'error': str(exc)}, status=400)

    app.router.add_get('/api/robots', get_registry)
    app.router.add_post('/api/robots', change_registry)
