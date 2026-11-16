import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BlobStore,
  LocalStore,
  StorageAlreadyExistsError,
  StoragePreconditionError,
} from '../lib/store.mjs';

const FILE = fileURLToPath(import.meta.url);
const CONSOLE_DIR = resolve(FILE, '../../');
const PUBLIC_DIR = resolve(CONSOLE_DIR, 'public');
const CONFIG_PATH = 'orbit/config.json';
const SNAPSHOT_PATH = 'orbit/snapshot.json';
const COMMAND_PREFIX = 'orbit/commands/';
const MAX_BODY_BYTES = 128 * 1024;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_PENDING_COMMANDS = 100;
const SESSION_SECONDS = 8 * 60 * 60;
const COOKIE_NAME = 'orbit_session';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const STATIC_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export class HTTPError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = 'HTTPError';
    this.status = status;
    this.headers = headers;
  }
}

class QueueOverflowError extends Error {
  constructor() {
    super('Command queue overflow');
    this.name = 'QueueOverflowError';
  }
}

const invalid = () => new HTTPError(400, 'Invalid request');
const unauthorized = () => new HTTPError(401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
const forbidden = () => new HTTPError(403, 'Forbidden');
const conflict = (message = 'Conflict') => new HTTPError(409, message);
const serverConfig = () => new HTTPError(500, 'Server configuration error');

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, keys) {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key))) throw invalid();
}

function boundedString(value, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000')) throw invalid();
  const result = value.trim();
  if (!allowEmpty && !result) throw invalid();
  return result;
}

function rawBoundedString(value, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\u0000') || (!allowEmpty && !value)) throw invalid();
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}

function connectorId(value) {
  const result = boundedString(value, 64);
  if (!CONNECTOR_ID_RE.test(result)) throw invalid();
  return result;
}

function uuid(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw invalid();
  return value.toLowerCase();
}

