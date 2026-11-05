"""IPC-to-ZMQ bridge. robotd/tofd own the sensors; this process never opens DXL or I2C."""
import argparse
import asyncio
import json
from pathlib import Path
import signal
import time
import uuid

import zmq
from agent.system_agent import SystemAgent
from protocol.readonly import load_config
from protocol.runtime import PROTOCOL, snapshot, command
from protocol.control_delivery import notification
from agent.control_stream import ControlStream
from agent.control_source import console_allowed, require_console
from protocol.pad import load_profile, calls as pad_calls, release_calls


class Rpc:
    def __init__(self, path, timeout=2):
        self.path = path
        self.timeout = timeout
        self.reader = self.writer = None
        self.lock = asyncio.Lock()
        self.seq = 0

    async def close(self):
        if self.writer:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except OSError:
                pass
        self.reader = self.writer = None

    async def call(self, method, params=None):
        async with self.lock:
            try:
                return await asyncio.wait_for(self._request(method, params), self.timeout)
            except (OSError, asyncio.TimeoutError, asyncio.CancelledError):
                # No automatic replay: the previous call may already have been executed.
                await self.close()
                raise

    async def _request(self, method, params):
        if not self.writer:
            self.reader, self.writer = await asyncio.open_unix_connection(self.path, limit=1024*1024)
        self.seq += 1
        self.writer.write((json.dumps(dict(jsonrpc='2.0', id=self.seq, method=method,
                                           params=params or {}))+'\n').encode())
        await self.writer.drain()
        while line := await self.reader.readline():
            reply = json.loads(line)
            if reply.get('id') != self.seq:
                continue
            if reply.get('error'):
                raise ValueError(reply['error']['message'])
            result = reply.get('result') or {}
            if result.get('accepted') is False:
                raise ValueError(result.get('reason', 'runtime rejected request'))
            return result
        raise ConnectionError('runtime socket closed')


