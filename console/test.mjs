import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHandler, createStore } from './api/index.mjs';

const adminCode = 'admin-code-' + 'a'.repeat(32);
const sessionSecret = 'session-secret-' + 's'.repeat(32);
const relayToken = 'relay-token-' + 'r'.repeat(32);
const encryptionKey = randomBytes(32).toString('base64');
const baseEnv = { ORBIT_ADMIN_CODE: adminCode, ORBIT_SESSION_SECRET: sessionSecret, ORBIT_RELAY_TOKEN: relayToken, ORBIT_ENCRYPTION_KEY: encryptionKey };

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function call(origin, path, { method = 'GET', body, cookie = '', authorization = '', originHeader = origin } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(JSON.stringify(body));
  }
  if (cookie) headers.cookie = cookie;
  if (authorization) headers.authorization = authorization;
  if (originHeader !== null) headers.origin = originHeader;
  const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, json, text };
}

function cookieFrom(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'login must set a cookie');
  return value.split(';', 1)[0];
}

function configBody(revisionNumber, overrides = {}) {
  return {
    revision: revisionNumber,
    prompt: '',
    weatherCity: 'Melbourne',
    connectors: [],
    ...overrides,
  };
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-console-'));
  const env = { ...baseEnv, LOCAL_STORE_DIR: directory };
  const store = createStore(env);
  const serverInfo = await listen(createHandler({ env, store }));
  const { origin } = serverInfo;
  let cookie;
  try {
    let result = await call(origin, '/api/state');
    assert.equal(result.response.status, 401);

    result = await call(origin, '/api/login', { method: 'POST', body: { code: adminCode }, originHeader: null });
    assert.equal(result.response.status, 403);

    result = await call(origin, '/api/login', { method: 'POST', body: { code: 'wrong' } });
    assert.equal(result.response.status, 401);

    result = await call(origin, '/api/login', { method: 'POST', body: { code: adminCode } });
    assert.equal(result.response.status, 200);
    const setCookie = result.response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Max-Age=28800/);
    cookie = cookieFrom(result.response);

    result = await call(origin, '/api/state', { cookie });
    assert.deepEqual(result.json.config, { revision: 0, prompt: '', weatherCity: 'Melbourne', connectors: [] });
    assert.deepEqual(result.json.snapshot, { updatedAt: null, appliedRevision: 0, connected: false, memories: [], notes: [], connectors: [], commandResults: [] });
    assert.deepEqual(result.json.commands, []);

    const privateToken = 'private-connector-token';
    const connector = { id: 'calendar', name: 'Calendar', url: 'https://calendar.example/mcp', enabled: true, allowedTools: ['list_events'], token: privateToken };
    result = await call(origin, '/api/config', { method: 'PUT', cookie, body: configBody(0, { prompt: 'Be concise', connectors: [connector] }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.config.connectors[0].hasToken, true);
    assert.equal('token' in result.json.config.connectors[0], false);
    assert.equal(JSON.stringify(result.json).includes(privateToken), false);

    const storedConfig = await readFile(join(directory, 'orbit', 'config.json'), 'utf8');
    assert.equal(storedConfig.includes(privateToken), false);
    assert.equal(storedConfig.includes('v1:'), true);

    result = await call(origin, '/api/config', { method: 'PUT', cookie, body: configBody(0, { connectors: [connector] }) });
    assert.equal(result.response.status, 409);
    assert.equal(JSON.stringify(result.json).includes(privateToken), false);

    result = await call(origin, '/api/config', { method: 'PUT', cookie, originHeader: `${origin}/wrong`, body: configBody(1, { connectors: [connector] }) });
    assert.equal(result.response.status, 403);

    const unchangedConnector = { ...connector };
    delete unchangedConnector.token;
    result = await call(origin, '/api/config', { method: 'PUT', cookie, body: configBody(1, { connectors: [unchangedConnector] }) });
    assert.equal(result.response.status, 200);
    result = await call(origin, '/api/sync', { authorization: `Bearer ${relayToken}` });
    assert.equal(result.json.config.connectors[0].token, privateToken);

    const movedConnector = { ...unchangedConnector, url: 'https://new-calendar.example/mcp' };
    result = await call(origin, '/api/config', { method: 'PUT', cookie, body: configBody(2, { connectors: [movedConnector] }) });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.json.config.connectors[0].allowedTools, []);
    assert.equal(result.json.config.connectors[0].hasToken, false);
    result = await call(origin, '/api/sync', { authorization: `Bearer ${relayToken}` });
    assert.equal(result.json.config.connectors[0].token, '');

    const commandId = '11111111-1111-4111-8111-111111111111';
    const command = { id: commandId, kind: 'remember', fact: 'Keep this fact' };
    result = await call(origin, '/api/commands', { method: 'POST', cookie, body: command });
    assert.equal(result.response.status, 201);
    result = await call(origin, '/api/commands', { method: 'POST', cookie, body: command });
    assert.equal(result.response.status, 200);
    result = await call(origin, '/api/commands', { method: 'POST', cookie, body: { ...command, fact: 'Different fact' } });
    assert.equal(result.response.status, 409);
    result = await call(origin, '/api/commands', { method: 'POST', cookie, body: { id: 'not-a-uuid', kind: 'remember', fact: 'bad' } });
    assert.equal(result.response.status, 400);

    result = await call(origin, '/api/sync', { authorization: `Bearer ${relayToken}` });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.commands[0].fact, command.fact);
    assert.equal(JSON.stringify((await call(origin, '/api/state', { cookie })).json).includes(privateToken), false);

    const snapshot = {
      updatedAt: new Date().toISOString(),
      appliedRevision: 3,
      connected: true,
      memories: [{ id: 1, fact: 'Fact from relay' }],
      notes: [{ id: 1, text: 'Exact note', created_at: '2026-09-08 12:00:00' }],
      connectors: [{ id: 'calendar', status: 'ok', tools: [{ name: 'list_events', description: 'List events', readOnly: true }] }],
      commandResults: [{ id: commandId, ok: true }],
    };
    result = await call(origin, '/api/sync', { method: 'POST', authorization: `Bearer ${relayToken}`, body: snapshot });
    assert.equal(result.response.status, 200);
    result = await call(origin, '/api/sync', { authorization: `Bearer ${relayToken}` });
    assert.deepEqual(result.json.commands, []);
    result = await call(origin, '/api/state', { cookie });
    assert.deepEqual(result.json.snapshot.commandResults, [{ id: commandId, ok: true }]);
    assert.deepEqual(result.json.snapshot.notes, snapshot.notes);

    const tooManyNotes = { ...snapshot, notes: Array.from({ length: 11 }, (_, index) => ({ id: index + 1, text: 'note', created_at: snapshot.updatedAt })) };
    result = await call(origin, '/api/sync', { method: 'POST', authorization: `Bearer ${relayToken}`, body: tooManyNotes });
    assert.equal(result.response.status, 400);

    result = await call(origin, '/api/config', { method: 'PUT', cookie, body: configBody(3, { prompt: 'x'.repeat(6001) }) });
    assert.equal(result.response.status, 400);
    result = await call(origin, '/api/config', { method: 'PUT', cookie, body: configBody(3, { connectors: Array.from({ length: 11 }, (_, index) => ({ id: `c${index}`, name: 'C', url: 'https://example.com', enabled: true, allowedTools: [] })) }) });
    assert.equal(result.response.status, 400);

    const queued = [];
    for (let index = 0; index < 100; index += 1) {
      const id = randomUUID();
      queued.push(id);
      result = await call(origin, '/api/commands', { method: 'POST', cookie, body: { id, kind: 'remember', fact: `Queued ${index}` } });
      assert.equal(result.response.status, 201);
    }
    result = await call(origin, '/api/commands', { method: 'POST', cookie, body: command });
    assert.equal(result.response.status, 429, 'an acknowledged command is no longer pending');
    result = await call(origin, '/api/commands', { method: 'POST', cookie, body: { id: queued[0], kind: 'remember', fact: 'Queued 0' } });
    assert.equal(result.response.status, 200, 'pending duplicate remains idempotent while queue is full');
    result = await call(origin, '/api/commands', { method: 'POST', cookie, body: { id: randomUUID(), kind: 'remember', fact: 'overflow' } });
    assert.equal(result.response.status, 429);

    const acknowledgements = queued.map((id) => ({ id, ok: true }));
    result = await call(origin, '/api/sync', { method: 'POST', authorization: `Bearer ${relayToken}`, body: { ...snapshot, commandResults: acknowledgements } });
    assert.equal(result.response.status, 200);
    result = await call(origin, '/api/state', { cookie });
    assert.equal(result.json.commands.length, 0);
    assert.equal(result.json.snapshot.commandResults.length, 100);

    result = await call(origin, '/api/commands', { method: 'POST', cookie, body: { id: randomUUID(), kind: 'forget', memory_id: 1 } });
    assert.equal(result.response.status, 400, 'deletion needs the exact snapshot value to guard against reused IDs');
    const forgetId = randomUUID();
    result = await call(origin, '/api/commands', { method: 'POST', cookie, body: { id: forgetId, kind: 'forget', memory_id: 1, expected: 'Fact from relay' } });
    assert.equal(result.response.status, 201);
    result = await call(origin, '/api/sync', { authorization: `Bearer ${relayToken}` });
    assert.equal(result.json.commands[0].expected, 'Fact from relay');

    result = await call(origin, '/api/logout', { method: 'POST', cookie });
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('set-cookie'), /Max-Age=0/);
    result = await call(origin, '/api/state', { cookie: cookieFrom(result.response) });
    assert.equal(result.response.status, 401);

    await close(serverInfo.server);

    const raceDirectory = await mkdtemp(join(tmpdir(), 'orbit-console-race-'));
    const raceEnv = { ...baseEnv, LOCAL_STORE_DIR: raceDirectory };
    const first = await listen(createHandler({ env: raceEnv, store: createStore(raceEnv) }));
    const second = await listen(createHandler({ env: raceEnv, store: createStore(raceEnv) }));
    try {
      const firstLogin = await call(first.origin, '/api/login', { method: 'POST', body: { code: adminCode } });
      const secondLogin = await call(second.origin, '/api/login', { method: 'POST', body: { code: adminCode } });
      const firstCookie = cookieFrom(firstLogin.response);
      const secondCookie = cookieFrom(secondLogin.response);
      const writes = await Promise.all([
        call(first.origin, '/api/config', { method: 'PUT', cookie: firstCookie, body: configBody(0, { prompt: 'first' }) }),
        call(second.origin, '/api/config', { method: 'PUT', cookie: secondCookie, body: configBody(0, { prompt: 'second' }) }),
      ]);
      assert.deepEqual(writes.map(({ response }) => response.status).sort(), [200, 409]);
      const finalState = await call(first.origin, '/api/state', { cookie: firstCookie });
      assert.equal(finalState.json.config.revision, 1);
      assert.ok(['first', 'second'].includes(finalState.json.config.prompt));
    } finally {
      await close(first.server);
      await close(second.server);
      await rm(raceDirectory, { recursive: true, force: true });
    }
  } finally {
    if (serverInfo.server.listening) await close(serverInfo.server);
    await rm(directory, { recursive: true, force: true });
  }
  process.stdout.write('PASS: Orbit console auth, CSRF, encrypted config, CAS, bounded queue, sync validation, and snapshot acknowledgements\n');
}

await main();
