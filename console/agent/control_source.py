"""Board-local control gate, checked again when queued commands are delivered."""
from pathlib import Path

MODE = Path('/run/openchicken-control-source/mode')


def console_allowed():
    try:
        return MODE.read_text().strip() == 'console'
    except OSError:
        return False


def require_console():
    if not console_allowed():
        raise ValueError('当前为蓝牙直连或控制来源未就绪；请先切换到监控端控制')
