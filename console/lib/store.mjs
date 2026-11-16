import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, link } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class StoragePreconditionError extends Error {
  constructor() {
    super('Storage precondition failed');
    this.name = 'StoragePreconditionError';
  }
}

export class StorageAlreadyExistsError extends Error {
  constructor() {
    super('Storage object already exists');
    this.name = 'StorageAlreadyExistsError';
  }
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readLocalFile(file) {
  try {
    const bytes = await readFile(file);
    return { bytes, value: JSON.parse(bytes.toString('utf8')), etag: digest(bytes) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export class LocalStore {
  constructor(directory) {
    this.directory = resolve(directory);
    this.lock = Promise.resolve();
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  path(pathname) {
    if (typeof pathname !== 'string' || !pathname || pathname.startsWith('/') || pathname.includes('\\') || pathname.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Invalid storage path');
    }
    const file = resolve(this.directory, pathname);
    if (file !== this.directory && !file.startsWith(`${this.directory}/`)) throw new Error('Invalid storage path');
    return file;
  }

  async withLock(fn) {
    let release;
    const previous = this.lock;
    this.lock = new Promise((resolveRelease) => { release = resolveRelease; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async get(pathname) {
    await this.init();
    return readLocalFile(this.path(pathname));
  }

  async put(pathname, value, { ifMatch = undefined, allowOverwrite = true } = {}) {
    await this.init();
    const file = this.path(pathname);
    const existing = await readLocalFile(file);
    if (ifMatch !== undefined && (!existing || existing.etag !== ifMatch)) throw new StoragePreconditionError();
    if (!allowOverwrite && existing) throw new StorageAlreadyExistsError();

    const bytes = Buffer.from(JSON.stringify(value));
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${randomUUID()}`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      if (allowOverwrite) {
        await rename(temporary, file);
      } else {
        try {
          await link(temporary, file);
        } catch (error) {
          if (error?.code === 'EEXIST') throw new StorageAlreadyExistsError();
          throw error;
        } finally {
          await rm(temporary, { force: true });
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return { pathname, etag: digest(bytes) };
  }

  async list(prefix = '') {
    await this.init();
    const results = [];
    const walk = async (directory, relativeDirectory) => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const fullPath = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(fullPath, relativePath);
        else if (relativePath.startsWith(prefix)) {
          const details = await readLocalFile(fullPath);
          if (details) results.push({ pathname: relativePath, etag: details.etag });
        }
      }
    };
    await walk(this.directory, '');
    return results;
  }

  async del(pathname) {
    await this.init();
    try {
      await unlink(this.path(pathname));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

let blobSdk;
async function getBlobSdk() {
  blobSdk ||= import('@vercel/blob');
  return blobSdk;
}

async function streamBytes(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.byteLength ?? chunk.length;
    if (length > 512 * 1024) throw new Error('Storage object too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class BlobStore {
  async withLock(fn) {
    return fn();
  }

  async get(pathname) {
    const { get } = await getBlobSdk();
    const result = await get(pathname, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const bytes = await streamBytes(result.stream);
    return { value: JSON.parse(bytes.toString('utf8')), etag: result.blob.etag };
  }

  async put(pathname, value, { ifMatch = undefined, allowOverwrite = true } = {}) {
    const { put } = await getBlobSdk();
    const options = { access: 'private', allowOverwrite };
    if (ifMatch !== undefined) options.ifMatch = ifMatch;
    const result = await put(pathname, JSON.stringify(value), options);
    return { pathname: result.pathname, etag: result.etag };
  }

  async list(prefix = '') {
    const { list } = await getBlobSdk();
    const results = [];
    let cursor;
    do {
      const page = await list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const blob of page.blobs ?? []) results.push({ pathname: blob.pathname, etag: blob.etag });
      if (!page.hasMore) break;
      if (!page.cursor) throw new Error('Blob pagination failed');
      cursor = page.cursor;
    } while (true);
    return results;
  }

  async del(pathname) {
    const { del } = await getBlobSdk();
    await del(pathname);
  }
}
