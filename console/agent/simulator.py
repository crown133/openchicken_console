"""ZMQ simulator: bounded queues, per-browser leases, deadlines and deduplication.

This module has no serial, robot IPC, SSH, or hardware command path.
"""
import asyncio
from collections import OrderedDict
import json
import math
import time
import uuid

import zmq
from protocol.control_delivery import notification
from protocol.model import JOINTS, SKILLS, MODEL_ID, joint_manifest, validate_velocity
from protocol.pad import VERSION, DEFAULTS, LIMITS, calls as pad_calls


class RobotSimulation:
    def __init__(self, robot_id, clock=time.monotonic):
        self.robot_id = robot_id
        self.clock = clock
        self.boot_id = uuid.uuid4().hex
        self.owner = None
        self.token = None
        self.lease_until = 0
        self.last_seq = -1
        self.velocity = {'vx': 0.0, 'vyaw': 0.0}
        self.drive_until = 0
        self.enabled = False
        self.estopped = False
        self.torqued = False
        self.bringup = 'Limp'
        self.homing = None
        self.seated = False
        self.action = None
        self.results = OrderedDict()
        self.q = {i: h for i, _, _, h in JOINTS}
        self.last_tick = clock()
        self.pad_profile = dict(version=VERSION, sha256='simulation-v1', source='simulation', parameters=DEFAULTS, drive_limits=LIMITS)
        self.pad_intent = None
        self.phase = 0.0
        self.seq = 0

    def expire(self):
        now = self.clock()
        if now >= self.drive_until:
            self.velocity = {'vx': 0.0, 'vyaw': 0.0}
        if self.owner and now >= self.lease_until:
            self.release()

    def release(self):
        self.owner = self.token = None
        self.velocity = {'vx': 0.0, 'vyaw': 0.0}
        self.drive_until = 0

    def command(self, request):
        if not isinstance(request, dict):
            raise ValueError('消息必须是对象')
        self.expire()
        now = self.clock()
        if request.get('robot_id') != self.robot_id:
            raise ValueError('机器人身份不匹配')
        if request.get('boot_id') != self.boot_id:
            raise ValueError('机器人会话已重置，请重新连接')
        deadline = request.get('deadline')
        if not isinstance(deadline, (float, int)) or not math.isfinite(deadline) or not now <= deadline <= now + 1:
            raise ValueError('命令已过期或有效期无效')
        owner = request.get('owner')
        if not isinstance(owner, str) or not owner:
            raise ValueError('缺少操作者会话')
        kind = request.get('type')
        # Simulator-only stop is available even when another browser owns the lease.
        # Identity, boot ID and deadline validation above still apply. No hardware path.
        if kind in ('relax', 'estop'):
            self.enabled = False
            self.estopped = True
            self.torqued = False
            self.bringup = 'Limp'
            self.homing = None
            if self.action and self.action['status'] == 'running':
                self.action['status'] = 'cancelled'
            self.release()
            return {'accepted': True}
        if kind == 'claim':
            if self.owner and self.owner != owner:
                raise ValueError('机器人正由另一个窗口操控')
            if not self.owner:
                self.owner, self.token = owner, uuid.uuid4().hex
                self.last_seq = -1
            self.lease_until = now + 0.8
            return {'token': self.token}
        if owner != self.owner or request.get('token') != self.token:
            raise ValueError('没有有效控制权')
        seq = request.get('seq')
        if type(seq) is not int or seq <= self.last_seq:
            raise ValueError('重复或乱序控制帧')
        self.last_seq = seq
        payload = request.get('payload', {})
        if not isinstance(payload, dict):
            raise ValueError('命令参数必须是对象')
        if kind in ('pad_input', 'pad_command'):
            pad_calls(kind, payload, self.pad_profile)  # Same validation; no native calls executed.
            self.lease_until = now + 0.8
            if kind == 'pad_input':
                self.pad_intent = dict(payload)
                allowed = self.bringup == 'Ready' and self.enabled and not self.seated and not (self.action and self.action['status'] == 'running')
                return self.apply('drive' if allowed else 'stop', payload['velocity'], now, deadline, owner)
            for action in payload['actions']:
                if action in ('rest', 'shutdown'):
                    # Simulation stops here; no OS shutdown, servo reboot or audio is simulated.
                    self.enabled = self.torqued = False
                    self.bringup = 'Limp'
                    self.homing = self.action = None
                    self.release()
                elif action == 'home' or action == 'toggle' and self.enabled:
                    self.enabled = False
                    self.seated = False
                    self.apply('init', {}, now, deadline, owner)
                elif action == 'toggle':
                    self.apply('enable', {}, now, deadline, owner)
                elif action == 'init':
                    self.apply('init', {}, now, deadline, owner)
                elif action != 'chirp':
                    self.apply('action', dict(skill=action, action_id=uuid.uuid4().hex), now, deadline, owner)
            return {'accepted': True, 'source': 'simulation'}
        return self.apply(kind, payload, now, deadline, owner)

    def apply(self, kind, payload, now, deadline, owner):
        if kind == 'release':
            self.release()
        elif kind == 'heartbeat':
            self.lease_until = now + 0.8
        elif kind == 'init':
            if self.bringup != 'Homing':
                self.enabled = False
                self.estopped = False
                self.torqued = True
                self.velocity = {'vx': 0.0, 'vyaw': 0.0}
                self.drive_until = 0
                if self.action and self.action['status'] == 'running':
                    self.action['status'] = 'cancelled'
                target = {i: home + ((-1.1 if i == 13 else 1.1) if self.seated and i in (13, 23) else 0)
                          for i, _, _, home in JOINTS}
                self.homing = dict(started=now, origin=dict(self.q), target=target)
                self.bringup = 'Homing'
        elif kind == 'enable':
            if self.bringup != 'Ready':
                raise ValueError('请先初始化并等待归位完成')
            self.enabled = True
            self.estopped = False
        elif kind == 'stop':
            self.velocity = {'vx': 0.0, 'vyaw': 0.0}
            self.drive_until = 0
        elif kind == 'drive':
            if self.bringup != 'Ready' or not self.enabled or self.seated or (self.action and self.action['status'] == 'running'):
                raise ValueError('机器人未就绪或动作执行中')
            self.velocity = validate_velocity(payload)
            self.drive_until = min(deadline, now + 0.3)
            self.lease_until = now + 0.8
        elif kind == 'action':
            action_id, skill = payload.get('action_id'), payload.get('skill')
            if not isinstance(action_id, str) or not 1 <= len(action_id) <= 80:
                raise ValueError('动作编号无效')
            key = (owner, action_id)
            if key in self.results:
                previous = self.results[key]
                if previous['skill'] != skill:
                    raise ValueError('同一动作编号不能用于其他动作')
                return dict(previous)
            if skill not in SKILLS:
                raise ValueError('不支持的动作')
            if self.bringup != 'Ready' or not self.enabled or (self.action and self.action['status'] == 'running'):
                raise ValueError('机器人未就绪或已有动作执行中')
            if self.seated and skill != 'sit_toggle':
                raise ValueError('请先站起')
            self.action = dict(action_id=action_id, skill=skill, status='running',
                               started=now, duration=SKILLS[skill][1])
            self.results[key] = self.action
            while len(self.results) > 64:
                self.results.popitem(last=False)
            self.velocity = {'vx': 0.0, 'vyaw': 0.0}
            return dict(self.action)
        else:
            raise ValueError('未知命令')
        return {'accepted': True}

    def sample(self):
        self.expire()
        now = self.clock()
        dt = min(max(now - self.last_tick, 0.001), 0.1)
        self.last_tick = now
        self.seq += 1
        moving = abs(self.velocity['vx']) + abs(self.velocity.get('vy',0.)) + abs(self.velocity['vyaw']) > 0
        self.phase += dt * (8 if moving else 1)
        if self.action and self.action['status'] == 'running' and now >= self.action['started'] + self.action['duration']:
            self.action['status'] = 'completed'
            if self.action['skill'] == 'sit_toggle':
                self.seated = not self.seated
        homing = self.homing
        progress = min(1.0, (now - homing['started']) / 2.0) if homing else None
        if homing and progress >= 1:
            self.bringup = 'Ready'
            self.homing = None
        rows = []
        for i, name, label, home in JOINTS:
            target = home
            if self.seated and i in (13, 23):
                target += -1.1 if i == 13 else 1.1
            if moving and i < 30:
                target += math.sin(self.phase + (math.pi if i >= 20 else 0)) * (0.28 if i % 10 in (2, 3) else 0.07)
            if self.action and self.action['status'] == 'running':
                a = self.action
                wave = math.sin(math.pi * (now - a['started']) / a['duration'])
                ids = {'kick_left': (22, 23), 'kick_right': (12, 13), 'ground_pick': (30, 31),
                       'roulade': (12, 13, 22, 23), 'sit_toggle': (13, 23)}[a['skill']]
                if i in ids:
                    target += wave * (-0.65 if i < 20 else 0.65)
            if homing:
                target = homing['origin'][i] + (homing['target'][i] - homing['origin'][i]) * progress
            elif not self.torqued:
                target = self.q[i]
            old = self.q[i]
            self.q[i] = target if homing else old + (target - old) * min(1, dt * 12)
            rows.append(dict(id=i, name=name, label=label, position=self.q[i], requested=target,
                             submitted=target, velocity=(self.q[i] - old)/dt, current_ma=round(abs(target-self.q[i])*400),
                             torque=self.torqued, error=0, voltage=7.5, temperature=28,
                             p=200 if self.enabled else 400, i=0, d=0, pwm_slope=255,
                             pwm_limit=885, drive_mode=0, homing_offset=-512 if i in (13,23) else 0,
                             valid=True, status='ok' if self.torqued else 'warning'))
        # Deliberately synthetic orientation; never presented as a sensor measurement.
        roll = 0.035 * math.sin(self.phase * 0.7) if self.enabled else 0.0
        pitch = 0.025 * math.sin(self.phase * 0.5) if self.enabled else 0.0
        yaw = 0.08 * math.sin(self.phase * 0.2) if self.enabled else 0.0
        cr, sr = math.cos(roll/2), math.sin(roll/2)
        cp, sp = math.cos(pitch/2), math.sin(pitch/2)
        cy, sy = math.cos(yaw/2), math.sin(yaw/2)
        quat = [cr*cp*cy+sr*sp*sy, sr*cp*cy-cr*sp*sy,
                cr*sp*cy+sr*cp*sy, cr*cp*sy-sr*sp*cy]
        return dict(schema_version=1, robot_id=self.robot_id, boot_id=self.boot_id, seq=self.seq,
                    sample_time=now, source='simulation', enabled=self.enabled, seated=self.seated,
                    torqued=self.torqued, bringup=self.bringup, pad_profile=self.pad_profile, pad_intent=self.pad_intent,
                    controlled=self.owner is not None, action=self.action, joints=rows,
                    imu=dict(valid=True, sample_time=now, frame='body_to_world', quat=quat, source='simulation'),
                    system=dict(voltage=7.5, external_power=True, cpu_temp=43.2,
                                cpu_percent=8.0, memory_percent=22.5, speaker='模拟就绪', microphone='模拟就绪'),
                    model=MODEL_ID, model_verified=False,
                    control_stream_version=1, control_notice=getattr(self, 'control_notice', None),
                    capabilities=dict(motion=True, init=True, relax=True, estop=True, source='simulation', skills=list(SKILLS)),
                    manifest=joint_manifest())


