"""Switch the board's compiled endpoint while keeping a private rollback copy.

Run from repo root with `python relay/firmware_endpoint.py cloud` or `local`.
Neither action changes NVS or flashes the board.
"""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

private = Path(__file__).resolve().parent / '.private'
header = private / 'device_config.h'
backup = private / 'device_config.local.h'
if len(sys.argv) != 2 or sys.argv[1] not in ('cloud', 'local'):
    raise SystemExit('Usage: firmware_endpoint.py cloud|local')
if sys.argv[1] == 'local':
    if not backup.exists():
        raise SystemExit('No local endpoint backup; nothing changed')
    header.write_bytes(backup.read_bytes())
    print('Local relay endpoint restored for the next firmware build')
else:
    config = json.loads((private / 'config.json').read_text())
    if not header.exists():
        raise SystemExit('Device header missing; run bootstrap first')
    origin = os.getenv('ORBIT_CLOUD_URL', '').rstrip('/')
    parsed = urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise SystemExit('Set ORBIT_CLOUD_URL to your own HTTPS relay origin before selecting cloud')
    if not backup.exists():
        backup.write_bytes(header.read_bytes())
        backup.chmod(0o600)
    url = origin + '/ota/'
    header.write_text('#pragma once\n#define ORBIT_RELAY_URL ' + json.dumps(url) +
                      '\n#define ORBIT_DEVICE_TOKEN ' + json.dumps(config['token']) +
                      '\n#define ORBIT_CLOUD_DNS_HOST ' + json.dumps(parsed.hostname) + '\n')
    header.chmod(0o600)
    print('Cloud endpoint selected for the next firmware build:', url)
