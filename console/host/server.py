"""Local console: existing runtime IPC bridge or isolated simulators."""
import argparse
import asyncio
from collections import deque
import json
import math
from pathlib import Path
import re
import time
import uuid

from aiohttp import web, WSMsgType
import zmq
import zmq.asyncio

from agent.simulator import serve
from host.recording import Recorder
from host.robot_registry import install_registry
from host.ssh_checks import install_ssh_checks
from host.policy_management import install_management
from host.commissioning_telemetry import install_commissioning_telemetry
from protocol.runtime import PROTOCOL as RUNTIME_PROTOCOL, validate_state as validate_runtime
from protocol.control_delivery import notification
from protocol.model import MODEL_ID, MODEL_DIRECTORY, joint_manifest
from protocol.readonly import JOINT_PROTOCOL, SENSOR_PROTOCOL, POWER_PROTOCOL, FUSION_PROTOCOL, OBSERVATION_PROTOCOL, load_config, unknown_state, validate_state

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent


def snapshot_from_audit(path):
    audit = json.loads(Path(path).read_text())
    joints = []
    names = {j['id']: j for j in joint_manifest()}
    for row in audit['results']:
        f = row['fields']
        joints.append(dict(id=row['id'], name=row['joint'], label=names[row['id']]['label'],
                           position=f['present_position'] * 2 * 3.141592653589793 / 4096 - 3.141592653589793,
                           requested=None, submitted=None, register_target=f['goal_position'],
                           velocity=None, current_ma=f['present_current'], torque=bool(f['torque']),
                           error=f['hardware_error'], voltage=f['input_voltage_raw']/10,
                           temperature=f['temperature'], p=f['position_p_gain'], i=f['position_i_gain'],
                           d=f['position_d_gain'], pwm_slope=f['pwm_slope'], pwm_limit=f['pwm_limit'],
                           drive_mode=f['drive_mode'], homing_offset=f['homing_offset'],
                           valid=False, status='unknown'))
    return dict(schema_version=1, robot_id='openchicken1', boot_id='audit-snapshot', seq=0,
                sample_time=None, source='snapshot', captured_at=audit.get('recorded_at_utc'),
                enabled=False, controlled=False, seated=False, action=None, joints=joints,
                system=dict(voltage=sum(j['voltage'] for j in joints)/len(joints),
                            external_power=None, cpu_temp=None, cpu_percent=None, memory_percent=None,
                            speaker='未实时读取', microphone='未实时读取'),
                capabilities=dict(motion=False, skills=[]), model=MODEL_ID, model_verified=False,
                manifest=joint_manifest())


