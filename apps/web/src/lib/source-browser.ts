import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { excludedSourceName } from '@shuttle-lite/core';

export interface SourceListing {
  path: string;
  name: string;
  relativePath: string;
  entries: { name: string; type: 'folder' | 'file'; size?: number }[];
}

// 選択した範囲だけを閲覧可能にする。再起動後はFinderから選び直す。
const processState = globalThis as typeof globalThis & { shuttleBrowseKey?: Buffer };
const key = (processState.shuttleBrowseKey ??= randomBytes(32));
const digest = (value: string) => createHmac('sha256', key).update(value).digest();
const ownerId = (owner: string) => createHash('sha256').update(owner).digest('hex');

export async function grantSourceBrowse(path: string, owner: string) {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw new Error('Invalid folder');
  const payload = Buffer.from(
    JSON.stringify({ root, owner: ownerId(owner), expires: Date.now() + 3_600_000 }),
  ).toString('base64url');
  return { path: root, browseToken: `${payload}.${digest(payload).toString('base64url')}` };
}

export async function browseSource(
  token: string,
  subpath: string,
  owner: string,
  signal?: AbortSignal,
): Promise<SourceListing> {
  if (token.length > 16_384 || subpath.length > 4096) throw new Error('Invalid request');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new Error('Invalid token');
  const actual = Buffer.from(signature, 'base64url');
  const expected = digest(payload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('Invalid token');
  const grant = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
    root: string;
    owner: string;
    expires: number;
  };
  if (grant.owner !== ownerId(owner) || grant.expires < Date.now()) throw new Error('Expired');
  const parts = subpath ? subpath.split('/') : [];
  if (
    isAbsolute(subpath) ||
    parts.length > 128 ||
    parts.some(
      (part) =>
        !part || part === '..' || part === '.' || /[\\\0]/.test(part) || excludedSourceName(part),
    )
  )
    throw new Error('Invalid path');
  let path = grant.root;
  if ((await realpath(path)) !== path) throw new Error('Root changed');
  for (const part of parts) {
    path = join(path, part);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid folder');
  }
  if ((await realpath(path)) !== resolve(path)) throw new Error('Folder changed');
  const entries: SourceListing['entries'] = [];
  const start = Date.now();
  let visited = 0;
  for await (const entry of await opendir(path)) {
    if (signal?.aborted || ++visited > 10_000 || Date.now() - start > 10_000)
      throw new Error('Listing limit');
    if (excludedSourceName(entry.name) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) entries.push({ name: entry.name, type: 'folder' });
    else if (entry.isFile()) {
      const info = await lstat(join(path, entry.name));
      if (info.isFile()) entries.push({ name: entry.name, type: 'file', size: info.size });
    }
  }
  entries.sort((a, b) =>
    a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, 'ja'),
  );
  return {
    path,
    name: basename(path) || path,
    relativePath: relative(grant.root, path).split(sep).join('/'),
    entries,
  };
}
