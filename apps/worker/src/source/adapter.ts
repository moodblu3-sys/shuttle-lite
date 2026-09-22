import type { Readable } from 'node:stream';

export interface SourceItemInfo {
  /** Path relative to the source root, always with `/` separators. */
  readonly relativePath: string;
  /** Absolute path for a local source, Box file ID for a Box source. */
  readonly locator: string;
  readonly fileName: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly fileType: string;
  /** Inode on a local source, Box file ID on a Box source. Informational. */
  readonly externalId: string | null;
  /**
   * Present when the source can report a digest without reading the bytes.
   * A Box source can; a local file system cannot.
   */
  readonly sha1?: string | null;
}

export interface SourceDigest {
  readonly sha1: string;
  readonly bytes: number;
}

export interface SourceRef {
  readonly relativePath: string;
  /** Absolute path for a local source, Box file ID for a Box source. */
  readonly locator: string;
  readonly size: number;
  readonly modifiedAt: string;
}

/**
 * The seam between "where the bytes come from" and the migration pipeline.
 *
 * Only `LocalSourceAdapter` ships today. A `BoxSourceAdapter` for Box-to-Box
 * migration plugs in here without touching upload, retry, reconciliation,
 * review, telemetry or reporting. See docs/box-to-box.md.
 */
export interface SourceAdapter {
  readonly kind: 'local' | 'box';
  /** Human readable root, shown in the UI and the report. */
  readonly rootLabel: string;

  /** Verifies the root is reachable and readable before a scan starts. */
  verifyRoot(): Promise<void>;

  scan(): AsyncIterable<SourceItemInfo>;

  /** Re-read the current state, used to detect a source changed under us. */
  stat(ref: SourceRef): Promise<SourceItemInfo>;

  /**
   * Digest of the current content. A Box source returns the stored SHA-1
   * without transferring anything.
   */
  digest(ref: SourceRef): Promise<SourceDigest>;

  /** Full content stream. Called again on every retry, never buffered. */
  openStream(ref: SourceRef): Readable;

  /** One chunked-upload part. */
  readRange(ref: SourceRef, offset: number, length: number): Promise<Buffer>;
}