class RuntimeAgent(SystemAgent):
    period = .05

    def __init__(self, config, gpio_fd=None):
        super().__init__(config)
        self.robot_socket = config.get('robot_socket', '/run/robotd.sock')
        self.head_socket = config.get('head_socket', '/run/tofd.sock')
        self.rpc = Rpc(self.robot_socket)
        self.pwm_rpc = Rpc('/run/openchicken-pwm/control.sock')
        self.pwm_session = uuid.uuid4().hex
        self.pwm_state = dict(available=False, enabled=None, error='PWM calibration service not connected')
        self.frame = self.model = self.health = self.policies = {}
        self.pad_profile = None
        self.pad_error = "Native pad configuration not loaded"
        self.control_notice = None
        self.control_source = dict(mode='unavailable', available=False, error='Control source service not connected')
        self.source_rpc = Rpc('/run/openchicken-control-source/control.sock', timeout=45)
        self.head = None
        self.connected = False
        self.last_frame_at = 0.
        self.system = {}
        self.power = None
        if gpio_fd is not None:
            from agent.power_probe import PowerProbe
            self.power = PowerProbe(gpio_fd)

    def sample(self):
        self.seq += 1
        state = snapshot(self.config['robot_id'], self.boot_id, self.seq, time.monotonic(),
                         self.frame, self.model, self.health, self.policies, self.head,
                         self.system, self.connected and time.monotonic()-self.last_frame_at < 3,
                         bool(self.config.get('control_endpoint')))
        state['mouth_pwm'] = dict(self.pwm_state)
        state['capabilities']['pwm'] = bool(self.config.get('control_endpoint') and self.pwm_state.get('available'))
        state['control_stream_version'] = 1
        state['control_notice'] = self.control_notice
        state['control_source'] = dict(self.control_source)
        state['pad_profile'] = self.pad_profile
        state['pad_error'] = self.pad_error
        if self.power:
            state['power_input'] = self.power.sample()
            state['system']['external_power'] = state['power_input']['value']
        return state

    def background(self, context):
        tasks = [self.states(), self.slow(), self.head_states(), self.pwm_states(), self.source_states()]
        if self.config.get('control_endpoint'):
            tasks.append(self.commands(context))
        return tasks

    async def source_states(self):
        rpc = Rpc('/run/openchicken-control-source/control.sock')
        try:
            while True:
                try:
                    self.control_source = await rpc.call('control.source', {'action': 'status'})
                except (OSError, ValueError, asyncio.TimeoutError) as exc:
                    self.control_source = dict(mode='unavailable', available=False, error=str(exc))
                await asyncio.sleep(1)
        finally:
            await rpc.close()

    async def pwm_states(self):
        rpc = Rpc('/run/openchicken-pwm/control.sock')
        try:
            while True:
                try:
                    self.pwm_state = await rpc.call('pwm.control', {'action': 'status'})
                except (OSError, ValueError, asyncio.TimeoutError) as exc:
                    self.pwm_state = dict(available=False, enabled=None, error=str(exc))
                await asyncio.sleep(.2)
        finally:
            await rpc.close()

    async def states(self):
        while True:
            rpc = Rpc(self.robot_socket)
            try:
                self.model = await rpc.call('robot.model')
                await rpc.call('robot.subscribe', {'hz': 20})
                self.boot_id = str(uuid.uuid4())
                while line := await rpc.reader.readline():
                    message = json.loads(line)
                    if message.get('method') == 'robot.state':
                        self.frame = message['params']
                        self.last_frame_at = time.monotonic()
                        self.connected = True
                raise ConnectionError('robot state stream closed')
            except (OSError, ValueError, asyncio.TimeoutError) as exc:
                print(json.dumps(dict(event='runtime_disconnected', error=str(exc))), flush=True)
            finally:
                self.connected = False
                self.frame = {}
                await rpc.close()
            await asyncio.sleep(1)

    async def head_states(self):
        while True:
            rpc = Rpc(self.head_socket)
            try:
                await rpc.call('head_imu.stream')
                while line := await rpc.reader.readline():
                    message = json.loads(line)
                    if message.get('method') == 'head_imu.frame':
                        self.head = message['params']
            except (OSError, ValueError, asyncio.TimeoutError):
                pass
            finally:
                self.head = None
                await rpc.close()
            await asyncio.sleep(1)

    async def slow(self):
        rpc = Rpc(self.robot_socket)
        try:
            while True:
                try:
                    self.pad_profile = await asyncio.to_thread(load_profile, self.config.get('pad_config'))
                    self.pad_error = None
                except (OSError, ValueError, ImportError) as exc:
                    self.pad_profile = None
                    self.pad_error = str(exc)
                self.system = await asyncio.to_thread(self.probe.sample, temperature=False)
                try:
                    self.health = await rpc.call('robot.health')
                    self.policies = await rpc.call('robot.policies')
                    built_in = (await rpc.call('robot.skills')).get('built_in', [])
                    self.policies['skills'] = list(dict.fromkeys(self.policies.get('skills', []) + built_in))
                except (OSError, ValueError, asyncio.TimeoutError):
                    self.health = self.policies = {}
                await asyncio.sleep(1)
        finally:
            await rpc.close()

    def report_control_error(self, kind, error):
        self.control_notice = dict(kind=kind, error=error, time=time.monotonic())

    async def commands(self, context):
        socket = context.socket(zmq.ROUTER)
        socket.setsockopt(zmq.LINGER, 0)
        socket.setsockopt(zmq.RCVHWM, 8)
        socket.setsockopt(zmq.ZAP_DOMAIN, b'console-t1')
        socket.curve_publickey = self.config['public_key'].encode()
        socket.curve_secretkey = self.config['secret_key'].encode()
        socket.curve_server = True
        socket.bind(self.config['control_endpoint'])
        stream = ControlStream(lambda: Rpc(self.robot_socket),
                               lambda: Rpc('/run/openchicken-pwm/control.sock'),
                               lambda: self.pad_profile,
                               lambda: self.pwm_session if self.pwm_state.get('version', 0) >= 2 else None,
                               self.report_control_error, gate=require_console)
        try:
            while True:
                peer, raw = await socket.recv_multipart()
                request = {}
                try:
                    request = json.loads(raw)
                    if request.get('robot_id') != self.config['robot_id']:
                        raise ValueError('incorrect robot identity')
                    kind, payload = request['type'], request.get('payload') or {}
                    if kind == 'control_source':
                        await stream.clear()
                        result = await self.source_rpc.call('control.source', dict(action='select', mode=payload.get('mode')))
                        self.control_source = result
                        await socket.send_multipart([peer, json.dumps(dict(id=request.get('id'), ok=True, result=result)).encode()])
                        continue
                    if kind == 'pad_release' and not console_allowed():
                        await stream.clear()
                        await socket.send_multipart([peer, json.dumps(dict(id=request.get('id'), ok=True, result={'accepted': True})).encode()])
                        continue
                    if kind not in ('relax', 'estop', 'stop', 'pwm'):
                        require_console()
                    terminal = kind == 'pad_command' and any(a in ('rest', 'shutdown') for a in payload.get('actions', []))
                    if notification(request) and not terminal:
                        stream.submit(kind, payload)
                        continue
                    if kind in ('pad_release', 'relax', 'estop', 'stop', 'init', 'enable', 'pad_command'):
                        await stream.clear()
                    if kind == 'pwm':
                        result = await self.pwm_rpc.call('pwm.control', payload)
                    elif kind == 'pad_release':
                        if self.pwm_state.get('version', 0) >= 2:
                            try:
                                await self.pwm_rpc.call('pwm.control', dict(action='release_trigger', source='console', session=self.pwm_session))
                            except (OSError, ValueError, asyncio.TimeoutError):
                                pass
                        result = {'accepted': True}
                        for method, params in release_calls():
                            result = await self.rpc.call(method, params)
                    elif kind in ('pad_input', 'pad_command'):
                        # The host echoes this agent's monotonic telemetry clock. No wall-clock sync.
                        deadline = payload.get('deadline')
                        if type(deadline) not in (int, float) or not 0 < deadline-time.monotonic() <= .25:
                            raise ValueError('Pad input expired')
                        batch = pad_calls(kind, payload, self.pad_profile)
                        result = {'accepted': True}
                        for method, params in batch:
                            if time.monotonic() >= deadline:
                                raise ValueError('Pad input expired during forwarding; not replayed')
                            result = await self.rpc.call(method, params)
                        if kind == 'pad_input' and self.pwm_state.get('version', 0) >= 2 and time.monotonic() < deadline:
                            await self.pwm_rpc.call('pwm.control', dict(action='trigger', source='console',
                                session=self.pwm_session, value=payload['mouth'], deadline=deadline))
                    else:
                        if kind in ('relax', 'estop', 'stop') and self.pwm_state.get('available'):
                            try:
                                await self.pwm_rpc.call('pwm.control', {'action': 'disable'})
                            except (OSError, ValueError, asyncio.TimeoutError):
                                pass  # PWM lease expires independently; never block DXL relax.
                        method, params = command(kind, payload)
                        result = await self.rpc.call(method, params)
                    reply = dict(id=request.get('id'), ok=True, result=result)
                except (KeyError, TypeError, ValueError, OSError, asyncio.TimeoutError) as exc:
                    reply = dict(id=request.get('id'), ok=False, error=str(exc))
                if notification(request):
                    if not reply['ok']:
                        self.report_control_error(request.get('type'), reply['error'] or 'Native command timed out')
                else:
                    await socket.send_multipart([peer, json.dumps(reply).encode()])
        finally:
            await stream.clear()
            socket.close()
            await self.rpc.close()
            await self.pwm_rpc.close()
            await self.source_rpc.close()


async def main(args):
    config = load_config(args.config, 'agent')
    config.setdefault('pad_config', str(args.config.resolve().with_name('robotd.toml')))
    if config['protocol'] != PROTOCOL:
        raise ValueError('use the runtime IPC configuration')
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    await RuntimeAgent(config, args.gpio_fd).run(stop)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--gpio-fd', type=int, help='optional inherited Pin31 input; never opened here')
    asyncio.run(main(parser.parse_args()))
