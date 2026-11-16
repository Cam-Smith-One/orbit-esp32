"""Check deployed console + real relay sync without printing secrets or private content.

--save re-saves the existing configuration unchanged and waits for its new revision.
"""
import argparse
import asyncio
import json
from pathlib import Path
import time

import aiohttp

ROOT = Path(__file__).resolve().parent

async def main(save):
    connection = json.loads((ROOT / '.private/cloud.json').read_text())
    secret = json.loads((ROOT / '.private/console-secrets.json').read_text())
    url = connection['url']
    headers = {'Origin': url}
    if connection.get('deploymentBypass'):
        headers['x-vercel-protection-bypass'] = connection['deploymentBypass']
    async with aiohttp.ClientSession(headers=headers, timeout=aiohttp.ClientTimeout(total=20)) as http:
        async def request(method, path, **kwargs):
            async with http.request(method, url + path, allow_redirects=False, **kwargs) as response:
                if response.status != 200:
                    raise SystemExit(f'{method} {path}: HTTP {response.status}; not verified')
                return await response.json()
        await request('POST', '/api/login', json={'code': secret['ORBIT_ADMIN_CODE']})
        state = await request('GET', '/api/state')
        print('Cloud sign-in, authenticated state and private durable storage: PASS', flush=True)
        revision = state['config']['revision']
        print('Connector states:', [(item.get('status'), len(item.get('tools', [])))
                                    for item in state['snapshot'].get('connectors', [])], flush=True)
        print('Google Calendar tools approved:', [all(name in item.get('allowedTools', []) for name in
              ('google_calendar_find_calendars', 'google_calendar_find_events'))
              for item in state['config'].get('connectors', [])], flush=True)
        if save:
            payload = state['config']
            for connector in payload['connectors']:
                connector.pop('hasToken', None)
            result = await request('PUT', '/api/config', json=payload)
            revision = result['config']['revision']
            print(f'Unchanged configuration saved as revision {revision}; waiting for real relay', flush=True)
        deadline = time.monotonic() + 85
        while True:
            state = await request('GET', '/api/state')
            snapshot = state['snapshot']
            if snapshot['updatedAt'] and snapshot['appliedRevision'] == revision:
                print(f'Real relay applied revision {revision}; snapshot received. '
                      f'Memories={len(snapshot["memories"])}, notes={len(snapshot["notes"])}, '
                      f'connectors={len(snapshot["connectors"])}', flush=True)
                break
            if time.monotonic() > deadline:
                raise SystemExit('Relay did not acknowledge revision; not verified')
            await asyncio.sleep(5)
        await request('POST', '/api/logout', json={})

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--save', action='store_true')
    asyncio.run(main(parser.parse_args().save))
