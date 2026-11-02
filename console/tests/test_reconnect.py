"""Exercise silent connection loss with local TCP/CURVE, without robot hardware."""
import asyncio
from pathlib import Path
import sys
import time
import unittest

import zmq
import zmq.asyncio

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).parent))
from host.server import Connection, Console
from protocol.runtime import PROTOCOL
from test_readonly import configs


class ReconnectTests(unittest.IsolatedAsyncioTestCase):
    async def test_silent_loss_recovers_without_restarting_console(self):
        context = zmq.asyncio.Context()
        pub = context.socket(zmq.PUB)
        pub.setsockopt(zmq.LINGER, 0)
        agent, host = configs('unused')
        pub.curve_publickey = agent['public_key'].encode()
        pub.curve_secretkey = agent['secret_key'].encode()
        pub.curve_server = True
        port = pub.bind_to_random_port('tcp://127.0.0.1')
        streams, handlers = [], set()

        async def proxy(reader, writer):
            task = asyncio.current_task()
            handlers.add(task)
            upstream = None
            pumps = []
            link = {'drop': False}
            streams.append(link)
            try:
                other, upstream = await asyncio.open_connection('127.0.0.1', port)

                async def pump(source, target):
                    while data := await source.read(65536):
                        if not link['drop']:
                            target.write(data)
                            await target.drain()

                pumps = [asyncio.create_task(pump(reader, upstream)),
                         asyncio.create_task(pump(other, writer))]
                await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for pump_task in pumps:
                    pump_task.cancel()
                await asyncio.gather(*pumps, return_exceptions=True)
                writer.close()
                if upstream:
                    upstream.close()
                    await upstream.wait_closed()
                await writer.wait_closed()
                handlers.discard(task)

        server = await asyncio.start_server(proxy, '127.0.0.1', 0)
        host.update(protocol=PROTOCOL,
                    endpoint='tcp://127.0.0.1:'+str(server.sockets[0].getsockname()[1]))
        console = Console(demos=0)
        conn = Connection(console.context, host['robot_id'], host)
        console.connections[conn.robot_id] = conn
        receiver = asyncio.create_task(console.receive(conn))

        async def receive_boot(boot, first_seq):
            seq = first_seq
            while conn.state.get('boot_id') != boot:
                await pub.send_json(dict(protocol=PROTOCOL, robot_id=conn.robot_id,
                                         source='robot', boot_id=boot, seq=seq,
                                         sample_time=seq/20, joints=[], system={},
                                         runtime_status='connected'))
                seq += 1
                await asyncio.sleep(.05)

        try:
            await asyncio.wait_for(receive_boot('before', 1000), 3)
            self.assertTrue(console.frame('test')['robots'][0]['online'])
            # Keep the old TCP streams open but swallow traffic in both directions.
            for attempt in range(2):
                for link in streams:
                    link['drop'] = True
                await asyncio.sleep(.6)
                self.assertFalse(console.frame('test')['robots'][0]['online'])
                started = time.monotonic()
                await asyncio.wait_for(receive_boot(f'after-{attempt}', 1), 7)
                self.assertTrue(console.frame('test')['robots'][0]['online'])
                self.assertLess(time.monotonic()-started, 7)
            self.assertGreaterEqual(len(streams), 3)
        finally:
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
            conn.close()
            server.close()
            await server.wait_closed()
            tasks = list(handlers)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            pub.close()
            context.term()
            console.context.term()


if __name__ == '__main__':
    unittest.main()
