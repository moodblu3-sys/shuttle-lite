import { Readable } from 'node:stream';

export interface MultipartFilePart {
  readonly fieldName: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly content: () => Readable;
}

export interface MultipartBody {
  readonly boundary: string;
  readonly contentType: string;
  readonly contentLength: number;
  readonly stream: () => Readable;
}

function fieldSection(boundary: string, name: string, value: string): string {
  return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

function fileHeader(boundary: string, part: MultipartFilePart): string {
  const encodedName = part.fileName.replace(/"/g, '\\"');
  return (
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${part.fieldName}"; filename="${encodedName}"\r\n` +
    `Content-Type: ${part.contentType}\r\n\r\n`
  );
}

/**
 * Builds the Box upload body without buffering the file. The exact length is
 * computable because the source size is known, which lets the request use
 * Content-Length instead of chunked encoding.
 */
export function buildMultipart(
  fields: Record<string, string>,
  part: MultipartFilePart,
  onProgress?: (bytesSent: number) => void,
): MultipartBody {
  const boundary = `----ShuttleLite${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const prefix = Object.entries(fields)
    .map(([name, value]) => fieldSection(boundary, name, value))
    .join('');
  const header = fileHeader(boundary, part);
  const footer = `\r\n--${boundary}--\r\n`;

  const contentLength =
    Buffer.byteLength(prefix) + Buffer.byteLength(header) + part.size + Buffer.byteLength(footer);

  const stream = () =>
    Readable.from(
      (async function* () {
        yield Buffer.from(prefix);
        yield Buffer.from(header);
        let sent = 0;
        for await (const chunk of part.content()) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          sent += buffer.byteLength;
          onProgress?.(sent);
          yield buffer;
        }
        yield Buffer.from(footer);
      })(),
    );

  return {
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength,
    stream,
  };
}
