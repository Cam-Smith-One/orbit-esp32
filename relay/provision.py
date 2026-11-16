"""USB setup or a talk toggle; run with ESP-IDF's Python (includes pyserial)."""
import argparse
import json
from pathlib import Path
import time
import serial
import base64

parser = argparse.ArgumentParser()
parser.add_argument('--port', required=True)
parser.add_argument('--talk', action='store_true')
parser.add_argument('--snapshot', action='store_true')
args = parser.parse_args()
path = Path(__file__).resolve().parent / '.private/wifi.json'
payload = {'action': 'screen'} if args.snapshot else {'action': 'talk'} if args.talk else json.loads(path.read_text())
if not args.talk and not args.snapshot:
    assert payload.get('action') == 'wifi' and 1 <= len(payload['ssid'].encode()) <= 32
    assert 8 <= len(payload['password'].encode()) <= 63
with serial.Serial(args.port, 115200, timeout=.2) as port:
    port.dtr = True
    port.rts = False
    time.sleep(.3)
    port.write((json.dumps(payload) + '\n').encode())
    port.flush()
    end = time.monotonic() + 15
    image = bytearray()
    while time.monotonic() < end:
        line = port.readline().decode(errors='replace')
        if args.snapshot and line.startswith('ORBIT_IMAGE:'):
            image.extend(base64.b64decode(line.split(':', 1)[1].strip(), validate=True))
            if len(image) > 1024 * 1024: raise SystemExit('Screenshot exceeds limit')
        if args.snapshot and line.startswith('ORBIT_IMAGE_END'):
            if not image.startswith(b'\xff\xd8') or not image.endswith(b'\xff\xd9'):
                raise SystemExit('Invalid JPEG; capture failed')
            output = path.parent.parent / 'screen.jpg'
            output.write_bytes(image)
            print('Saved real board framebuffer:', output)
            break
        # Never print arbitrary serial input, which might echo credentials.
        if args.talk and 'ORBIT: Talk request accepted' in line:
            print('Board accepted talk request; relay status confirms connection separately.')
            break
        if 'ORBIT: Wi-Fi saved' in line:
            print('Board acknowledged Wi-Fi settings and is rebooting.')
            break
    else:
        raise SystemExit('No device acknowledgement; operation is NOT verified.')
