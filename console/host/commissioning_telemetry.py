"""Explicit local subscriptions to the existing monitor-only Python publishers."""
import asyncio
import json
import re
import tempfile
import time
from pathlib import Path

import zmq
from zmq.utils import z85
from aiohttp import web

from host.ssh_checks import private_json
from protocol.readonly import (PROTOCOL, JOINT_PROTOCOL, SENSOR_PROTOCOL, POWER_PROTOCOL,
                               FUSION_PROTOCOL, OBSERVATION_PROTOCOL, load_config)

PROTOCOLS = (PROTOCOL, JOINT_PROTOCOL, SENSOR_PROTOCOL, POWER_PROTOCOL, FUSION_PROTOCOL, OBSERVATION_PROTOCOL)
FIELDS = {'role', 'protocol', 'robot_id', 'hostname', 'endpoint', 'public_key', 'secret_key', 'peer_public_key', 'calibration_id'}


class CommissioningTelemetry:
    def __init__(self, console, connection):
        self.console = console
        self.connection = connection
        self.registry = console.registry
        self.root = self.registry.path.parent/'commissioning'/'telemetry'
        self.owned = {}

    def profile(self, identity):
        row = next((r for r in self.registry.public()['robots'] if r['id'] == identity), None)
        if row is None:
            raise ValueError('Select a saved robot dossier')
        return row

    def path(self, identity):
        if not isinstance(identity, str) or not re.fullmatch('[0-9a-f]{32}', identity):
            raise ValueError('Invalid profile ID')
        return self.root/identity/'host.json'

    @staticmethod
    def endpoint(row):
        if not row['address'] or not row['hostname']:
            raise ValueError('Fill the actual IP and measured hostname in the dossier first')
        return f"tcp://{row['address']}:{row['state_port']}"

    def check_identity(self, config, row):
        expected = dict(role='host', robot_id=row['robot_id'], hostname=row['hostname'], endpoint=self.endpoint(row))
        if any(config.get(k) != v for k, v in expected.items()):
            raise ValueError('Saved configuration differs from the dossier; prepare or import the matching configuration again')
        if config.get('protocol') not in PROTOCOLS or set(config)-FIELDS:
            raise ValueError('Only monitor-only protocols are accepted; runtime and control endpoints are forbidden')

    def read(self, identity):
        path = self.path(identity)
        return json.loads(path.read_text()) if path.exists() else None

    def validate(self, config):
        # Reuse the exact wire configuration validator; keep even temporary secrets private.
        with tempfile.TemporaryDirectory(prefix='openchicken-config-') as tmp:
            path = Path(tmp)/'host.json'
            private_json(path, config)
            load_config(path, 'host')
        try:
            if len(z85.decode(config['peer_public_key'])) != 32:
                raise ValueError()
        except (ValueError, KeyError, UnicodeError):
            raise ValueError('Invalid robot CURVE public key')

    def prepare(self, identity, body):
        row = self.profile(identity)
        if row['robot_id'] in self.console.connections or identity in self.owned:
            raise ValueError('Disconnect telemetry before changing its configuration')
        old = self.read(identity)
        if 'config' in body:
            config = body['config']
            if not isinstance(config, dict):
                raise ValueError('Expected a host JSON configuration')
            self.check_identity(config, row)
            self.validate(config)
        else:
            protocol = body.get('protocol', PROTOCOL)
            if protocol not in PROTOCOLS:
                raise ValueError('Unsupported monitor-only protocol')
            public, secret = (old['public_key'], old['secret_key']) if old else tuple(k.decode() for k in zmq.curve_keypair())
            peer = body.get('peer_public_key', '')
            if not isinstance(peer, str):
                raise ValueError('Invalid robot public key')
            config = dict(role='host', protocol=protocol, robot_id=row['robot_id'], hostname=row['hostname'],
                          endpoint=self.endpoint(row), public_key=public, secret_key=secret, peer_public_key=peer.strip())
            if protocol in (FUSION_PROTOCOL, OBSERVATION_PROTOCOL):
                calibration = body.get('calibration_id', '')
                if not isinstance(calibration, str) or not re.fullmatch('[0-9a-f]{64}', calibration):
                    raise ValueError('Enter this robot calibration SHA-256; do not copy another robot calibration')
                config['calibration_id'] = calibration
            self.check_identity(config, row)
            if config['peer_public_key']:
                self.validate(config)
        private_json(self.path(identity), config)
        return self.status(identity)

    def status(self, identity):
        row = self.profile(identity)
        config = self.read(identity)
        matches = False
        if config:
            try:
                self.check_identity(config, row)
                matches = True
            except ValueError:
                pass
        owned = self.owned.get(identity)
        conn = owned[0] if owned else None
        age = max(0, time.monotonic()-conn.received_at) if conn and conn.received_at else None
        state = 'disconnected'
        if conn:
            state = 'receiving' if age is not None and age < conn.timeout else 'stale' if age is not None else 'waiting'
            if owned[1].done():
                state = 'failed'
        return dict(config={k:v for k,v in config.items() if k != 'secret_key'} if config else None,
                    matches=matches, ready=bool(matches and config.get('peer_public_key')), status=state,
                    shared=True, age_seconds=round(age, 2) if age is not None else None,
                    seq=conn.last_seq if conn else 0, external_connection=row['robot_id'] in self.console.connections and not conn)

    def connect(self, identity):
        row = self.profile(identity)
        if identity in self.owned:
            return self.status(identity)
        if row['robot_id'] in self.console.connections or row['robot_id'] in self.console.snapshots:
            raise ValueError('This robot ID is already loaded; this page cannot replace that connection')
        config = self.read(identity)
        if not config:
            raise ValueError('Prepare the host configuration first')
        self.check_identity(config, row)
        self.validate(config)
        conn = self.connection(self.console.context, row['robot_id'], config)
        if conn.dealer is not None or conn.runtime:
            conn.close()
            raise ValueError('Control channels are forbidden in commissioning telemetry')
        self.console.connections[row['robot_id']] = conn
        task = asyncio.create_task(self.console.receive(conn))
        self.owned[identity] = (conn, task)
        self.console.event(row['robot_id'], '只读 ZMQ 订阅启动 · 等待有效数据 · 无运控通道')
        return self.status(identity)

    async def disconnect(self, identity):
        row = self.profile(identity)
        if self.console.recorder.file and self.console.recorder.robot_id == row['robot_id']:
            raise ValueError('Stop recording in the monitor before disconnecting shared telemetry')
        await self.remove(identity)
        return self.status(identity)

    async def remove(self, identity):
        owned = self.owned.pop(identity, None)
        if not owned:
            return
        conn, task = owned
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        if self.console.connections.get(conn.robot_id) is conn:
            del self.console.connections[conn.robot_id]
        conn.close()
        self.console.event(conn.robot_id, '只读 ZMQ 订阅已断开 · 机器人端采集进程未停止')

    async def close(self, app):
        for identity in list(self.owned):
            await self.remove(identity)


