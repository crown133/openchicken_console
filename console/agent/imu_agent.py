"""Explicit sensor-monitor entry; IMU configuration is temporary and restored on exit."""
import argparse
import asyncio
import json
from pathlib import Path
import signal
import time

from agent.imu_probe import imu_session
from agent.joint_agent import JointAgent
from agent.joint_probe import JointProbe, PARAMETERS, check_services, require_no_torque, wire
from protocol.readonly import SENSOR_PROTOCOL, OBSERVATION_PROTOCOL, load_config


class SensorAgent(JointAgent):
    def __init__(self,config,joints,imus,probe=None):
        super().__init__(config,joints,probe)
        self.imus=imus

    def sample(self):
        state=super().sample()
        state.update(self.imus.sample())
        # End-of-read host timestamp; each sensor preserves its individual read interval.
        state.update(protocol=SENSOR_PROTOCOL,sample_time=time.monotonic())
        return state


async def main(args, *, protocol=SENSOR_PROTOCOL, agent_factory=SensorAgent):
    config=load_config(args.config,'agent')
    if config['protocol'] != protocol:
        raise ValueError('explicit sensor-monitor protocol configuration required')
    check_services()
    stop=asyncio.Event()
    for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):
        asyncio.get_running_loop().add_signal_handler(sig,stop.set)
    with wire.serial_port() as fd:
        joints=JointProbe(fd, include_velocity=protocol==OBSERVATION_PROTOCOL)
        initial=await asyncio.to_thread(joints.audit)
        print(json.dumps(dict(event='initial_read_audit',joints=initial)),flush=True)
        require_no_torque(initial)
        report={}
        try:
            with imu_session(report) as imus:
                print(json.dumps(dict(event='imu_setup',report=report)),flush=True)
                await agent_factory(config,joints,imus).run(stop,args.frames)
        finally:
            print(json.dumps(dict(event='imu_restore',report=report)),flush=True)
            final=await asyncio.to_thread(joints.audit)
            changed=[dict(id=a['id'],field=k,before=a[k],after=b[k])
                     for a,b in zip(initial,final) for k in PARAMETERS if a[k]!=b[k]]
            print(json.dumps(dict(event='final_read_audit',joints=final,parameter_changes=changed)),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',required=True,type=Path)
    parser.add_argument('--frames',type=int,default=0)
    args=parser.parse_args()
    if args.frames<0: parser.error('--frames must be nonnegative')
    asyncio.run(main(args))
