"""Inspect one recorded robot state; validate against the pinned host configuration."""
import argparse
import json
from pathlib import Path

from protocol.observation import sensor_observation
from protocol.readonly import load_config,validate_state


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('state',type=Path)
    parser.add_argument('--config',type=Path,required=True)
    args=parser.parse_args()
    state=json.loads(args.state.read_text())
    if not validate_state(state,load_config(args.config,'host')):
        parser.error('recorded state failed pinned protocol validation')
    print(json.dumps(sensor_observation(state),ensure_ascii=False,indent=2))