class Connection:
    def __init__(self, context, robot_id, readonly=None):
        self.robot_id = robot_id
        self.config = readonly
        self.runtime = bool(readonly and readonly['protocol'] == RUNTIME_PROTOCOL)
        self.readonly = readonly if not self.runtime or not readonly.get('control_endpoint') else None
        self.source = 'robot' if readonly else 'simulation'
        self.timeout = 3.0 if readonly and readonly['protocol'] not in (JOINT_PROTOCOL, SENSOR_PROTOCOL, POWER_PROTOCOL, FUSION_PROTOCOL, OBSERVATION_PROTOCOL, RUNTIME_PROTOCOL) else 0.5
        self.pub_endpoint = 'inproc://' + robot_id + '-telemetry'
        self.control_endpoint = 'inproc://' + robot_id + '-control'
        self.sub = context.socket(zmq.SUB)
        self.dealer = None if self.readonly or self.runtime else context.socket(zmq.DEALER)
        self.context = context
        self.control_users = set()
        self.reply_task = None
        for sock in (s for s in (self.sub, self.dealer) if s is not None):
            sock.setsockopt(zmq.LINGER, 0)
            sock.setsockopt(zmq.RCVHWM, 8)
            sock.setsockopt(zmq.SNDHWM, 8)
            if readonly:
                # Detect silent power loss even while TCP still reports ESTABLISHED.
                sock.setsockopt(zmq.HEARTBEAT_IVL, 1000)
                sock.setsockopt(zmq.HEARTBEAT_TIMEOUT, 3000)
        self.sub.setsockopt(zmq.SUBSCRIBE, b'')
        self.sub.setsockopt(zmq.MAXMSGSIZE, 65536)
        if readonly:
            self.pub_endpoint = readonly['endpoint']
            self.sub.curve_publickey = readonly['public_key'].encode()
            self.sub.curve_secretkey = readonly['secret_key'].encode()
            self.sub.curve_serverkey = readonly['peer_public_key'].encode()
        self.sub.connect(self.pub_endpoint)
        if self.dealer is not None:
            self.dealer.connect(self.control_endpoint)
        self.pending = {}
        self.state = unknown_state(robot_id) if readonly else None
        if self.runtime:
            self.state.update(protocol=RUNTIME_PROTOCOL, runtime_status='not_connected')
        self.received_at = 0.0
        self.last_seq = 0
        self.dropped = 0
        self.retired_boots = deque(maxlen=64)

    def open_control(self):
        if not self.runtime or self.readonly or self.dealer is not None:
            return
        self.control_endpoint = self.config['control_endpoint']
        self.dealer = self.context.socket(zmq.DEALER)
        for option, value in ((zmq.LINGER, 0), (zmq.RCVHWM, 8), (zmq.SNDHWM, 8),
                              (zmq.HEARTBEAT_IVL, 1000), (zmq.HEARTBEAT_TIMEOUT, 3000), (zmq.IMMEDIATE, 1)):
            self.dealer.setsockopt(option, value)
        self.dealer.curve_publickey = self.config['public_key'].encode()
        self.dealer.curve_secretkey = self.config['secret_key'].encode()
        self.dealer.curve_serverkey = self.config['peer_public_key'].encode()
        self.dealer.connect(self.control_endpoint)
        self.reply_task = asyncio.create_task(self.replies())

    def close_control(self):
        if not self.runtime:
            return
        if self.reply_task:
            self.reply_task.cancel()
            self.reply_task = None
        if self.dealer is not None:
            self.dealer.close()
            self.dealer = None

    def control_status(self):
        if self.readonly:
            return 'not_configured'
        if self.dealer is None:
            return 'disconnected'
        return 'connected' if self.dealer.getsockopt(zmq.EVENTS) & zmq.POLLOUT else 'connecting'

    async def notify(self, message):
        if self.readonly:
            raise ValueError('真实监控为只读，不提供控制通道')
        if self.runtime and self.state.get('control_stream_version') != 1:
            raise ValueError('Update the robot agent for notification-based control')
        self.open_control()
        try:
            await self.dealer.send_json(dict(message, reply=False), flags=zmq.NOBLOCK)
        except zmq.Again as exc:
            raise ValueError('Control transport busy; input discarded, not queued') from exc
        return dict(sent=True)  # Local transport status, never robot acceptance.

    async def request(self, message):
        if self.readonly:
            raise ValueError('真实监控为只读，不提供控制通道')
        self.open_control()
        request_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            try:
                await self.dealer.send_json(dict(message, id=request_id), flags=zmq.NOBLOCK)
            except zmq.Again as error:
                raise ValueError('Control channel is not ready; command was not queued. Retry after reconnection.') from error
            response = await asyncio.wait_for(future, 50 if message.get('type') == 'control_source' else 2.5 if self.runtime else 0.7)
            if not response.get('ok'):
                raise ValueError(response.get('error', '命令被拒绝'))
            return response['result']
        finally:
            self.pending.pop(request_id, None)

    async def replies(self):
        while True:
            reply = await self.dealer.recv_json()
            future = self.pending.get(reply.get('id'))
            if future and not future.done():
                future.set_result(reply)

    def close(self):
        for future in self.pending.values():
            if not future.done():
                future.cancel()
        self.sub.close()
        self.close_control()
        if self.dealer is not None:
            self.dealer.close()


