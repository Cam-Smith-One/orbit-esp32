"""Outbound-only configuration sync. Audio never passes through the dashboard."""
import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

import aiohttp

LOG = logging.getLogger('orbit')


class CloudSync:
    def __init__(self, relay, path):
        self.relay, self.path = relay, path
        self.preferences = {'revision': 0, 'prompt': '', 'weatherCity': 'Melbourne', 'connectors': []}
        self.tools, self.routes, self.connector_status = [], {}, []
        self.client = None
        self.last_post = 0
        self.last_snapshot = ''
        self.session_dirty = False
        self.relay.store.db.execute('CREATE TABLE IF NOT EXISTS cloud_commands (id TEXT PRIMARY KEY, result TEXT NOT NULL)')
        self.relay.store.db.execute('CREATE TABLE IF NOT EXISTS orbit_config (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)')
        saved = self.relay.store.db.execute('SELECT body FROM orbit_config WHERE id=1').fetchone()
        if saved:
            self.preferences = self.validate_config(json.loads(saved[0]))

    @staticmethod
    def validate_config(value):
        if not isinstance(value, dict) or type(value.get('revision')) is not int or value['revision'] < 0:
            raise ValueError('Invalid configuration revision')
        if not isinstance(value.get('prompt'), str) or len(value['prompt']) > 6000:
            raise ValueError('Invalid prompt')
        if not isinstance(value.get('weatherCity'), str) or not 1 <= len(value['weatherCity'].strip()) <= 100:
            raise ValueError('Invalid weather city')
        connections = value.get('connectors', [])
        if not isinstance(connections, list) or len(connections) > 10:
            raise ValueError('Too many connectors')
        ids = set()
        for c in connections:
            if not isinstance(c, dict): raise ValueError('Invalid connector')
            for field, limit in [('id', 80), ('name', 80), ('url', 2048)]:
                if not isinstance(c.get(field), str) or not 1 <= len(c[field]) <= limit:
                    raise ValueError('Invalid connector field')
            if c['id'] in ids: raise ValueError('Duplicate connector')
            ids.add(c['id'])
            url = urlsplit(c['url'])
            if url.scheme != 'https' or not url.hostname or url.username or url.password or url.fragment:
                raise ValueError('Invalid connector URL')
            if type(c.get('enabled')) is not bool: raise ValueError('Invalid connector enablement')
            if not isinstance(c.get('token', ''), str) or len(c.get('token', '')) > 4096:
                raise ValueError('Invalid connector token')
            if not isinstance(c.get('allowedTools'), list) or len(c['allowedTools']) > 50:
                raise ValueError('Invalid approved tools')
            if any(not isinstance(n, str) or not 1 <= len(n) <= 128 for n in c['allowedTools']):
                raise ValueError('Invalid approved tool name')
        return {k: value[k] for k in ('revision', 'prompt', 'weatherCity', 'connectors')}

    async def discover(self):
        if self.client is None:
            from mcp_client import MCPClient
            # The MCP client owns a public-DNS-only connection pool; never reuse the LAN audio pool.
            self.client = MCPClient()
        self.tools, self.routes, self.connector_status = [], {}, []
        remaining = 100
        for c in self.preferences['connectors']:
            status = {'id': c['id'], 'status': 'Disabled', 'tools': []}
            if c['enabled']:
                try:
                    found = await self.client.discover(c)
                    status['tools'] = [{'name': t['name'], 'description': t.get('description', '')[:200],
                                        'readOnly': t.get('readOnly') is True} for t in found[:remaining]]
                    remaining -= len(status['tools'])
                    status['status'] = 'Connected'
                    for t in found:
                        if t.get('readOnly') is not True or t['name'] not in c['allowedTools']: continue
                        if len(self.tools) >= 40: break
                        name = 'mcp_' + hashlib.sha256((c['id'] + ':' + t['name']).encode()).hexdigest()[:24]
                        self.routes[name] = (c['id'], t['name'])
                        self.tools.append({'type': 'function', 'name': name,
                            'description': f"Read-only {c['name']}: {t.get('description', t['name'])}"[:1000],
                            'parameters': t['inputSchema']})
                except Exception as error:
                    status['status'] = 'Connection failed: ' + type(error).__name__
            self.connector_status.append(status)

    async def call(self, name, args):
        route = self.routes.get(name)
        if route is None or self.client is None: raise ValueError('Connected tool unavailable')
        connector = next((c for c in self.preferences['connectors'] if c['id'] == route[0]), None)
        if not connector or not connector['enabled'] or route[1] not in connector['allowedTools']:
            raise ValueError('Connected tool disabled')
        return await self.client.call(connector, route[1], args)

    async def command(self, c):
        if not isinstance(c, dict) or not isinstance(c.get('id'), str): raise ValueError('Invalid command')
        uuid.UUID(c['id'])
        db = self.relay.store.db
        saved = db.execute('SELECT result FROM cloud_commands WHERE id=?', (c['id'],)).fetchone()
        if saved: return json.loads(saved[0])
        result = {'id': c['id'], 'ok': True}
        try:
            kind = c.get('kind')
            if kind == 'test_connector':
                connector = next((x for x in self.preferences['connectors'] if x['id'] == c.get('connector_id')), None)
                if connector is None: raise ValueError('Connector not found')
                if not connector['enabled']: raise ValueError('Enable connector before testing')
                await self.discover()
                status = next(x for x in self.connector_status if x['id'] == connector['id'])
                if status['status'] != 'Connected': raise ValueError('Connector test failed')
            else:
                # Mutation and acknowledgement share one transaction: retries cannot recreate a deleted fact.
                with db:
                    if kind == 'remember':
                        fact = c.get('fact')
                        if not isinstance(fact, str) or not 1 <= len(fact.strip()) <= 500:
                            raise ValueError('Memory must contain 1-500 characters')
                        if any(x in fact.lower() for x in ('sk-proj-', 'api key', 'password', 'secret key')):
                            raise ValueError('Do not store credentials')
                        db.execute('INSERT OR IGNORE INTO memories(fact) VALUES (?)', (fact.strip(),))
                    elif kind in ('forget', 'delete_note'):
                        key = 'memory_id' if kind == 'forget' else 'note_id'
                        ident = c.get(key)
                        if type(ident) is not int or ident < 1: raise ValueError('Invalid record ID')
                        table = 'memories' if kind == 'forget' else 'notes'
                        field = 'fact' if kind == 'forget' else 'text'
                        expected = c.get('expected')
                        if not isinstance(expected, str) or not expected: raise ValueError('Missing record precondition')
                        row = db.execute(f'SELECT {field} FROM {table} WHERE id=?', (ident,)).fetchone()
                        if row and row[0] != expected: raise ValueError('Record changed; refresh before deleting')
                        db.execute(f'DELETE FROM {table} WHERE id=?', (ident,))
                    else: raise ValueError('Unknown command')
                    db.execute('INSERT INTO cloud_commands VALUES (?,?)', (c['id'], json.dumps(result)))
                return result
        except (ValueError, TypeError) as error:
            result = {'id': c['id'], 'ok': False, 'error': str(error)[:160]}
        with db:
            db.execute('INSERT INTO cloud_commands VALUES (?,?)', (c['id'], json.dumps(result)))
        return result

    async def update_session(self):
        active = self.relay.active
        if active and active.openai and active.session_ready.is_set():
            from server import session_config
            cfg = session_config(self.relay.store, active.vad_mode, self.preferences, self.tools)['session']
            pending = asyncio.get_running_loop().create_future()
            active.config_update = (cfg['instructions'], pending)
            try:
                await active.openai.send_json({'type': 'session.update', 'session': {
                    'type': 'realtime', 'instructions': cfg['instructions'], 'tools': cfg['tools']}})
                await asyncio.wait_for(pending, 10)
            finally:
                active.config_update = None

    async def once(self, config):
        url = config['url'].rstrip('/')
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Cloud URL must be HTTPS')
        headers = {'Authorization': 'Bearer ' + config['token']}
        if config.get('deploymentBypass'):
            headers['x-vercel-protection-bypass'] = config['deploymentBypass']
        async with self.relay.http.get(url + '/api/sync', headers=headers, allow_redirects=False,
                                      timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status != 200: raise ValueError('Cloud sync rejected')
            raw = bytearray()
            async for chunk in r.content.iter_chunked(8192):
                raw.extend(chunk)
                if len(raw) > 524288: raise ValueError('Cloud response too large')
            data = json.loads(raw)
        preferences = self.validate_config(data['config'])
        changed = preferences != self.preferences
        if preferences['revision'] < self.preferences['revision']: raise ValueError('Stale cloud revision')
        if changed:
            self.session_dirty = True
            self.preferences = preferences
            with self.relay.store.db:
                self.relay.store.db.execute('INSERT OR REPLACE INTO orbit_config VALUES (1,?)', (json.dumps(preferences),))
            await self.discover()
        commands = data.get('commands', [])
        if not isinstance(commands, list) or len(commands) > 100: raise ValueError('Too many queued commands')
        for command in commands: await self.command(command)
        if commands: self.session_dirty = True
        if self.session_dirty:
            await self.update_session()
            self.session_dirty = False
        db = self.relay.store.db
        snapshot = {'appliedRevision': self.preferences['revision'], 'connected': bool(self.relay.active),
                    'memories': [dict(r) for r in db.execute('SELECT * FROM memories ORDER BY id DESC LIMIT 100')],
                    'notes': [dict(r) for r in db.execute('SELECT * FROM notes ORDER BY id DESC LIMIT 10')],
                    'connectors': self.connector_status,
                    'commandResults': [json.loads(r[0]) for r in db.execute('SELECT result FROM cloud_commands ORDER BY rowid DESC LIMIT 100')]}
        digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
        if digest != self.last_snapshot or time.monotonic() - self.last_post >= 60:
            snapshot['updatedAt'] = datetime.now(timezone.utc).isoformat()
            async with self.relay.http.post(url + '/api/sync', json=snapshot, headers=headers, allow_redirects=False,
                                           timeout=aiohttp.ClientTimeout(total=15)) as r:
                if r.status != 200: raise ValueError('Cloud status rejected')
            self.last_post, self.last_snapshot = time.monotonic(), digest

    async def run(self):
        try:
            await self.discover()
            while True:
                try:
                    if os.getenv('ORBIT_PUBLIC_URL'):
                        await self.once({'url': os.environ['ORBIT_CONSOLE_URL'],
                                         'token': os.environ['ORBIT_CONSOLE_TOKEN'],
                                         'deploymentBypass': os.getenv('ORBIT_CONSOLE_BYPASS', '')})
                    elif self.path.exists():
                        await self.once(json.loads(self.path.read_text()))
                except Exception as error:
                    LOG.warning('Cloud sync unavailable: %s', type(error).__name__)
                await asyncio.sleep(30)
        finally:
            if self.client:
                await self.client.close()
