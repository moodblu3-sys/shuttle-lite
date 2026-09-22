import { createReadStream } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import {
  isOfficeLockFile,
  isTooLongForWindows,
  sha1File,
  ShuttleError,
  WINDOWS_MAX_PATH,
} from '@shuttle-lite/core';
import type { SourceAdapter, SourceDigest, SourceItemInfo, SourceRef } from './adapter';

const SKIPPED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);

export interface LocalSourceOptions {
  readonly rootPath: string;
  /**
   * Fail preflight above this absolute path length. Defaults to the Windows
   * limit on Windows, and is configurable so the behaviour can be rehearsed
   * on macOS before a Windows run.
   */
  readonly maxPathLength?: number;
}

/** Maps OS level read failures onto the classified categories the UI shows. */
export function mapReadError(error: unknown, path: string): ShuttleError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new ShuttleError('SOURCE_MISSING', `Source fileが見つかりません: ${path}`, {
      cause: error,
    });
  }
  // Windows reports a sharing violation as EBUSY, and an antivirus scan or a
  // denied ACL as EPERM/EACCES. All three are worth retrying.
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return new ShuttleError(
      'SOURCE_LOCKED',
      `Source fileが他のprocessに使用されています: ${path}`,
      {
        cause: error,
        details: { code },
      },
    );
  }
  if (code === 'ENAMETOOLONG') {
    return new ShuttleError('PATH_TOO_LONG', `Pathが長すぎます: ${path}`, { cause: error });
  }
  return new ShuttleError('SOURCE_READ', `Source fileを読み取れません: ${path}`, { cause: error });
}

function fileTypeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'unknown';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Local folder source, including a Windows network share mounted as a UNC
 * path. The source is read only: nothing here writes, renames or deletes.
 */
export class LocalSourceAdapter implements SourceAdapter {
  readonly kind = 'local' as const;
  readonly #rootPath: string;
  readonly #maxPathLength: number;

  constructor(options: LocalSourceOptions) {
    this.#rootPath = options.rootPath;
    this.#maxPathLength =
      options.maxPathLength ??
      (process.platform === 'win32' ? WINDOWS_MAX_PATH : Number.MAX_SAFE_INTEGER);
  }

  get rootLabel(): string {
    return this.#rootPath;
  }

  get rootPath(): string {
    return this.#rootPath;
  }

  absolutePathFor(relativePath: string): string {
    return join(this.#rootPath, ...relativePath.split('/'));
  }

  async verifyRoot(): Promise<void> {
    if (!isAbsolute(this.#rootPath)) {
      throw new ShuttleError(
        'CONFIG_INVALID',
        `Source rootは絶対pathで指定してください: ${this.#rootPath}`,
      );
    }
    let info;
    try {
      info = await stat(this.#rootPath);
    } catch (error) {
      throw new ShuttleError(
        'SOURCE_READ',
        `Source rootへ到達できません: ${this.#rootPath}。ネットワーク共有の場合はmount状態と権限を確認してください。`,
        { cause: error },
      );
    }
    if (!info.isDirectory()) {
      throw new ShuttleError(
        'CONFIG_INVALID',
        `Source rootがdirectoryではありません: ${this.#rootPath}`,
      );
    }
  }

  async *scan(): AsyncIterable<SourceItemInfo> {
    yield* this.#walk(this.#rootPath);
  }

  async *#walk(dir: string): AsyncIterable<SourceItemInfo> {
    const handle = await opendir(dir).catch((error: unknown) => {
      throw mapReadError(error, dir);
    });
    for await (const entry of handle) {
      const absolute = join(dir, entry.name);
      if (entry.name.startsWith('.') || SKIPPED_NAMES.has(entry.name)) continue;
      // An Office lock file means a colleague has the document open. Migrating
      // the lock file itself is never useful.
      if (isOfficeLockFile(entry.name)) continue;
      // Junctions and symlinks are skipped rather than followed, so a link
      // cannot pull content from outside the source root.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        yield* this.#walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const info = await stat(absolute).catch((error: unknown) => {
        throw mapReadError(error, absolute);
      });
      yield {
        relativePath: relative(this.#rootPath, absolute).split(sep).join('/'),
        locator: absolute,
        fileName: entry.name,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        fileType: fileTypeOf(entry.name),
        externalId: String(info.ino),
      };
    }
  }

  async stat(ref: SourceRef): Promise<SourceItemInfo> {
    const absolute = ref.locator;
    const info = await stat(absolute).catch((error: unknown) => {
      throw mapReadError(error, absolute);
    });
    const fileName = absolute.split(sep).pop() ?? ref.relativePath;
    return {
      relativePath: ref.relativePath,
      locator: absolute,
      fileName,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      fileType: fileTypeOf(fileName),
      externalId: String(info.ino),
    };
  }

  async digest(ref: SourceRef): Promise<SourceDigest> {
    return sha1File(ref.locator);
  }

  openStream(ref: SourceRef): Readable {
    return createReadStream(ref.locator);
  }

  async readRange(ref: SourceRef, offset: number, length: number): Promise<Buffer> {
    const handle = await open(ref.locator, 'r').catch((error: unknown) => {
      throw mapReadError(error, ref.locator);
    });
    try {
      const buffer = Buffer.allocUnsafe(length);
      const read = await handle.read(buffer, 0, length, offset);
      if (read.bytesRead !== length) {
        throw new ShuttleError('SOURCE_CHANGED', 'Part読み込み中にsource fileが変わりました', {
          details: { expected: length, actual: read.bytesRead },
        });
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }

  /** Preflight check that only applies to a local file system. */
  checkPathLength(absolutePath: string): void {
    if (isTooLongForWindows(absolutePath, this.#maxPathLength)) {
      throw new ShuttleError(
        'PATH_TOO_LONG',
        `Pathが${this.#maxPathLength}文字の上限を超えています (${absolutePath.length}文字)`,
        { details: { length: absolutePath.length, limit: this.#maxPathLength } },
      );
    }
  }
}