class Console:
    def __init__(self, snapshot=None, record_root=None, demos=3, readonly=None):
        self.context = zmq.asyncio.Context()
        self.connections = {}
        self.snapshots = {}
        if snapshot:
            state = snapshot_from_audit(snapshot)
            self.snapshots[state['robot_id']] = state
        self.recorder = Recorder(record_root or WORKSPACE/'artifacts'/'console-recordings')
        self.record_queue = asyncio.Queue(maxsize=256)
        self.record_drops = 0
        self.record_accepting = False
        self.record_lock = asyncio.Lock()
        self.events = deque(maxlen=80)
        self.tasks = []
        self.demos = demos
        self.readonly = readonly
        self.clients = set()
        self.runtime_owners = {}

    def event(self, robot_id, message):
        self.events.appendleft(dict(time=time.time(), robot_id=robot_id, message=message))
        self.record('event', dict(robot_id=robot_id, message=message))

    def record(self, kind, data):
        if not self.record_accepting or not self.recorder.file or data.get('robot_id') != self.recorder.robot_id:
            return
        try:
            self.record_queue.put_nowait((kind, data))
        except asyncio.QueueFull:
            self.record_drops += 1

    async def recorder_worker(self):
        while True:
            kind, data = await self.record_queue.get()
            try:
                await asyncio.to_thread(self.recorder.write, kind, data)
            finally:
                self.record_queue.task_done()

    async def start(self, app):
        self.tasks.append(asyncio.create_task(self.recorder_worker()))
        for index in range(self.demos):
            robot_id = f'demo-{index+1:02}'
            conn = Connection(self.context, robot_id)
            self.connections[robot_id] = conn
            self.tasks += [asyncio.create_task(serve(self.context, robot_id, conn.pub_endpoint, conn.control_endpoint)),
                           asyncio.create_task(conn.replies()), asyncio.create_task(self.receive(conn))]
        if self.readonly:
            robot_id = self.readonly['robot_id']
            if robot_id in self.connections:
                raise ValueError('real and simulated robot identities must be distinct')
            conn = Connection(self.context, robot_id, self.readonly)
            self.connections[robot_id] = conn
            self.snapshots.pop(robot_id, None)
            self.tasks.append(asyncio.create_task(self.receive(conn)))
            if conn.dealer is not None and not conn.runtime:
                self.tasks.append(asyncio.create_task(conn.replies()))
            self.event(robot_id, '运控 IPC 连接启动' if conn.runtime else '真实只读连接启动 · 运动接口未接入')
        self.event('system', '监控主机启动')

    async def receive(self, conn):
        while True:
            try:
                state = await conn.sub.recv_json()
            except (ValueError, UnicodeError):
                continue
            if not isinstance(state, dict) or state.get('robot_id') != conn.robot_id or state.get('source') != conn.source:
                continue
            if conn.runtime and not validate_runtime(state):
                continue
            if not conn.runtime and conn.readonly and not validate_state(state, conn.readonly):
                continue
            boot = state.get('boot_id')
            if boot in conn.retired_boots:
                continue
            if conn.state and conn.state['boot_id'] != boot:
                if conn.state['boot_id'] is not None:
                    conn.retired_boots.append(conn.state['boot_id'])
                conn.last_seq = 0
            if state['seq'] <= conn.last_seq:
                continue
            if conn.last_seq and state['sample_time'] < conn.state['sample_time']:
                continue
            conn.dropped += max(0, state['seq'] - conn.last_seq - 1) if conn.last_seq else 0
            conn.last_seq = state['seq']
            notice = state.get('control_notice')
            if notice and notice != (conn.state or {}).get('control_notice'):
                self.event(conn.robot_id, f"{notice.get('kind')}: {notice.get('error')}")
            conn.state, conn.received_at = state, time.monotonic()
            self.record('state', state)

    def frame(self, owner):
        states = list(self.snapshots.values())
        for conn in self.connections.values():
            if conn.state:
                online = bool(conn.received_at) and time.monotonic()-conn.received_at < conn.timeout
                if conn.runtime:
                    online = online and conn.state.get('runtime_status') == 'connected'
                value = dict(conn.state, online=online, dropped=conn.dropped, control_channel=conn.control_status())
                if conn.readonly:
                    # Capabilities here describe this monitor connection, not robot ownership.
                    value['capabilities'] = dict(motion=False, init=False, relax=False, estop=False, skills=[])
                if conn.runtime:
                    value.update(controlled=conn.robot_id in self.runtime_owners,
                                 owner=self.runtime_owners.get(conn.robot_id))
                states.append(value)
        present = {state['robot_id'] for state in states}
        profiles = self.registry.data['robots'] if hasattr(self, 'registry') else []
        for profile in profiles:
            if profile['robot_id'] not in present:
                state = unknown_state(profile['robot_id'])
                state.update(online=False, profile_id=profile['id'], configured=False)
                states.append(state)
        empty = dict(unknown_state(''), online=False, empty=True) if not states else None
        return dict(type='state', robots=states, empty_state=empty, events=list(self.events),
                    recording=dict(self.recorder.status(), dropped=self.record_drops), owner=owner)

    async def command(self, owner, message, leases):
        robot_id, kind = message.get('robot_id'), message.get('type')
        if robot_id not in self.connections:
            raise ValueError('此设备仅提供历史快照，未连接真实控制后端')
        conn = self.connections[robot_id]
        if conn.readonly:
            raise ValueError('真实监控为只读，不提供控制通道')
        if conn.runtime:
            return await self.runtime_command(conn, owner, message, leases)
        if not conn.state or time.monotonic() - conn.received_at > 0.5:
            raise ValueError('机器人反馈中断')
        # Prevent delayed browser input being renewed as a new command. Local preview only:
        # browser and host use this workstation's wall clock; remote deployment needs clock negotiation.
        sent = message.get('sent_at')
        age = time.time()-sent/1000 if type(sent) in (int, float) else float('nan')
        if not math.isfinite(age) or not -0.1 <= age < 0.25:
            raise ValueError('浏览器输入已过期')
        # Preserve the original expiry even while releasing another robot's lease.
        deadline = time.monotonic() + 0.25 - max(0, age)
        if kind == 'claim':
            for other in list(leases):
                if other != robot_id:
                    await self.release(owner, other, leases)
        lease = leases.get(robot_id, {'token': None, 'seq': 0})
        lease['seq'] += 1
        deliver = conn.notify if notification(message) else conn.request
        response = await deliver(dict(robot_id=robot_id, boot_id=conn.state['boot_id'],
                                           owner=owner, token=lease['token'], seq=lease['seq'],
                                           deadline=deadline, type=kind,
                                           payload=message.get('payload', {})))
        if kind == 'claim':
            leases[robot_id] = {'token': response['token'], 'seq': 0}
        elif kind in ('release', 'estop', 'relax') or (kind == 'pad_command' and any(a in ('rest', 'shutdown') for a in message.get('payload', {}).get('actions', []))):
            leases.pop(robot_id, None)
        if kind not in ('drive', 'heartbeat', 'pad_input'):
            self.event(robot_id, {'claim': '已接管模拟控制', 'release': '已释放控制', 'enable': '模拟机器人已就绪',
                                 'init': '模拟初始化：上力矩并归位，策略未使能',
                                 'relax': '模拟放松：动作已取消，关节力矩已关闭',
                                 'estop': '模拟急停：动作已取消，使能已关闭', 'stop': '行走指令已归零',
                                 'action': '动作请求已发送' if notification(message) else '动作请求已接受'}.get(kind, kind))
        if kind != 'heartbeat':
            self.record('command', dict(robot_id=robot_id, type=kind, payload=message.get('payload'), result=response))
        return response

    async def runtime_command(self, conn, owner, message, leases):
        robot_id, kind = conn.robot_id, message.get('type')
        sent = message.get('sent_at')
        age = time.time()-sent/1000 if type(sent) in (int, float) else float('nan')
        if not math.isfinite(age) or not -0.1 <= age < .25:
            raise ValueError('浏览器输入已过期')
        current = self.runtime_owners.get(robot_id)
        if kind == 'control_source':
            if current not in (None, owner):
                raise ValueError('请先让其他窗口释放控制')
            mode = (message.get('payload') or {}).get('mode')
            if mode not in ('bluetooth', 'console'):
                raise ValueError('请选择蓝牙直连或监控端控制')
            if conn.state.get('enabled') is not False or conn.state.get('bringup') != 'Limp':
                raise ValueError('先固定机器人并松力，再切换控制来源')
            self.runtime_owners.pop(robot_id, None)
            leases.pop(robot_id, None)
            result = await conn.request(dict(robot_id=robot_id, type=kind, payload={'mode': mode}))
            conn.state['control_source'] = result
            self.event(robot_id, '控制来源：'+mode)
            return result
        if kind == 'claim':
            if conn.state.get('control_source', {}).get('mode') != 'console':
                raise ValueError('当前为蓝牙直连或控制来源未就绪；请先切换到监控端控制')
            if current not in (None, owner):
                raise ValueError('其他窗口正在操控')
            self.runtime_owners[robot_id] = owner
            leases[robot_id] = {}
            return dict(accepted=True)
        if kind == 'pwm':
            if current not in (None, owner):
                raise ValueError('其他窗口正在操控')
            if not conn.state.get('capabilities', {}).get('pwm'):
                raise ValueError('板端 PWM 标定服务未就绪')
            payload = dict(message.get('payload', {}))
            if payload.get('action') not in ('enable', 'update', 'disable', 'configure'):
                raise ValueError('Invalid PWM operation')
            remaining = .25-max(0, age)-(time.monotonic()-conn.received_at)
            if remaining <= 0:
                raise ValueError('PWM feedback/input expired')
            payload['deadline'] = conn.state['sample_time']+remaining
            result = await conn.request(dict(robot_id=robot_id, type='pwm', payload=payload))
            if payload['action'] == 'configure':
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', robot_id):
                    raise ValueError('Invalid robot identity for local calibration storage')
                folder = ROOT/'config'/'pwm'/robot_id
                folder.mkdir(parents=True, exist_ok=True)
                destination = folder/'pwm-mouth.json'
                temporary = destination.with_suffix('.tmp')
                temporary.write_text(json.dumps(result['config'], indent=2)+'\n')
                temporary.replace(destination)
            return result
        if kind not in ('relax', 'estop') and current != owner:
            raise ValueError('请先接管控制')
        if kind == 'heartbeat':
            return dict(accepted=True)  # A UI heartbeat never refreshes robot.move.
        payload = dict(message.get('payload', {}))
        if kind in ('pad_input', 'pad_command'):
            profile = conn.state.get('pad_profile')
            if not profile or payload.get('sha256') != profile['sha256']:
                raise ValueError('Robot agent has no matching unified pad configuration')
        if kind in ('pad_input', 'pad_command') or notification(message):
            # Conservatively spend both telemetry age and browser age; never extend input lifetime.
            remaining = .25-max(0, age)-(time.monotonic()-conn.received_at)
            if remaining <= 0:
                raise ValueError('Pad feedback/input expired')
            payload['deadline'] = conn.state['sample_time']+remaining
        release_type = 'pad_release' if conn.state.get('pad_profile') else 'stop'
        deliver = conn.notify if notification(message) else conn.request
        result = await deliver(dict(robot_id=robot_id, type=release_type if kind == 'release' else kind,
                                         payload=payload))
        if kind == 'pad_command' and getattr(self, 'registry', None):
            self.registry.record_pad(robot_id, profile)
        if kind in ('release', 'relax', 'estop') or (kind == 'pad_command' and any(a in ('rest', 'shutdown') for a in payload.get('actions', []))):
            self.runtime_owners.pop(robot_id, None)
            leases.pop(robot_id, None)
        if kind not in ('drive', 'pad_input'): self.event(robot_id, ('已发送 ' if notification(message) else '运控 ')+kind)
        self.record('command', dict(robot_id=robot_id, type=kind, payload=message.get('payload'), result=result))
        return result

    async def recording_command(self, kind, robot_id):
        async with self.record_lock:
            if kind == 'record_start':
                if robot_id not in self.connections:
                    raise ValueError('历史快照不能录制为实时数据')
                if self.recorder.file:
                    raise ValueError('已有录制进行中')
                conn = self.connections[robot_id]
                if not conn.received_at or time.monotonic()-conn.received_at >= conn.timeout:
                    raise ValueError('机器人反馈中断')
                await self.record_queue.join()
                provenance = json.loads((ROOT/'models'/MODEL_DIRECTORY/'provenance.json').read_text())
                result = await asyncio.to_thread(self.recorder.start, robot_id, dict(
                    robot_id=robot_id, schema_version=1, source=conn.source, model=MODEL_ID,
                    boot_id=conn.state['boot_id'], protocol=conn.state.get('protocol'),
                    clock_domain=conn.state.get('clock_domain', 'host_monotonic'),
                    model_provenance=provenance,
                    note='运控 IPC 状态' if conn.runtime else '真实只读遥测' if conn.readonly else '模拟数据', manifest=joint_manifest()))
                self.record_drops = 0
                self.record_accepting = True
                self.event(robot_id, '开始录制')
                return result
            self.record_accepting = False
            await self.record_queue.join()
            await asyncio.to_thread(self.recorder.write, 'recording_end', dict(dropped=self.record_drops))
            return await asyncio.to_thread(self.recorder.stop)

    async def release(self, owner, robot_id, leases):
        try:
            await self.command(owner, dict(robot_id=robot_id, type='release', sent_at=time.time()*1000), leases)
        except (ValueError, asyncio.TimeoutError, zmq.ZMQError):
            leases.pop(robot_id, None)
            if self.runtime_owners.get(robot_id) == owner:
                self.runtime_owners.pop(robot_id, None)

    async def websocket(self, request):
        if request.headers.get('Origin') not in (f'http://{request.host}', f'https://{request.host}'):
            raise web.HTTPForbidden(text='同源浏览器连接才可访问')
        ws = web.WebSocketResponse(heartbeat=10, max_msg_size=8192)
        await ws.prepare(request)
        owner, leases = uuid.uuid4().hex, {}
        from host.workspace_session import WorkspaceSession
        session = WorkspaceSession(self, owner, leases, request.query.get('mode', 'monitor'))
        self.clients.add(ws)
        async def stream():
            try:
                while not ws.closed:
                    await asyncio.wait_for(ws.send_json(session.frame()), 1)
                    await asyncio.sleep(0.05)
            finally:
                await ws.close()
        sender = asyncio.create_task(stream())
        try:
            async for incoming in ws:
                if incoming.type != WSMsgType.TEXT:
                    continue
                message = {}
                try:
                    message = json.loads(incoming.data)
                    if not isinstance(message, dict):
                        raise ValueError('消息格式错误')
                    kind = message.get('type')
                    if kind == 'set_mode':
                        payload = message.get('payload', {})
                        if not isinstance(payload, dict):
                            raise ValueError('Invalid mode request')
                        result = await session.select(payload.get('mode'), message.get('robot_id'))
                    elif kind == 'refresh_robots':
                        result = dict(robots=self.frame(owner)['robots'])
                    elif kind in ('record_start', 'record_stop'):
                        result = await self.recording_command(kind, message.get('robot_id'))
                    else:
                        result = await session.command(message)
                    if not notification(message):
                        await ws.send_json(dict(type='reply', id=message.get('id'), ok=True, result=result))
                except (ValueError, KeyError, TypeError, asyncio.TimeoutError, zmq.ZMQError, OSError) as exc:
                    if notification(message):
                        text = f"{message.get('type')}: {str(exc) or 'Control delivery failed'}"
                        self.event(message.get('robot_id'), text)
                        await ws.send_json(dict(type='control_notice', robot_id=message.get('robot_id'), error=text))
                    else:
                        await ws.send_json(dict(type='reply', id=message.get('id') if isinstance(message, dict) else None,
                                                ok=False, error=str(exc) or '请求超时，结果未确认'))
        finally:
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
            for robot_id in list(leases):
                await self.release(owner, robot_id, leases)
            session.detach()
            self.clients.discard(ws)
            await ws.close()
        return ws

    async def close(self, app):
        for ws in list(self.clients):
            await ws.close()
        await self.recording_command('record_stop', None)
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.recorder.stop()
        for conn in self.connections.values():
            conn.close()
        self.context.term()


