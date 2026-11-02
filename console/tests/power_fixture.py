"""Browser-test-only procfs fixture. Never uses live robot identity or hardware."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import struct
from unittest.mock import patch

from aiohttp import web
from test_readonly import ROOT, configs, fixture
from agent.power_agent import PowerAgent
from agent.power_probe import PowerProbe
from agent.imu_agent import SensorAgent
from test_imus import FakeBus
from agent.imu_probe import ImuProbe
from test_joints import FakeJoints
from protocol.readonly import POWER_PROTOCOL
from host.server import create_app


async def main():
    with tempfile.TemporaryDirectory(dir=ROOT/'tests') as directory:
        root = Path(directory)
        agent_config, host_config = configs('tcp://127.0.0.1:15557')
        agent_config['protocol']=host_config['protocol']=POWER_PROTOCOL
        joints=FakeJoints()
        bus=FakeBus();imus=ImuProbe(bus)
        probe = fixture(root)
        value=[1]
        def gpio_read(fd,op,data,mutate):
            if value[0] is None:raise OSError('fixture GPIO failure')
            struct.pack_into('<QQ',data,0,value[0],1)
        gpio_mock=patch('agent.power_probe.fcntl.ioctl',side_effect=gpio_read)
        gpio_mock.start()
        agent = PowerAgent(agent_config,joints,imus,PowerProbe(9),probe)
        stop = asyncio.Event()
        task = asyncio.create_task(agent.run(stop))
        app = create_app(record_root=root/'records', demos=0, readonly=host_config)
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, '127.0.0.1', 18089).start()
        print('FIXTURE_READY', flush=True)
        try:
            while True:
                command = await asyncio.to_thread(sys.stdin.readline)
                if not command or command.strip() == 'quit':
                    break
                if command.strip()=='power0':value[0]=0
                if command.strip()=='power1':value[0]=1
                if command.strip()=='power_fail':value[0]=None
                if command.strip()=='imu_fail_head': bus.failed={0x19}
                if command.strip()=='imu_fail_body': bus.failed={0x6a}
                if command.strip()=='imu_restore': bus.failed.clear()
                if command.strip()=='fail': joints.failed={13}
                if command.strip()=='restore': joints.failed.clear()
                if command.strip()=='move': joints.count=3072
                if command.strip() in ('stop', 'restart'):
                    stop.set()
                    await task
                if command.strip() == 'restart':
                    agent = PowerAgent(agent_config,joints,imus,PowerProbe(9),probe)
                    stop = asyncio.Event()
                    task = asyncio.create_task(agent.run(stop))
        finally:
            stop.set()
            await task
            await runner.cleanup()
            gpio_mock.stop()


if __name__ == '__main__':
    asyncio.run(main())
