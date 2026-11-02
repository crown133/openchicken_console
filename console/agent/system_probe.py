"""Read-only, low-rate Linux system collector for the future robot-side worker.

No subprocesses, audio streams, bus access or control-loop hooks. Missing sensors
stay unknown. Instantiate in a worker and call at 1 Hz, never in the control loop.
"""
from pathlib import Path


class SystemProbe:
    def __init__(self, proc='/proc', sys='/sys', audio_card='aic3104'):
        self.proc, self.sys = Path(proc), Path(sys)
        self.audio_card = audio_card
        self.previous_cpu = None

    @staticmethod
    def read(path):
        try:
            return path.read_text().strip()
        except (OSError, UnicodeError):
            return None

    def sample(self, *, temperature=True):
        cpu = None
        stat = self.read(self.proc/'stat')
        if stat:
            try:
                # guest counters are already included in user/nice; count only 0..7.
                values = [int(v) for v in stat.splitlines()[0].split()[1:9]]
                total, idle = sum(values), values[3]+values[4]
                if self.previous_cpu:
                    delta = total-self.previous_cpu[0]
                    if delta > 0:
                        cpu = max(0, min(100, 100*(1-(idle-self.previous_cpu[1])/delta)))
                self.previous_cpu = total, idle
            except (ValueError, IndexError):
                pass
        memory = None
        meminfo = self.read(self.proc/'meminfo')
        if meminfo:
            try:
                fields = {line.split(':')[0]: int(line.split()[1]) for line in meminfo.splitlines()}
                if fields.get('MemTotal', 0) > 0 and 'MemAvailable' in fields:
                    memory = 100*(1-fields['MemAvailable']/fields['MemTotal'])
            except (ValueError, IndexError):
                pass
        temperatures = []
        for zone in ((self.sys/'class/thermal').glob('thermal_zone*') if temperature else []):
            kind = (self.read(zone/'type') or '').lower()
            if any(name in kind for name in ('cpu', 'soc', 'package')):
                try:
                    temperatures.append(int(self.read(zone/'temp'))/1000)
                except (TypeError, ValueError):
                    pass
        # Only the configured HAT card counts; an unrelated USB/HDMI card does not.
        cards = self.read(self.proc/'asound/cards')
        pcm = self.read(self.proc/'asound/pcm')
        card_ids = [p for p in (self.proc/'asound').glob('card[0-9]*/id')
                    if self.read(p) == self.audio_card]
        lines = []
        for path in card_ids:
            prefix = f'{int(path.parent.name[4:]):02d}-'
            lines.extend(line for line in (pcm or '').splitlines() if line.startswith(prefix))
        known = pcm is not None and cards is not None
        speaker = any('playback' in line for line in lines) if known else None
        microphone = any('capture' in line for line in lines) if known else None
        def audio_status(present):
            return '未知' if present is None else '已枚举 · 未验证' if present else '未枚举'
        return dict(cpu_percent=cpu, memory_percent=memory,
                    cpu_temp=max(temperatures) if temperatures else None,
                    external_power=None,  # Pin31 is deliberately not accessed in T1.
                    voltage=None, speaker=audio_status(speaker), microphone=audio_status(microphone),
                    audio=dict(card=self.audio_card, speaker_present=speaker, microphone_present=microphone,
                               playback_verified=False, capture_verified=False))
