"""One-shot USB connection diagnostic; prints only selected status codes."""
import argparse
import json
from pathlib import Path
import re
import time

import serial

parser = argparse.ArgumentParser()
parser.add_argument('--port', required=True)
parser.add_argument('--talk', action='store_true')
parser.add_argument('--seconds', type=int, default=25)
args = parser.parse_args()
secret = json.loads((Path(__file__).resolve().parent / '.private/config.json').read_text())['token']
needles = ('ORBIT:', 'esp-tls', 'esp_transport', 'HTTP_CLIENT', 'WebSocket', 'wifi:', 'Network', 'OTA', 'CheckNewVersion')
with serial.Serial(args.port, 115200, timeout=.3) as port:
    port.dtr = True
    port.rts = False
    time.sleep(.3)
    if args.talk:
        port.write(b'{"action":"talk"}\n')
        port.flush()
    end = time.monotonic() + max(1, min(args.seconds, 60))
    while time.monotonic() < end:
        line = port.readline().decode(errors='replace')
        if any(x.lower() in line.lower() for x in needles):
            line = line.replace(secret, '[redacted]')
            line = re.sub(r'sk-[A-Za-z0-9_-]+', '[redacted]', line)
            print(line[:240].rstrip(), flush=True)
