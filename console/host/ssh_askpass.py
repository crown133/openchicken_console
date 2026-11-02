"""OpenSSH password prompt helper. Secret stays in memory, never argv/files/environment."""
import os
import socket
import sys

if __name__ == '__main__':
    prompt = sys.argv[1] if len(sys.argv) > 1 else ''
    if 'password' not in prompt.lower():
        raise SystemExit(1)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(10)
        client.connect(os.environ['OPENCHICKEN_ASKPASS_SOCKET'])
        client.sendall(b'password\n')
        data = b''
        while not data.endswith(b'\n') and len(data) < 4096:
            chunk = client.recv(4096)
            if not chunk:
                break
            data += chunk
    if not data.endswith(b'\n'):
        raise SystemExit(1)
    sys.stdout.buffer.write(data)
