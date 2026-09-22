import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { ShuttleError } from './errors';

export interface FileDigest {
  readonly sha1: string;
  readonly bytes: number;
}

/**
 * Streaming SHA-1 so that a large source file is never fully held in memory,
 * per docs/decisions.md D-005.
 */
export async function sha1File(
  path: string,
  options: { signal?: AbortSignal; onBytes?: (bytes: number) => void } = {},
): Promise<FileDigest> {
  const hash = createHash('sha1');
  let bytes = 0;
  try {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    await pipeline(
      stream,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.byteLength;
          hash.update(chunk);
          options.onBytes?.(bytes);
          yield chunk;
        }
      },
      // Consume without writing anywhere.
      async function (source: AsyncIterable<Buffer>) {
        for await (const _chunk of source) {
          // discard
        }
      },
      options.signal ? { signal: options.signal } : {},
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ShuttleError('SOURCE_MISSING', `Source fileが見つかりません: ${path}`, {
        cause: error,
      });
    }
    throw new ShuttleError('SOURCE_READ', `Source fileを読み取れません: ${path}`, { cause: error });
  }
  return { sha1: hash.digest('hex'), bytes };
}

export function sha1Buffer(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

export function sha1Base64(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('base64');
}

/** Box sends and expects the digest as `sha=<base64>` in Content-MD5 style headers. */
export function boxDigestHeader(data: Uint8Array): string {
  return `sha=${sha1Base64(data)}`;
}

export function hexToBase64Sha1(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}
