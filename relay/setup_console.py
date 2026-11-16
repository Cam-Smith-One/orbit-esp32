"""Prepare private dashboard secrets, optionally install them into the linked Vercel project.
Never prints credential values. Read the access code through local private setup.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url')
    parser.add_argument('--install-env', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    # Follow the linked project, never the CLI's globally selected company team.
    linked = json.loads((ROOT.parent / 'console/.vercel/project.json').read_text())
    scope, project = linked['orgId'], linked['projectId']
    file = ROOT / '.private/console-secrets.json'
    if file.exists():
        values = json.loads(file.read_text())
    else:
        values = {k: secrets.token_urlsafe(32) for k in ('ORBIT_ADMIN_CODE', 'ORBIT_SESSION_SECRET', 'ORBIT_RELAY_TOKEN')}
        values['ORBIT_ENCRYPTION_KEY'] = base64.b64encode(secrets.token_bytes(32)).decode()
        file.write_text(json.dumps(values))
    admin_file = ROOT / '.private/console-admin.json'
    admin = json.loads(admin_file.read_text()) if admin_file.exists() else {'code': values['ORBIT_ADMIN_CODE']}
    if args.url:
        url = urlsplit(args.url)
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
            parser.error('Dashboard URL must be HTTPS')
        admin['url'] = args.url.rstrip('/')
        connection = {'url': admin['url'], 'token': values['ORBIT_RELAY_TOKEN']}
        bypass_file = ROOT / '.private/console-bypass.json'
        if bypass_file.exists():
            bypass = json.loads(bypass_file.read_text()).get('protectionBypass')
            if bypass is True:
                response = subprocess.run(['vercel', 'api', '/v9/projects/' + project, '--scope', scope, '--raw'],
                    cwd=ROOT.parent / 'console', text=True, capture_output=True, check=True)
                candidates = [key for key, value in json.loads(response.stdout).get('protectionBypass', {}).items()
                              if value.get('scope') == 'automation-bypass']
                if len(candidates) != 1:
                    raise SystemExit('Expected exactly one dashboard automation credential.')
                bypass = candidates[0]
            if not isinstance(bypass, str) or not 16 <= len(bypass) <= 512:
                raise SystemExit('Unexpected deployment bypass response; no cloud connection saved.')
            connection['deploymentBypass'] = bypass
        (ROOT / '.private/cloud.json').write_text(json.dumps(connection))
    admin_file.write_text(json.dumps(admin))
    if args.install_env:
        for key, value in values.items():
            result = subprocess.run(['vercel', 'env', 'add', key, 'preview', '--scope', scope, '--sensitive'],
                                    cwd=ROOT.parent / 'console', input=value, text=True, capture_output=True)
            if result.returncode:
                raise SystemExit(f'Could not install {key}; check Vercel environment configuration privately.')
            print(f'Installed {key} in Preview (value hidden).')
    print('Dashboard credentials prepared privately. No secret values printed.')

if __name__ == '__main__':
    main()
