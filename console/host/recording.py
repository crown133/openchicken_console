"""Bounded host-side recordings; failures never stop telemetry/control."""
import json
from pathlib import Path
import time
import uuid


class Recorder:
    MAX_BYTES = 64 * 1024 * 1024
    TOTAL_BYTES = 512 * 1024 * 1024

    def __init__(self, root):
        self.root = Path(root)
        self.file = None
        self.id = None
        self.robot_id = None
        self.bytes = 0
        self.error = None
        self.limit = self.MAX_BYTES

    def start(self, robot_id, metadata):
        if self.file:
            raise ValueError('已有录制进行中')
        self.root.mkdir(parents=True, exist_ok=True)
        existing = sum(p.stat().st_size for p in self.root.glob('*.jsonl'))
        if existing >= self.TOTAL_BYTES:
            raise ValueError('录制目录达到 512 MiB 上限，请归档后重试')
        self.limit = min(self.MAX_BYTES, self.TOTAL_BYTES-existing)
        self.id = time.strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8]
        self.robot_id = robot_id
        self.bytes = 0
        self.error = None
        self.file = (self.root / (self.id + '.jsonl')).open('x', encoding='utf8')
        self.write('metadata', metadata)
        return self.status()

    def write(self, kind, data):
        if not self.file:
            return
        line = json.dumps({'kind': kind, 'host_time': time.time(), 'data': data}, ensure_ascii=False, allow_nan=False) + '\n'
        size = len(line.encode())
        if self.bytes + size > self.limit:
            self.error = '录制文件或目录达到容量上限，已结束录制'
            self.stop()
            return
        try:
            self.file.write(line)
            self.bytes += size
        except OSError as exc:
            self.error = '录制写入失败：' + str(exc)
            self.stop()

    def stop(self):
        if self.file:
            try:
                self.file.close()
            except OSError as exc:
                self.error = str(exc)
            self.file = None
        return self.status()

    def status(self):
        return dict(active=self.file is not None, id=self.id, robot_id=self.robot_id,
                    bytes=self.bytes, error=self.error)
