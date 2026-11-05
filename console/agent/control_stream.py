"""Bounded notification delivery. Each continuous lane retains only its latest target."""
import asyncio
import math
import time
from protocol.pad import calls as pad_calls
from protocol.runtime import command


class ControlStream:
    def __init__(self, rpc_factory, pwm_rpc_factory, profile, pwm, report, gate=lambda: None):
        self.rpcs = {name: rpc_factory() for name in ('move', 'aux', 'buttons')}
        self.pwm_rpc = pwm_rpc_factory()
        self.profile, self.pwm, self.report = profile, pwm, report
        self.queues = {name: asyncio.Queue(maxsize=8 if name == 'buttons' else 1)
                       for name in self.rpcs}
        self.tasks = {}
        self.generation = 0
        self.gate = gate

    def submit(self, kind, payload):
        self.gate()
        deadline = payload.get('deadline')
        if type(deadline) not in (float, int) or not math.isfinite(deadline) or not 0 < deadline-time.monotonic() <= .25:
            raise ValueError('Input expired; discarded')
        clean = {k: v for k, v in payload.items() if k != 'deadline'}
        calls = pad_calls(kind, payload, self.profile()) if kind in ('pad_input', 'pad_command') else [command(kind, clean)]
        if kind == 'pad_input':
            self.put('move', (kind, deadline, calls[:1], None))
            self.put('aux', (kind, deadline, calls[1:], payload['mouth']))
        else:
            lane = 'move' if kind == 'drive' else 'aux' if kind == 'head' else 'buttons'
            self.put(lane, (kind, deadline, calls, None))

    def put(self, lane, item):
        queue = self.queues[lane]
        if queue.full():
            if lane == 'buttons':
                raise ValueError('Action queue busy; action not queued or retried')
            queue.get_nowait()
        queue.put_nowait(item)
        if lane not in self.tasks:
            self.tasks[lane] = asyncio.create_task(self.worker(lane, self.generation))

    async def worker(self, lane, generation):
        queue, rpc = self.queues[lane], self.rpcs[lane]
        while True:
            kind, deadline, calls, mouth = await queue.get()
            try:
                for method, params in calls:
                    self.gate()
                    remaining = deadline-time.monotonic()
                    if remaining <= 0 or generation != self.generation:
                        break
                    await asyncio.wait_for(rpc.call(method, params), remaining)
                if mouth is not None and self.pwm() is not None and generation == self.generation:
                    self.gate()
                    remaining = deadline-time.monotonic()
                    if remaining > 0:
                        await asyncio.wait_for(self.pwm_rpc.call('pwm.control', dict(
                            action='trigger', source='console', session=self.pwm(),
                            value=mouth, deadline=deadline)), remaining)
            except (OSError, ValueError, asyncio.TimeoutError) as exc:
                self.report(kind, str(exc) or f'{lane} IPC deadline exceeded')

    async def clear(self):
        # Cancel in-flight RPCs before a stop/init/ownership transition; never replay them.
        self.generation += 1
        tasks = list(self.tasks.values())
        self.tasks.clear()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for queue in self.queues.values():
            while not queue.empty():
                queue.get_nowait()
        await asyncio.gather(*(rpc.close() for rpc in self.rpcs.values()), self.pwm_rpc.close())
