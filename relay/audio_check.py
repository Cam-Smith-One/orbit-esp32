"""Hardware check: run with ESP-IDF Python after verifying the Waveshare MAC.

Requires an active listening session. Leaves speaker at 80% and mic at High.
No audio is recorded or stored by this check.
"""
import argparse
import json
import re
import time

import serial
from serial.tools import list_ports

parser = argparse.ArgumentParser()
parser.add_argument('--port', required=True)
args = parser.parse_args()
ports = [p.device for p in list_ports.comports() if p.vid == 0x303A and p.pid == 0x1001]
assert ports == [args.port], 'Connect only the verified Waveshare USB device'
with serial.Serial(args.port, 115200, timeout=.1) as port:
    port.dtr, port.rts = True, False
    time.sleep(.3)

    def request(values, invalid=False):
        port.write((json.dumps({'action': 'audio', **values}) + '\n').encode())
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            line = port.readline().decode(errors='replace').strip()
            if line == 'ORBIT: Invalid audio setting':
                assert invalid
                return None
            if line.startswith('ORBIT_AUDIO:'):
                assert not invalid
                found = re.fullmatch(r'ORBIT_AUDIO: volume=(\d+) gain=([\d.]+) input=(\d)', line)
                assert found, line
                return int(found[1]), float(found[2]), int(found[3])
        raise AssertionError('Board did not acknowledge audio setting')

    assert request({})[2] == 1, 'Tap the orb and wait for Listening before this check'
    request({'volume': 101}, invalid=True)
    request({'gain': 37}, invalid=True)
    request({'gain': 24.5}, invalid=True)
    assert request({'volume': 80, 'gain': 24}) == (80, 24, 1)
    assert request({'gain': 36}) == (80, 36, 1)
    assert request({}) == (80, 36, 1)
print('PASS: live gain updates, input bounds, speaker 80%, mic High (36 dB).')