def create_app(snapshot=None, record_root=None, demos=3, readonly=None, registry_path=None):
    console = Console(snapshot, record_root, demos, readonly)
    @web.middleware
    async def local_only(request, handler):
        if request.host.split(':')[0] not in ('127.0.0.1', 'localhost'):
            raise web.HTTPForbidden(text='此开发版本仅允许本机访问')
        return await handler(request)
    app = web.Application(client_max_size=8192, middlewares=[local_only])
    app['console'] = console
    install_registry(app, console, registry_path or ROOT/'config'/'robots.json')
    checks = install_ssh_checks(app, console.registry)
    install_management(app, checks)
    install_commissioning_telemetry(app, console, Connection)
    app.on_startup.append(console.start)
    app.on_cleanup.append(console.close)
    async def index(request):
        return web.FileResponse(ROOT/'web'/'index.html', headers={'Cache-Control': 'no-store'})
    async def health(request):
        return web.json_response(dict(mode=('runtime' if readonly['protocol']==RUNTIME_PROTOCOL else 'readonly-observation' if readonly['protocol']==OBSERVATION_PROTOCOL else 'readonly-orientation' if readonly['protocol']==FUSION_PROTOCOL else 'readonly-power' if readonly['protocol']==POWER_PROTOCOL else 'readonly-sensors' if readonly['protocol']==SENSOR_PROTOCOL else 'readonly-t3' if readonly['protocol']==JOINT_PROTOCOL else 'readonly-t1') if readonly else 'local-simulation', real_motion=bool(readonly and readonly['protocol']==RUNTIME_PROTOCOL and readonly.get('control_endpoint')),
                                      robots=list(console.connections), source='development'))
    async def recordings(request):
        return web.json_response([dict(id=p.stem, bytes=p.stat().st_size)
                                  for p in sorted(console.recorder.root.glob('*.jsonl'), reverse=True)])
    async def download(request):
        record_id = request.match_info['id']
        if not re.fullmatch(r'[0-9]{8}T[0-9]{6}-[a-f0-9]{8}', record_id):
            raise web.HTTPNotFound()
        if console.recorder.file and record_id == console.recorder.id:
            raise web.HTTPConflict(text='请先结束录制')
        path = console.recorder.root/(record_id+'.jsonl')
        if not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={'Content-Disposition': f'attachment; filename="{path.name}"'})
    app.router.add_get('/', index)
    app.router.add_get('/en/', index)
    async def legacy_commissioning(request):
        query = dict(request.query, mode='commissioning')
        from urllib.parse import urlencode
        raise web.HTTPFound(('/en/' if request.path.startswith('/en/') else '/')+'?'+urlencode(query))
    app.router.add_get('/commissioning/', legacy_commissioning)
    app.router.add_get('/en/commissioning/', legacy_commissioning)
    app.router.add_get('/api/health', health)
    app.router.add_get('/api/recordings', recordings)
    app.router.add_get('/api/recordings/{id}', download)
    async def commissioning_stream(request):
        if request.headers.get('Origin') not in (f'http://{request.host}', f'https://{request.host}'):
            raise web.HTTPForbidden(text='Same-origin requests only')
        ws = web.WebSocketResponse(heartbeat=10, max_msg_size=8192)
        await ws.prepare(request)
        from host.workspace_session import WorkspaceSession
        observer = WorkspaceSession(console, 'commissioning-observer', {}, 'commissioning')
        console.clients.add(ws)
        async def send():
            try:
                while not ws.closed:
                    await asyncio.wait_for(ws.send_json(observer.frame()), 1)
                    await asyncio.sleep(.05)
            finally:
                await ws.close()
        sender = asyncio.create_task(send())
        try:
            async for message in ws:
                if message.type == WSMsgType.TEXT:
                    try:
                        value = json.loads(message.data)
                        request_id = value.get('id') if isinstance(value, dict) else None
                    except ValueError:
                        request_id = None
                    await ws.send_json(dict(type='reply', id=request_id, ok=False,
                                            error='Commissioning is read-only; use the monitor for control'))
        finally:
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
            console.clients.discard(ws)
        return ws
    app.router.add_get('/commissioning/ws', commissioning_stream)
    app.router.add_get('/ws', console.websocket)
    app.router.add_static('/src', ROOT/'web'/'src')
    app.router.add_static('/models', ROOT/'models')
    vendor = ROOT/'web'/'vendor'
    if vendor.exists():
        app.router.add_static('/vendor', vendor)
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8088)
    parser.add_argument('--snapshot', type=Path)
    parser.add_argument('--robot-config', type=Path, help='robotd IPC bridge connection')
    parser.add_argument('--readonly-config', type=Path, help='pinned CURVE T1 system-only robot connection')
    parser.add_argument('--registry', type=Path, help='local robot dossier registry')
    parser.add_argument('--demos', type=int, default=None)
    args = parser.parse_args()
    config_path = args.robot_config or args.readonly_config
    config = load_config(config_path, 'host') if config_path else None
    demos = args.demos if args.demos is not None else (0 if config else 3)
    web.run_app(create_app(args.snapshot, demos=demos, readonly=config, registry_path=args.registry), host='127.0.0.1', port=args.port)
