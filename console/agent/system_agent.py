"""Temporary T1 system-only publisher. No actuator, IPC, GPIO or audio stream access.

This is not the production Rust robot agent. It exposes only an authenticated PUB
socket and reads procfs/sysfs once per second; there is no command receiver.
"""
import argparse
import asyncio
import json
from pathlib import Path
import signal
import socket
import time
import uuid

import zmq
import zmq.asyncio
from zmq.auth.asyncio import AsyncioAuthenticator

from agent.system_probe import SystemProbe
from protocol.readonly import load_config, unknown_state


class HostKey:
    def __init__(self, key):
        self.key = key.encode()

    def callback(self, domain, key):
        return domain == 'console-t1' and key == self.key


class SystemAgent:
    def __init__(self, config, probe=None):
        self.config = config
        self.probe = probe or SystemProbe()
        self.hostname = socket.gethostname()
        if self.hostname != config['hostname']:
            raise ValueError('robot hostname differs from pinned identity')
        self.os_boot_id = (self.probe.proc/'sys/kernel/random/boot_id').read_text().strip()
        if not self.os_boot_id:
            raise ValueError('OS boot identity unavailable')
        self.boot_id = str(uuid.uuid4())
        self.seq = 0

    def sample_system(self):
        return self.probe.sample()

    def sample(self):
        state = unknown_state(self.config['robot_id'])
        self.seq += 1
        state.update(boot_id=self.boot_id, os_boot_id=self.os_boot_id, hostname=self.hostname,
                     seq=self.seq, sample_time=time.monotonic(), system=self.sample_system())
        state['collection_valid'] = all(state['system'][key] is not None
                                        for key in ('cpu_percent', 'memory_percent', 'cpu_temp')) and all(
            state['system'][key] != '未知' for key in ('speaker', 'microphone'))
        return state

    def background(self, context):
        return []

    async def run(self, stop, frames=0):
        context = zmq.asyncio.Context()
        auth = AsyncioAuthenticator(context)
        pub = context.socket(zmq.PUB)
        tasks = []
        try:
            auth.start()
            auth.configure_curve_callback('console-t1', HostKey(self.config['peer_public_key']))
            pub.setsockopt(zmq.ZAP_DOMAIN, b'console-t1')
            pub.curve_publickey = self.config['public_key'].encode()
            pub.curve_secretkey = self.config['secret_key'].encode()
            pub.curve_server = True
            pub.setsockopt(zmq.LINGER, 0)
            pub.setsockopt(zmq.SNDHWM, 2)
            pub.bind(self.config['endpoint'])
            print(json.dumps(dict(status='read-only publisher started', protocol=self.config['protocol'],
                                  robot_id=self.config['robot_id'], boot_id=self.boot_id)), flush=True)
            tasks = [asyncio.create_task(job) for job in self.background(context)]
            while not stop.is_set():
                for task in tasks:
                    if task.done(): task.result()
                started = time.monotonic()
                state = await asyncio.to_thread(self.sample)
                try:
                    await pub.send_json(state, flags=zmq.NOBLOCK)
                except zmq.Again:
                    pass
                if frames and self.seq >= frames:
                    break
                try:
                    await asyncio.wait_for(stop.wait(), max(0, getattr(self, "period", 1) - (time.monotonic() - started)))
                except asyncio.TimeoutError:
                    pass
        finally:
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            pub.close()
            auth.stop()
            context.term()


async def main(args):
    agent = SystemAgent(load_config(args.config, 'agent'))
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    await agent.run(stop, args.frames)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--frames', type=int, default=0)
    args = parser.parse_args()
    if args.frames < 0:
        parser.error('--frames must be nonnegative')
    asyncio.run(main(args))
