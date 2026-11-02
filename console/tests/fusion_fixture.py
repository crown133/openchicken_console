import asyncio,json,tempfile,sys,time
from pathlib import Path
from aiohttp import web
from test_orientations import ROOT,build_agent
from host.server import create_app

async def main():
    with tempfile.TemporaryDirectory(dir=ROOT/'tests') as directory:
        agent,host,power,bus,path=build_agent(Path(directory))
        agent.config['endpoint']=host['endpoint']='tcp://127.0.0.1:15561'
        def sample():return dict(controller='gpio@fe760000',offset=12,line='PIN_31',sample_time=time.monotonic(),raw=True,value=True,stable_samples=3,valid=True,error=None)
        power.sample.side_effect=sample
        stop=asyncio.Event();task=asyncio.create_task(agent.run(stop))
        app=create_app(record_root=Path(directory)/'records',demos=0,readonly=host);runner=web.AppRunner(app)
        await runner.setup();await web.TCPSite(runner,'127.0.0.1',18091).start();print('FUSION_FIXTURE_READY',flush=True)
        try:
            while True:
                command=(await asyncio.to_thread(sys.stdin.readline)).strip()
                if command in ('','quit'):break
                if command=='fail_body':bus.failed={0x6a}
                if command=='restore':bus.failed.clear()
                if command=='offline':stop.set();await task
        finally:stop.set();await task;await runner.cleanup()

asyncio.run(main())
