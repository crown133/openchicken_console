"""Candidate sensor monitor with inherited, input-only Pin31 sampling."""
import argparse
import asyncio
import os
from pathlib import Path
import time

from agent.imu_agent import SensorAgent, main
from agent.power_probe import PowerProbe
from protocol.readonly import POWER_PROTOCOL


class PowerAgent(SensorAgent):
    def __init__(self, config, joints, imus, power, probe=None):
        super().__init__(config, joints, imus, probe)
        self.power = power

    def sample(self):
        state = super().sample()
        power = self.power.sample()
        state['system']['external_power'] = power['value']
        state.update(protocol=POWER_PROTOCOL, power_input=power, sample_time=time.monotonic())
        return state


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--gpio-fd', required=True, type=int)
    parser.add_argument('--frames', type=int, default=0)
    args = parser.parse_args()
    if os.getuid() == 0 or os.geteuid() == 0 or args.gpio_fd < 3 or args.frames < 0:
        parser.error('requires non-root process and inherited GPIO request fd')
    power = PowerProbe(args.gpio_fd)
    try:
        asyncio.run(main(args, protocol=POWER_PROTOCOL,
                        agent_factory=lambda c,j,i: PowerAgent(c,j,i,power)))
    finally:
        os.close(args.gpio_fd)
