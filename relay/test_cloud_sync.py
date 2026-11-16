"""Run with relay/.venv/bin/python relay/test_cloud_sync.py; no external calls."""
import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import uuid

from cloud_sync import CloudSync
from memory import MemoryStore
from server import Relay, session_config
from weather import Weather
from aiohttp.test_utils import TestClient, TestServer
from aiohttp import web


async def check():
    with tempfile.TemporaryDirectory(prefix='orbit-cloud-') as directory:
        store = MemoryStore(Path(directory) / 'db')
        relay = SimpleNamespace(store=store, active=None)
        sync = CloudSync(relay, Path(directory) / 'cloud.json')
        c = {'id': str(uuid.uuid4()), 'kind': 'remember', 'fact': 'A temporary test fact'}
        assert (await sync.command(c))['ok']
        assert (await sync.command(c))['ok'] and len(store.recall()) == 1
        memory = store.recall()[0]
        assert not (await sync.command({'id': str(uuid.uuid4()), 'kind': 'forget', 'memory_id': memory['id'], 'expected': 'Stale fact'}))['ok']
        assert len(store.recall()) == 1
        assert (await sync.command({'id': str(uuid.uuid4()), 'kind': 'forget', 'memory_id': memory['id'], 'expected': memory['fact']}))['ok']
        assert (await sync.command(c))['ok'] and not store.recall(), 'Replay must not recreate forgotten memories'
        bad = await sync.command({'id': str(uuid.uuid4()), 'kind': 'remember', 'fact': 'password: no'})
        assert not bad['ok'] and not store.recall()
        for value in ({'revision': True}, {'revision': 1, 'prompt': 'x'*6001, 'weatherCity': 'Melbourne', 'connectors': []}):
            try: sync.validate_config(value)
            except ValueError: pass
            else: raise AssertionError('Invalid configuration accepted')
        preferences = sync.validate_config({'revision': 1, 'prompt': 'Use short answers.', 'weatherCity': 'Geelong', 'connectors': []})
        cfg = session_config(store, preferences=preferences)['session']
        assert 'Use short answers.' in cfg['instructions'] and 'Geelong' in cfg['instructions']
        assert 'read-only' in cfg['instructions']
        class Socket:
            async def send_json(self, event):
                assert event['session']['type'] == 'realtime'
                assert event['session']['instructions'] and event['session']['tools']
                relay.active.config_update[1].set_result(True)
        ready = asyncio.Event()
        ready.set()
        relay.active = SimpleNamespace(openai=Socket(), session_ready=ready, vad_mode='auto')
        await sync.update_session()
        store.db.close()

    # Device weather endpoint is authenticated and does not create a voice session.
    class FakeWeather:
        async def fetch(self, http, city):
            assert city == 'Melbourne'
            return {'card': {'city': city}}
    r = object.__new__(Relay)
    r.config = {'token': 'test-token', 'device': 'test-device'}
    r.cloud, r.http, r.active, r.weather = None, None, None, FakeWeather()
    app = web.Application()
    app.router.add_get('/weather', r.weather_app)
    async with TestClient(TestServer(app)) as client:
        assert (await client.get('/weather')).status == 403
        response = await client.get('/weather', headers={'Authorization': 'Bearer test-token', 'Device-Id': 'test-device'})
        assert response.status == 200 and (await response.json())['city'] == 'Melbourne'
        assert r.active is None
    print('PASS: idempotent memory commands, validation, prompt configuration, silent authenticated weather')

asyncio.run(check())