def install_commissioning_telemetry(app, console, connection):
    manager = CommissioningTelemetry(console, connection)
    # Registered before Console.close so subscribers close before context termination.
    app.on_cleanup.append(manager.close)

    async def handler(request):
        try:
            if request.method == 'GET':
                result = manager.status(request.match_info['profile'])
            else:
                if request.headers.get('Origin') not in (f'http://{request.host}', f'https://{request.host}'):
                    raise web.HTTPForbidden(text='Same-origin requests only')
                if request.content_type != 'application/json':
                    raise web.HTTPUnsupportedMediaType()
                body = await request.json()
                if not isinstance(body, dict):
                    raise ValueError('Expected a JSON object')
                identity, action = body.get('profile_id'), request.match_info['action']
                if action == 'prepare':
                    result = manager.prepare(identity, body)
                elif action == 'connect':
                    result = manager.connect(identity)
                elif action == 'disconnect':
                    result = await manager.disconnect(identity)
                else:
                    raise ValueError('Unknown telemetry operation')
            return web.json_response(result, headers={'Cache-Control':'no-store'})
        except ValueError as error:
            # Validation messages describe fields, never submitted key values.
            message = 'Invalid configuration JSON' if isinstance(error, json.JSONDecodeError) else str(error)
            return web.json_response({'error':message}, status=400)
        except (TypeError, OSError, KeyError, zmq.ZMQError):
            return web.json_response({'error':'Unable to load read-only configuration; check host settings and CURVE key format.'}, status=400)

    app.router.add_get('/api/commissioning/telemetry/status/{profile}', handler)
    app.router.add_post('/api/commissioning/telemetry/{action}', handler)
    return manager
