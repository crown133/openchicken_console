"""Explicit monitoring-only attitude entry; original sensor setup/restore unchanged."""
import argparse
import asyncio
import os
from pathlib import Path
import time

from agent.imu_agent import main
from agent.imu_orientation import Orientations
from agent.power_agent import PowerAgent
from agent.power_probe import PowerProbe
from protocol.readonly import FUSION_PROTOCOL,OBSERVATION_PROTOCOL,load_config


class FusionAgent(PowerAgent):
    def __init__(self,config,joints,imus,power,orientations,probe=None):
        super().__init__(config,joints,imus,power,probe)
        self.orientations=orientations

    def sample(self):
        state=super().sample()
        state.update(self.orientations.sample(state))
        state.update(protocol=self.config['protocol'],sample_time=time.monotonic())
        return state


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',required=True,type=Path)
    parser.add_argument('--calibration',required=True,type=Path)
    parser.add_argument('--gpio-fd',required=True,type=int)
    parser.add_argument('--frames',type=int,default=0)
    args=parser.parse_args()
    if os.getuid()==0 or os.geteuid()==0 or args.gpio_fd<3 or args.frames<0:
        parser.error('requires non-root process and inherited GPIO request fd')
    try:
        config=load_config(args.config,'agent')
        if config['protocol'] not in (FUSION_PROTOCOL,OBSERVATION_PROTOCOL):
            raise ValueError('explicit orientation/observation monitor protocol required')
        orientation=Orientations(args.calibration,config['robot_id'],config['calibration_id'])
        power=PowerProbe(args.gpio_fd)
        asyncio.run(main(args,protocol=config['protocol'],
                        agent_factory=lambda c,j,i:FusionAgent(c,j,i,power,orientation)))
    finally:
        os.close(args.gpio_fd)