async def serve(context, robot_id, pub_endpoint, control_endpoint):
    robot = RobotSimulation(robot_id)
    pub, router = context.socket(zmq.PUB), context.socket(zmq.ROUTER)
    for sock in (pub, router):
        sock.setsockopt(zmq.LINGER, 0)
        sock.setsockopt(zmq.SNDHWM, 8)
        sock.setsockopt(zmq.RCVHWM, 32)
    pub.bind(pub_endpoint)
    router.bind(control_endpoint)

    async def commands():
        while True:
            identity, raw = await router.recv_multipart()
            request = {}
            try:
                if len(raw) > 4096:
                    raise ValueError('命令过大')
                request = json.loads(raw)
                result = robot.command(request)
                reply = dict(id=request.get('id'), ok=True, result=result)
            except (ValueError, TypeError, KeyError) as exc:
                reply = dict(id=request.get('id') if isinstance(request, dict) else None, ok=False, error=str(exc))
            if notification(request):
                if not reply['ok']:
                    robot.control_notice = dict(kind=request.get('type'), error=reply['error'], time=time.monotonic())
                continue
            try:
                await router.send_multipart([identity, json.dumps(reply).encode()], flags=zmq.NOBLOCK)
            except zmq.Again:
                pass

    task = asyncio.create_task(commands())
    try:
        while True:
            await pub.send_json(robot.sample())
            await asyncio.sleep(0.05)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        pub.close()
        router.close()
