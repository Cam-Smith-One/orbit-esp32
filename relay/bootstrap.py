"""Generate local TLS and device credentials; never embeds an OpenAI key in firmware."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parent

def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True, help='Mac .local hostname or LAN IPv4 address')
    parser.add_argument('--device', required=True, help='ESP32 MAC address')
    parser.add_argument('--rotate-certificate', action='store_true', help='Replace TLS credentials; requires rebuilding and reflashing the board')
    args = parser.parse_args(argv)
    import ipaddress
    import re
    try:
        ipaddress.IPv4Address(args.host)
        host_san = f'IP:{args.host}'
    except ValueError:
        if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.local', args.host):
            parser.error('host must be a .local hostname or IPv4 address')
        host_san = f'DNS:{args.host}'
    if not re.fullmatch(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', args.device):
        parser.error('device must be a lowercase MAC address')
    os.umask(0o077)
    private = ROOT / '.private'
    private.mkdir(exist_ok=True)
    config_file = private / 'config.json'
    config = json.loads(config_file.read_text()) if config_file.exists() else {'token': secrets.token_urlsafe(32)}
    existing_tls = (private / 'server.key').exists() or (private / 'server.crt').exists()
    if existing_tls and not args.rotate_certificate:
        if config.get('host') != args.host or not all((private / name).is_file() for name in ('server.key', 'server.crt')):
            parser.error('Changing the relay host or repairing TLS requires --rotate-certificate, then rebuild and reflash')
    config.update(host=args.host, device=args.device)
    openssl = '/opt/homebrew/opt/openssl@3/bin/openssl'
    if not Path(openssl).exists():
        openssl = 'openssl'
    if not existing_tls or args.rotate_certificate:
        subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
                        '-keyout', str(private / 'server.key'), '-out', str(private / 'server.crt'),
                        '-subj', '/CN=Orbit local relay', '-addext', f'subjectAltName={host_san},DNS:localhost',
                        '-addext', 'basicConstraints=critical,CA:TRUE'], check=True, capture_output=True)
    config_file.write_text(json.dumps(config))
    # ESP-IDF ignores .crt files even when their contents are PEM.
    (private / 'server.pem').write_bytes((private / 'server.crt').read_bytes())
    # Generated, ignored device credential. This is NOT an OpenAI API key.
    (private / 'device_config.h').write_text(
        '#pragma once\n#define ORBIT_RELAY_URL ' + json.dumps(f'https://{args.host}:8443/ota/') +
        '\n#define ORBIT_DEVICE_TOKEN ' + json.dumps(config['token']) + '\n')
    print('TLS certificate and device credential ready; no API key embedded.')

if __name__ == '__main__':
    main()