function connectorUrl(value) {
  const result = boundedString(value, 2048);
  let parsed;
  try {
    parsed = new URL(result);
  } catch {
    throw invalid();
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw invalid();
  return result;
}

function allowedTools(value) {
  if (!Array.isArray(value) || value.length > 50) throw invalid();
  const result = value.map((toolName) => boundedString(toolName, 128));
  if (new Set(result).size !== result.length) throw invalid();
  return result;
}

function configConnector(value, { stored = false } = {}) {
  exactKeys(value, stored ? ['id', 'name', 'url', 'enabled', 'allowedTools', 'token'] : ['id', 'name', 'url', 'enabled', 'allowedTools', 'token']);
  if (!has(value, 'id') || !has(value, 'name') || !has(value, 'url') || !has(value, 'enabled') || !has(value, 'allowedTools')) throw invalid();
  const result = {
    id: connectorId(value.id),
    name: boundedString(value.name, 80),
    url: connectorUrl(value.url),
    enabled: value.enabled,
    allowedTools: allowedTools(value.allowedTools),
  };
  if (typeof result.enabled !== 'boolean') throw invalid();
  if (has(value, 'token')) {
    if (stored) result.token = rawBoundedString(value.token, 20000, true);
    else result.token = rawBoundedString(value.token, 4096, true);
  }
  return result;
}

function validateConfigInput(value) {
  exactKeys(value, ['revision', 'prompt', 'weatherCity', 'connectors']);
  if (!has(value, 'revision') || !has(value, 'prompt') || !has(value, 'weatherCity') || !has(value, 'connectors')) throw invalid();
  if (!Array.isArray(value.connectors) || value.connectors.length > 10) throw invalid();
  const connectors = value.connectors.map((connector) => configConnector(connector));
  if (new Set(connectors.map(({ id }) => id)).size !== connectors.length) throw invalid();
  return {
    revision: revision(value.revision),
    prompt: boundedString(value.prompt, 6000, true),
    weatherCity: boundedString(value.weatherCity, 100),
    connectors,
  };
}

function defaultConfig() {
  return { revision: 0, prompt: '', weatherCity: 'Melbourne', connectors: [] };
}

function validateStoredConfig(value) {
  exactKeys(value, ['revision', 'prompt', 'weatherCity', 'connectors']);
  if (!has(value, 'revision') || !has(value, 'prompt') || !has(value, 'weatherCity') || !has(value, 'connectors')) throw new Error('Invalid stored config');
  try {
    if (!Array.isArray(value.connectors) || value.connectors.length > 10) throw new Error('Invalid stored config');
    const connectors = value.connectors.map((connector) => configConnector(connector, { stored: true }));
    if (new Set(connectors.map(({ id }) => id)).size !== connectors.length) throw new Error('Invalid stored config');
    return {
      revision: revision(value.revision),
      prompt: boundedString(value.prompt, 6000, true),
      weatherCity: boundedString(value.weatherCity, 100),
      connectors,
    };
  } catch {
    throw new Error('Invalid stored config');
  }
}

function publicConfig(config) {
  return {
    revision: config.revision,
    prompt: config.prompt,
    weatherCity: config.weatherCity,
    connectors: config.connectors.map(({ id, name, url, enabled, allowedTools, token }) => ({
      id,
      name,
      url,
      enabled,
      allowedTools,
      hasToken: Boolean(token),
    })),
  };
}

function machineConfig(config, env) {
  return {
    revision: config.revision,
    prompt: config.prompt,
    weatherCity: config.weatherCity,
    connectors: config.connectors.map(({ id, name, url, enabled, allowedTools, token }) => ({
      id,
      name,
      url,
      enabled,
      allowedTools,
      token: token ? decryptToken(token, env) : '',
    })),
  };
}

function timestamp(value, fallback = null) {
  if (value === undefined) return fallback ?? new Date().toISOString();
  if (value === null) return null;
  const result = rawBoundedString(value, 80);
  if (!Number.isFinite(Date.parse(result))) throw invalid();
  return result;
}

function commandResults(value) {
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  const results = value.map((result) => {
    exactKeys(result, ['id', 'ok', 'error']);
    if (!has(result, 'id') || !has(result, 'ok') || typeof result.ok !== 'boolean') throw invalid();
    const normalized = { id: uuid(result.id), ok: result.ok };
    if (has(result, 'error')) normalized.error = boundedString(result.error, 512, false);
    return normalized;
  });
  if (new Set(results.map(({ id }) => id)).size !== results.length) throw invalid();
  return results;
}

function mergeCommandResults(first, second) {
  const merged = new Map(first.map((result) => [result.id, result]));
  for (const result of second) merged.set(result.id, result);
  return [...merged.values()].slice(-100);
}

function snapshotConnector(value) {
  exactKeys(value, ['id', 'status', 'tools']);
  if (!has(value, 'id') || !has(value, 'status') || !has(value, 'tools') || !Array.isArray(value.tools)) throw invalid();
  if (value.tools.length > 100) throw invalid();
  const tools = value.tools.map((tool) => {
    exactKeys(tool, ['name', 'description', 'readOnly']);
    if (!has(tool, 'name') || !has(tool, 'description') || !has(tool, 'readOnly') || typeof tool.readOnly !== 'boolean') throw invalid();
    return {
      name: boundedString(tool.name, 128),
      description: boundedString(tool.description, 500, true),
      readOnly: tool.readOnly,
    };
  });
  return { id: connectorId(value.id), status: boundedString(value.status, 64), tools };
}

function snapshotValue(value, previous = defaultSnapshot(), resultOverride = undefined) {
  exactKeys(value, ['updatedAt', 'appliedRevision', 'connected', 'memories', 'notes', 'connectors', 'commandResults']);
  const memoriesValue = has(value, 'memories') ? value.memories : previous.memories;
  const notesValue = has(value, 'notes') ? value.notes : previous.notes;
  const connectorsValue = has(value, 'connectors') ? value.connectors : previous.connectors;
  if (!Array.isArray(memoriesValue) || memoriesValue.length > 100 || !Array.isArray(notesValue) || notesValue.length > 10 || !Array.isArray(connectorsValue) || connectorsValue.length > 10) throw invalid();

  const memories = memoriesValue.map((memory) => {
    exactKeys(memory, ['id', 'fact']);
    if (!has(memory, 'id') || !has(memory, 'fact')) throw invalid();
    return { id: positiveInteger(memory.id), fact: boundedString(memory.fact, 500) };
  });
  const notes = notesValue.map((note) => {
    exactKeys(note, ['id', 'text', 'created_at']);
    if (!has(note, 'id') || !has(note, 'text') || !has(note, 'created_at')) throw invalid();
    return { id: positiveInteger(note.id), text: boundedString(note.text, 4000), created_at: rawBoundedString(note.created_at, 80) };
  });
  const connectors = connectorsValue.map(snapshotConnector);
  if (connectors.reduce((total, connector) => total + connector.tools.length, 0) > 100) throw invalid();
  const results = resultOverride ?? (has(value, 'commandResults') ? commandResults(value.commandResults) : previous.commandResults);
  if (!Array.isArray(results) || results.length > 100) throw invalid();
  if (has(value, 'connected') && typeof value.connected !== 'boolean') throw invalid();
  return {
    updatedAt: timestamp(value.updatedAt, previous.updatedAt),
    appliedRevision: has(value, 'appliedRevision') ? revision(value.appliedRevision) : previous.appliedRevision,
    connected: has(value, 'connected') ? value.connected : previous.connected,
    memories,
    notes,
    connectors,
    commandResults: results,
  };
}

function defaultSnapshot() {
  return { updatedAt: null, appliedRevision: 0, connected: false, memories: [], notes: [], connectors: [], commandResults: [] };
}

function validateStoredSnapshot(value) {
  try {
    if (!isObject(value)) throw new Error('Invalid stored snapshot');
    const result = snapshotValue(value, defaultSnapshot());
    if (typeof result.connected !== 'boolean') throw new Error('Invalid stored snapshot');
    return result;
  } catch {
    throw new Error('Invalid stored snapshot');
  }
}

function commandInput(value) {
  exactKeys(value, ['id', 'kind', 'fact', 'memory_id', 'note_id', 'connector_id', 'expected']);
  if (!has(value, 'id') || !has(value, 'kind') || typeof value.kind !== 'string') throw invalid();
  const id = uuid(value.id);
  const result = { id, kind: value.kind };
  if (value.kind === 'remember') {
    if (!has(value, 'fact') || has(value, 'memory_id') || has(value, 'note_id') || has(value, 'connector_id')) throw invalid();
    result.fact = boundedString(value.fact, 500);
  } else if (value.kind === 'forget') {
    if (!has(value, 'memory_id') || has(value, 'fact') || has(value, 'note_id') || has(value, 'connector_id')) throw invalid();
    result.memory_id = positiveInteger(value.memory_id);
  } else if (value.kind === 'delete_note') {
    if (!has(value, 'note_id') || has(value, 'fact') || has(value, 'memory_id') || has(value, 'connector_id')) throw invalid();
    result.note_id = positiveInteger(value.note_id);
  } else if (value.kind === 'test_connector') {
    if (!has(value, 'connector_id') || has(value, 'fact') || has(value, 'memory_id') || has(value, 'note_id')) throw invalid();
    result.connector_id = connectorId(value.connector_id);
  } else {
    throw invalid();
  }
  if (value.kind === 'forget' || value.kind === 'delete_note') {
    result.expected = rawBoundedString(value.expected, value.kind === 'forget' ? 500 : 4000);
    if (!result.expected) throw invalid();
  } else if (has(value, 'expected')) throw invalid();
  return result;
}

function storedCommand(value) {
  exactKeys(value, ['id', 'kind', 'fact', 'memory_id', 'note_id', 'connector_id', 'expected', 'createdAt', 'status']);
  const payload = {
    id: value.id,
    kind: value.kind,
    ...(has(value, 'fact') ? { fact: value.fact } : {}),
    ...(has(value, 'memory_id') ? { memory_id: value.memory_id } : {}),
    ...(has(value, 'note_id') ? { note_id: value.note_id } : {}),
    ...(has(value, 'connector_id') ? { connector_id: value.connector_id } : {}),
    ...(has(value, 'expected') ? { expected: value.expected } : {}),
  };
  let result;
  try {
    result = commandInput(payload);
    const createdAt = rawBoundedString(value.createdAt, 80);
    if (!Number.isFinite(Date.parse(createdAt)) || (has(value, 'status') && value.status !== 'pending')) throw new Error('Invalid stored command');
    return { ...result, createdAt, status: 'pending' };
  } catch {
    throw new Error('Invalid stored command');
  }
}

function commandPayload(command) {
  return {
    id: command.id,
    kind: command.kind,
    ...(has(command, 'fact') ? { fact: command.fact } : {}),
    ...(has(command, 'memory_id') ? { memory_id: command.memory_id } : {}),
    ...(has(command, 'note_id') ? { note_id: command.note_id } : {}),
    ...(has(command, 'connector_id') ? { connector_id: command.connector_id } : {}),
    ...(has(command, 'expected') ? { expected: command.expected } : {}),
  };
}

function sameCommand(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commandPath(id) {
  return `${COMMAND_PREFIX}${id}.json`;
}

async function loadConfig(store) {
  const record = await store.get(CONFIG_PATH);
  return record ? { value: validateStoredConfig(record.value), etag: record.etag } : { value: defaultConfig(), etag: undefined };
}

async function loadSnapshot(store) {
  const record = await store.get(SNAPSHOT_PATH);
  return record ? { value: validateStoredSnapshot(record.value), etag: record.etag } : { value: defaultSnapshot(), etag: undefined };
}

async function loadCommands(store) {
  const entries = await store.list(COMMAND_PREFIX);
  const records = [];
  for (const entry of entries) {
    const record = await store.get(entry.pathname);
    if (!record) continue;
    records.push({ pathname: entry.pathname, value: storedCommand(record.value), etag: record.etag });
  }
  records.sort((left, right) => left.value.createdAt.localeCompare(right.value.createdAt) || left.value.id.localeCompare(right.value.id));
  // Concurrent serverless enqueues can exceed the cap; drain in bounded batches, never wedge the queue.
  return records.slice(0, MAX_PENDING_COMMANDS);
}

function uiCommand(command) {
  return { id: command.id, kind: command.kind, status: command.status };
}

function environmentSecret(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length < 32) throw serverConfig();
  return value;
}

function encryptionKey(env) {
  const encoded = env.ORBIT_ENCRYPTION_KEY;
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw serverConfig();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw serverConfig();
  return key;
}

function encryptToken(token, env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptToken(value, env) {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted token');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error('Invalid encrypted token');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(env), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function textEqual(left, right) {
  const a = createHash('sha256').update(String(left)).digest();
  const b = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(a, b);
}

function sessionSignature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function sessionCookie(env) {
  const secret = environmentSecret(env, 'ORBIT_SESSION_SECRET');
  const payload = Buffer.from(JSON.stringify({ sub: 'admin', exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, nonce: randomBytes(16).toString('base64url') })).toString('base64url');
  return `${COOKIE_NAME}=${payload}.${sessionSignature(payload, secret)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function cookies(request) {
  const header = request.headers?.cookie;
  if (typeof header !== 'string') return new Map();
  return new Map(header.split(';').map((part) => part.trim().split('=').map((value) => value.trim())).filter(([key, value]) => key && value));
}

function adminAuthorized(request, env) {
  const cookie = cookies(request).get(COOKIE_NAME);
  if (!cookie) throw unauthorized();
  const separator = cookie.lastIndexOf('.');
  if (separator < 1) throw unauthorized();
  const payload = cookie.slice(0, separator);
  const signature = cookie.slice(separator + 1);
  const secret = environmentSecret(env, 'ORBIT_SESSION_SECRET');
  if (!textEqual(signature, sessionSignature(payload, secret))) throw unauthorized();
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw unauthorized();
  }
  if (!isObject(claims) || claims.sub !== 'admin' || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) throw unauthorized();
}

function machineAuthorized(request, env) {
  const token = environmentSecret(env, 'ORBIT_RELAY_TOKEN');
  if (!textEqual(request.headers?.authorization ?? '', `Bearer ${token}`)) throw unauthorized();
}

function requestOrigin(request) {
  const host = request.headers?.host;
  if (typeof host !== 'string' || !host || /[\r\n]/.test(host)) throw forbidden();
  const forwarded = typeof request.headers?.['x-forwarded-proto'] === 'string' ? request.headers['x-forwarded-proto'].split(',')[0].trim() : '';
  const protocol = forwarded || (request.socket?.encrypted ? 'https' : 'http');
  if (protocol !== 'http' && protocol !== 'https') throw forbidden();
  return `${protocol}://${host}`;
}

function sameOrigin(request) {
  if (request.headers?.origin !== requestOrigin(request)) throw forbidden();
}

function contentLength(request, maximum = MAX_BODY_BYTES) {
  const value = request.headers?.['content-length'];
  if (value === undefined) return;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw new HTTPError(413, 'Request body too large');
}

async function jsonBody(request, maximum = MAX_BODY_BYTES) {
  contentLength(request, maximum);
  const contentType = request.headers?.['content-type'];
  if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new HTTPError(415, 'JSON required');
  if (request.body !== undefined) {
    const serialized = Buffer.isBuffer(request.body) ? request.body : Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
    if (serialized.length > maximum) throw new HTTPError(413, 'Request body too large');
    try {
      return JSON.parse(serialized.toString('utf8'));
    } catch {
      throw invalid();
    }
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.byteLength ?? chunk.length;
    if (length > maximum) throw new HTTPError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw invalid();
  }
}

function baseHeaders(res, contentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'") {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function jsonResponse(res, status, value, headers = {}) {
  baseHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [key, headerValue] of Object.entries(headers)) res.setHeader(key, headerValue);
  res.end(JSON.stringify(value));
}

function storagePrecondition(error) {
  return error instanceof StoragePreconditionError || error?.name === 'BlobPreconditionFailedError';
}

function storageAlreadyExists(error) {
  return error instanceof StorageAlreadyExistsError || /AlreadyExists|BlobAlreadyExists/i.test(error?.name ?? '');
}

async function staticResponse(request, response, publicDirectory) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new HTTPError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://orbit.local').pathname);
  } catch {
    throw invalid();
  }
  if (!pathname.startsWith('/') || pathname.includes('\u0000') || pathname.includes('\\')) throw new HTTPError(404, 'Not found');
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const parts = relativePath.split('/');
  if (!relativePath || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new HTTPError(404, 'Not found');
  const extension = extname(relativePath).toLowerCase();
  if (!STATIC_TYPES[extension]) throw new HTTPError(404, 'Not found');
  const file = resolve(publicDirectory, relativePath);
  if (file !== publicDirectory && !file.startsWith(`${publicDirectory}/`)) throw new HTTPError(404, 'Not found');
  let details;
  try {
    details = await stat(file);
  } catch {
    throw new HTTPError(404, 'Not found');
  }
  if (!details.isFile() || details.size > 8 * 1024 * 1024) throw new HTTPError(404, 'Not found');
  baseHeaders(response, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.statusCode = 200;
  response.setHeader('Content-Type', STATIC_TYPES[extension]);
  response.setHeader('Content-Length', details.size);
  response.end(request.method === 'HEAD' ? undefined : await readFile(file));
}

export function createStore(env = process.env) {
  if (env.VERCEL) {
    if (env.LOCAL_STORE_DIR) throw new Error('LOCAL_STORE_DIR is not allowed on Vercel');
    return new BlobStore();
  }
  return new LocalStore(env.LOCAL_STORE_DIR || join(CONSOLE_DIR, '.local-store'));
}

export function createHandler({ env = process.env, store = undefined, serveStatic = false, publicDir = PUBLIC_DIR } = {}) {
  const durableStore = store || createStore(env);

  async function route(request, response) {
    let url;
    try {
      url = new URL(request.url, 'http://orbit.local');
    } catch {
      throw invalid();
    }
    const path = url.pathname;

    if (path === '/api/login') {
      if (request.method !== 'POST') throw new HTTPError(405, 'Method not allowed', { Allow: 'POST' });
      sameOrigin(request);
      const body = await jsonBody(request);
      exactKeys(body, ['code']);
      if (!isObject(body) || !has(body, 'code') || typeof body.code !== 'string' || body.code.length > 512) throw invalid();
      const expected = environmentSecret(env, 'ORBIT_ADMIN_CODE');
      if (!textEqual(body.code, expected)) throw unauthorized();
      jsonResponse(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(env) });
      return;
    }

    if (path === '/api/logout') {
      if (request.method !== 'POST') throw new HTTPError(405, 'Method not allowed', { Allow: 'POST' });
      sameOrigin(request);
      jsonResponse(response, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
      return;
    }

    if (path === '/api/state') {
      if (request.method !== 'GET') throw new HTTPError(405, 'Method not allowed', { Allow: 'GET' });
      adminAuthorized(request, env);
      const [config, snapshot, commands] = await Promise.all([loadConfig(durableStore), loadSnapshot(durableStore), loadCommands(durableStore)]);
      jsonResponse(response, 200, {
        config: publicConfig(config.value),
        snapshot: snapshot.value,
        commands: commands.map(({ value }) => uiCommand(value)),
      });
      return;
    }

    if (path === '/api/config') {
      if (request.method !== 'PUT') throw new HTTPError(405, 'Method not allowed', { Allow: 'PUT' });
      adminAuthorized(request, env);
      sameOrigin(request);
      const input = validateConfigInput(await jsonBody(request));
      const saved = await durableStore.withLock(async () => {
        const current = await loadConfig(durableStore);
        if (input.revision !== current.value.revision) throw conflict('Configuration changed; refresh and retry');
        const priorById = new Map(current.value.connectors.map((connector) => [connector.id, connector]));
        const connectors = input.connectors.map((connector) => {
          const prior = priorById.get(connector.id);
          const next = { id: connector.id, name: connector.name, url: connector.url, enabled: connector.enabled, allowedTools: connector.allowedTools };
          if (has(connector, 'token')) {
            if (connector.token) next.token = encryptToken(connector.token, env);
          } else if (prior?.token && prior.url === connector.url) {
            next.token = prior.token;
          } else if (prior && prior.url !== connector.url) {
            next.allowedTools = [];
          }
          return next;
        });
        const next = { revision: current.value.revision + 1, prompt: input.prompt, weatherCity: input.weatherCity, connectors };
        try {
          await durableStore.put(CONFIG_PATH, next, { allowOverwrite: current.etag !== undefined, ...(current.etag !== undefined ? { ifMatch: current.etag } : {}) });
        } catch (error) {
          if (storagePrecondition(error) || storageAlreadyExists(error)) throw conflict('Configuration changed; refresh and retry');
          throw error;
        }
        return next;
      });
      jsonResponse(response, 200, { config: publicConfig(saved) });
      return;
    }

    if (path === '/api/commands') {
      if (request.method !== 'POST') throw new HTTPError(405, 'Method not allowed', { Allow: 'POST' });
      adminAuthorized(request, env);
      sameOrigin(request);
      const input = commandInput(await jsonBody(request));
      const result = await durableStore.withLock(async () => {
        const pathname = commandPath(input.id);
        const existing = await durableStore.get(pathname);
        if (existing) {
          const command = storedCommand(existing.value);
          if (!sameCommand(input, commandPayload(command))) throw conflict('Command id already has a different payload');
          return { command, duplicate: true };
        }
        const pending = await loadCommands(durableStore);
        if (pending.length >= MAX_PENDING_COMMANDS) throw new HTTPError(429, 'Command queue is full', { 'Retry-After': '30' });
        const command = { ...input, createdAt: new Date().toISOString(), status: 'pending' };
        try {
          await durableStore.put(pathname, command, { allowOverwrite: false });
        } catch (error) {
          let after;
          try {
            after = await durableStore.get(pathname);
          } catch {
            throw error;
          }
          if (!after) throw error;
          const existingCommand = storedCommand(after.value);
          if (!sameCommand(input, commandPayload(existingCommand))) throw conflict('Command id already has a different payload');
          return { command: existingCommand, duplicate: true };
        }
        return { command, duplicate: false };
      });
      jsonResponse(response, result.duplicate ? 200 : 201, { command: uiCommand(result.command) });
      return;
    }

    if (path === '/api/sync') {
      machineAuthorized(request, env);
      if (request.method === 'GET') {
        const [config, commands] = await Promise.all([loadConfig(durableStore), loadCommands(durableStore)]);
        jsonResponse(response, 200, { config: machineConfig(config.value, env), commands: commands.map(({ value }) => value) });
        return;
      }
      if (request.method === 'POST') {
          const body = await jsonBody(request, MAX_SNAPSHOT_BYTES);
        let snapshotInput = body;
        let topLevelResults;
        if (isObject(body) && has(body, 'snapshot')) {
          exactKeys(body, ['snapshot', 'commandResults']);
          snapshotInput = body.snapshot;
          if (has(body, 'commandResults')) topLevelResults = commandResults(body.commandResults);
        }
        const saved = await durableStore.withLock(async () => {
          const previous = await loadSnapshot(durableStore);
          if (!isObject(snapshotInput)) throw invalid();
          const embeddedResults = has(snapshotInput, 'commandResults') ? commandResults(snapshotInput.commandResults) : previous.value.commandResults;
          const results = topLevelResults ? mergeCommandResults(embeddedResults, topLevelResults) : embeddedResults;
          const snapshot = snapshotValue(snapshotInput, previous.value, results);
          if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) throw new HTTPError(413, 'Request body too large');
          await durableStore.put(SNAPSHOT_PATH, snapshot, { allowOverwrite: true });
          const pendingPaths = new Set((await durableStore.list(COMMAND_PREFIX)).map(({ pathname }) => pathname));
          for (const result of results.filter(({ id }) => pendingPaths.has(commandPath(id)))) {
            try {
              await durableStore.del(commandPath(result.id));
            } catch {
              // A failed ack delete leaves the command available for the relay's idempotent retry.
            }
          }
          return snapshot;
        });
        jsonResponse(response, 200, { ok: true, snapshot: saved });
        return;
      }
      throw new HTTPError(405, 'Method not allowed', { Allow: 'GET, POST' });
    }

    if (serveStatic && !path.startsWith('/api/')) {
      await staticResponse(request, response, publicDir);
      return;
    }
    throw new HTTPError(404, 'Not found');
  }

  return async function handler(request, response) {
    try {
      await route(request, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy?.();
        return;
      }
      if (error instanceof HTTPError) {
        jsonResponse(response, error.status, { error: error.message }, error.headers);
      } else if (error instanceof QueueOverflowError) {
        jsonResponse(response, 503, { error: 'Command queue unavailable' });
      } else if (storagePrecondition(error)) {
        jsonResponse(response, 409, { error: 'Conflict' });
      } else {
        jsonResponse(response, 500, { error: 'Internal server error' });
      }
    }
  };
}

let defaultHandler;
export default async function handler(request, response) {
  defaultHandler ||= createHandler();
  return defaultHandler(request, response);
}

async function main() {
  const port = Number(process.env.PORT || 3000);
  const localHandler = createHandler({ serveStatic: true });
  const server = createServer(localHandler);
  server.listen(Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000, '127.0.0.1', () => {
    process.stdout.write(`Orbit console listening on http://127.0.0.1:${server.address().port}\n`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === FILE) main();
