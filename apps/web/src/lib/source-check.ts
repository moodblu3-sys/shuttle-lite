import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { excludedSourceName, WINDOWS_MAX_PATH, isTooLongForWindows } from '@shuttle-lite/core';

export interface SourceCheck {
  fileCount: number;
  folderCount: number;
  totalBytes: number;
  excludedCount: number;
  errorCount: number;
  errors: { path: string; message: string }[];
  complete: boolean;
  signature: string | null;
  checkedAt: string;
}

/** Read-only inventory. File contents are not uploaded, hashed or interpreted. */
export async function checkSource(
  rootPath: string,
  signal?: AbortSignal,
  limits = { entries: 100_000, durationMs: 60_000 },
): Promise<SourceCheck> {
  if (!isAbsolute(rootPath) || rootPath.includes('\0'))
    throw new Error('移行元フォルダーを選び直してください。');
  const root = resolve(rootPath);
  const result: SourceCheck = {
    fileCount: 0,
    folderCount: 0,
    totalBytes: 0,
    excludedCount: 0,
    errorCount: 0,
    errors: [],
    complete: true,
    signature: null,
    checkedAt: '',
  };
  const records: string[] = [];
  const started = Date.now();
  let visited = 0;
  function issue(path: string, message: string) {
    result.errorCount++;
    if (result.errors.length < 50)
      result.errors.push({ path: relative(root, path).split(sep).join('/') || '.', message });
  }
  function checkLimit() {
    if (signal?.aborted) throw new Error('確認を中止しました。');
    if (++visited > limits.entries || Date.now() - started > limits.durationMs)
      throw new Error('確認の上限に達しました。移行元の範囲を小さくしてください。');
  }
  async function walk(dir: string, depth: number) {
    checkLimit();
    if (depth > 128)
      throw new Error('フォルダーの階層が深すぎます。移行元の範囲を小さくしてください。');
    let handle;
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a directory');
      handle = await opendir(dir);
      records.push(JSON.stringify(['d', relative(root, dir), info.ino, info.mtimeMs]));
      if (dir !== root) result.folderCount++;
    } catch {
      issue(dir, 'フォルダーを読み取れません。アクセス権と接続を確認してください。');
      return;
    }
    for await (const entry of handle) {
      checkLimit();
      const path = join(dir, entry.name);
      if (excludedSourceName(entry.name) || entry.isSymbolicLink()) {
        result.excludedCount++;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        result.excludedCount++;
        continue;
      }
      let file;
      try {
        if (process.platform === 'win32' && isTooLongForWindows(path, WINDOWS_MAX_PATH)) {
          issue(path, 'パスが長すぎます。');
          continue;
        }
        file = await open(
          path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        const info = await file.stat();
        if (!info.isFile()) throw new Error('not a file');
        result.fileCount++;
        result.totalBytes += info.size;
        records.push(
          JSON.stringify([
            'f',
            relative(root, path),
            info.ino,
            info.size,
            info.mtimeMs,
            info.ctimeMs,
          ]),
        );
      } catch {
        issue(path, 'ファイルを読み取れません。アクセス権や使用中のアプリを確認してください。');
      } finally {
        await file?.close();
      }
    }
  }
  try {
    await walk(root, 0);
  } catch (error) {
    result.complete = false;
    issue(
      root,
      signal?.aborted
        ? '確認を中止しました。'
        : error instanceof Error && error.message.includes('範囲を小さく')
          ? error.message
          : '確認を完了できませんでした。もう一度確認してください。',
    );
  }
  result.checkedAt = new Date().toISOString();
  if (result.complete && result.errorCount === 0)
    result.signature = createHash('sha256')
      .update(JSON.stringify([root, records.sort()]))
      .digest('hex');
  return result;
}
