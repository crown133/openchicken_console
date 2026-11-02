"""Browser-test-only procfs fixture. Never uses live robot identity or hardware."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile

from aiohttp import web
from test_readonly import ROOT, configs, fixture
from agent.system_agent import SystemAgent
from host.server import create_app


async def main():
    with tempfile.TemporaryDirectory(dir=ROOT/'tests') as directory:
        root = Path(directory)
        agent_config, host_config = configs('tcp://127.0.0.1:15557')
        probe = fixture(root)
        agent = SystemAgent(agent_config, probe)
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
                if command.strip() in ('stop', 'restart'):
                    stop.set()
                    await task
                if command.strip() == 'restart':
                    agent = SystemAgent(agent_config, probe)
                    stop = asyncio.Event()
                    task = asyncio.create_task(agent.run(stop))
        finally:
            stop.set()
            await task
            await runner.cleanup()


if __name__ == '__main__':
    asyncio.run(main())
