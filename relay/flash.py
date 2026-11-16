"""Flash only the identified Waveshare; preserve the NVS/settings partition.
Run with ESP-IDF 6 Python: python relay/flash.py --wait 120
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import time
from serial.tools import list_ports
from cryptography import x509
from cryptography.hazmat.primitives import serialization

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--wait', type=int, default=10)
parser.add_argument('--app-only', action='store_true', help='Refresh app0 after the full Orbit layout has been flashed')
args = parser.parse_args()
config = json.loads((ROOT / 'relay/.private/config.json').read_text())
flash = json.loads((ROOT / 'build/flasher_args.json').read_text())
assert set(flash['flash_files']) == {'0x0', '0x8000', '0xd000', '0x20000', '0x800000'}, 'Unexpected flash layout; review before writing'
certificate = x509.load_pem_x509_certificate((ROOT / 'relay/.private/server.crt').read_bytes())
public_key = certificate.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
assert public_key in (ROOT / 'build/xiaozhi.bin').read_bytes(), 'Current relay certificate is missing from compiled firmware; rebuild before flashing'
print('Waiting for Waveshare USB (no writes until MAC matches)...', flush=True)
deadline = time.monotonic() + max(1, min(args.wait, 300))
while time.monotonic() < deadline:
    ports = [p.device for p in list_ports.comports() if p.vid == 0x303A and p.pid == 0x1001]
    if not ports:
        time.sleep(.5)
        continue
    if len(ports) != 1: raise SystemExit('Multiple ESP32 USB devices; unplug other boards first')
    port = ports[0]
    probe = subprocess.run([sys.executable, '-m', 'esptool', '--port', port, '--after', 'no-reset', 'read-mac'],
                           capture_output=True, text=True, timeout=25)
    macs = re.findall(r'MAC:\s*([0-9a-fA-F:]{17})', probe.stdout)
    if probe.returncode or not macs: raise SystemExit('Could not identify board; no flash performed')
    if macs[-1].lower() != config['device']:
        subprocess.run([sys.executable, '-m', 'esptool', '--port', port, '--after', 'hard-reset', 'read-mac'],
                       capture_output=True, timeout=25)
        raise SystemExit('Connected board MAC does not match Waveshare; refused to flash')
    print('Confirmed Waveshare', config['device'], 'on', port, flush=True)
    files = ['0x20000', 'xiaozhi.bin'] if args.app_only else ['@flash_args']
    result = subprocess.run([sys.executable, '-m', 'esptool', '--chip', 'esp32s3', '--port', port,
                             '--baud', '921600', '--before', 'default-reset', '--after', 'hard-reset',
                             'write-flash', *files], cwd=ROOT / 'build')
    raise SystemExit(result.returncode)
raise SystemExit('Waveshare USB did not appear. No flash performed.')
