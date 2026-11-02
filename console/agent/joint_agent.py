"""Explicit T3 read-only entry. Do not deploy before review and bus ownership check."""
import argparse
import asyncio
import json
from pathlib import Path
import signal
import time

from agent.joint_probe import JointProbe, PARAMETERS, check_services, require_no_torque, wire
from agent.system_agent import SystemAgent
from protocol.readonly import JOINT_PROTOCOL, load_config


class JointAgent(SystemAgent):
    period = .05

    def __init__(self, config, joints, probe=None):
        super().__init__(config, probe)
        self.joint_probe = joints
        self.system_at = float('-inf')
        self.system = None

    def sample_system(self):
        # System metrics remain at 1 Hz; the DXL loop has no queued backlog.
        if time.monotonic()-self.system_at >= 1:
            self.system = self.probe.sample()
            self.system_at = time.monotonic()
        return dict(self.system)

    def sample(self):
        state = super().sample()
        state.update(protocol=JOINT_PROTOCOL, telemetry_hz=20,
                     joints=self.joint_probe.sample(), system_sample_time=self.system_at)
        voltages = [j['voltage'] for j in state['joints'] if j['valid']]
        state['system'].update(voltage=sum(voltages)/len(voltages) if voltages else None,
                               voltage_min=min(voltages) if voltages else None,
                               voltage_max=max(voltages) if voltages else None,
                               voltage_samples=len(voltages), voltage_source='dxl_mean')
        state['joints_valid'] = all(j['valid'] for j in state['joints'])
        state['torqued'] = False if state['joints_valid'] else None
        state['bus_statistics'] = dict(self.joint_probe.stats)
        return state


async def main(args):
    config = load_config(args.config, 'agent')
    if config['protocol'] != JOINT_PROTOCOL:
        raise ValueError('T3 requires explicit joint protocol configuration')
    check_services()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    with wire.serial_port() as fd:
        probe = JointProbe(fd)
        initial = await asyncio.to_thread(probe.audit)
        print(json.dumps(dict(event='initial_read_audit', joints=initial)), flush=True)
        require_no_torque(initial)
        try:
            await JointAgent(config, probe).run(stop, args.frames)
        finally:
            try:
                final = await asyncio.to_thread(probe.audit)
                changed = [dict(id=a['id'], field=k, before=a[k], after=b[k])
                           for a, b in zip(initial, final) for k in PARAMETERS if a[k] != b[k]]
                print(json.dumps(dict(event='final_read_audit', joints=final, parameter_changes=changed)), flush=True)
            except (OSError, ValueError) as exc:
                print(json.dumps(dict(event='final_read_audit_failed', error=str(exc))), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--frames', type=int, default=0)
    args = parser.parse_args()
    if args.frames < 0:
        parser.error('--frames must be nonnegative')
    asyncio.run(main(args))
