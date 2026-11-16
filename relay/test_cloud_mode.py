"""Cloud relay configuration checks without hardware, credentials or network calls."""
import asyncio
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


async def check():
    with tempfile.TemporaryDirectory(prefix='orbit-cloud-test-') as tmp:
        with patch.dict(os.environ, {
            'ORBIT_PUBLIC_URL': 'https://orbit.example',
            'ORBIT_PRIVATE_DIR': tmp,
            'ORBIT_DEVICE_ID': '00:11:22:33:44:55',
            'ORBIT_DEVICE_TOKEN': 'local-test-token',
        }):
            import importlib
            import server
            importlib.reload(server)
            relay = server.Relay()
            app = web.Application()
            app.add_routes([web.get('/ota/', relay.ota), web.post('/control', relay.control)])
            async with TestClient(TestServer(app)) as client:
                response = await client.get('/ota/', headers={'Device-Id': '00:11:22:33:44:55'})
                assert response.status == 200
                assert (await response.json())['websocket']['url'] == 'wss://orbit.example/device'
                response = await client.get('/ota/', headers={'Device-Id': 'wrong'})
                assert response.status == 403
                response = await client.post('/control', headers={'Authorization': 'Bearer local-test-token'}, json={'action': 'status'})
                assert response.status == 200  # TestServer is loopback; Fly's public proxy is not.
            assert (Path(tmp) / 'memory.db').exists()
            relay.store.db.close()
    print('PASS: cloud HTTPS discovery, board ID check, authenticated loopback control, durable DB path')


asyncio.run(check())
