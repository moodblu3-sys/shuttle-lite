import type { Readable } from 'node:stream';

export interface BoxIdentity {
  readonly userId: string;
  readonly login: string;
  readonly name: string;
  readonly enterpriseId?: string;
}

export interface BoxFolder {
  readonly id: string;
  readonly name: string;
  readonly parentFolderId: string | null;
}

export interface BoxFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly sha1: string;
  readonly parentFolderId: string | null;
  readonly versionId: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface BoxItemSummary {
  readonly type: 'file' | 'folder';
  readonly id: string;
  readonly name: string;
  readonly size?: number;
  readonly sha1?: string;
}

export interface UploadDirectRequest {
  readonly parentFolderId: string;
  readonly name: string;
  readonly size: number;
  /** Source digest, sent so Box rejects a corrupted transfer itself. */
  readonly sha1Hex: string;
  /** A factory, so a retry can re-open the source instead of buffering it. */
  readonly content: () => Readable;
  readonly contentModifiedAt?: string;
  readonly onProgress?: (bytesSent: number) => void;
  readonly signal?: AbortSignal;
}

export interface UploadSessionInfo {
  readonly sessionId: string;
  readonly partSize: number;
  readonly totalParts: number;
  readonly expiresAt: string | null;
}

export interface UploadedPart {
  readonly partId: string;
  readonly offset: number;
  readonly size: number;
  readonly sha1: string;
}

export interface UploadPartRequest {
  readonly sessionId: string;
  readonly offset: number;
  readonly totalSize: number;
  readonly chunk: Buffer;
  readonly signal?: AbortSignal;
}

export interface CommitSessionRequest {
  readonly sessionId: string;
  readonly parts: readonly UploadedPart[];
  readonly sha1Hex: string;
  readonly contentModifiedAt?: string;
}

export interface MetadataValues {
  readonly [key: string]: string | number | boolean | null;
}

export const AI_EXTRACTION_FIELDS = [
  {
    key: 'documentType',
    type: 'string',
    displayName: 'Document type',
    // 実測で「従業員記録」が繁体字の「從業員記錄」で返った。metadataの集計軸に
    // なるうえ承認画面にも出るため、字体を指定する。
    description:
      '契約書、請求書、従業員記録、運用手順書、提案書などの文書種別。日本語の常用漢字で答え、繁体字や簡体字は使わない',
  },
  {
    key: 'businessDomain',
    type: 'string',
    displayName: 'Business domain',
    description: 'Legal、Finance、HR、IT、Salesなどの業務領域',
  },
  {
    key: 'businessIdentifier',
    type: 'string',
    displayName: 'Business identifier',
    description: '契約番号、請求書番号、社員番号などの業務上の識別子',
  },
  {
    key: 'effectiveDate',
    type: 'date',
    displayName: 'Effective date',
    description: '発効日、発行日、適用開始日',
  },
  {
    key: 'suggestedDestinationKey',
    type: 'enum',
    displayName: 'Suggested destination key',
    description: '許可済みdestination catalogのkeyのみ。判断できない場合は NEEDS_REVIEW',
  },
  {
    key: 'suggestedTags',
    type: 'string',
    displayName: 'Suggested tags',
    description: 'カンマ区切りの短いtag',
  },
  {
    key: 'reason',
    type: 'string',
    displayName: 'Reason',
    description: 'そのdestinationを提案した理由を1文で',
  },
] as const;

export interface AiExtractionRequest {
  readonly fileId: string;
  /** Allowed destination keys. The model may not invent a folder ID. */
  readonly destinationKeys: readonly string[];
  readonly fileName: string;
  readonly signal?: AbortSignal;
}

export interface AiExtractionResponse {
  readonly provider: string;
  readonly fields: Record<string, unknown>;
  /** Only present when the provider actually returns it. Never synthesised. */
  readonly confidence: number | null;
  readonly references: readonly string[];
}

export interface MetadataTemplateField {
  readonly key: string;
  readonly type: 'string' | 'float' | 'date' | 'enum';
  readonly displayName: string;
  readonly options?: readonly string[];
}

export interface MetadataTemplateSpec {
  readonly scope: string;
  readonly templateKey: string;
  readonly displayName: string;
  readonly fields: readonly MetadataTemplateField[];
}

/**
 * The single seam between deterministic migration logic and Box. The HTTP
 * implementation talks to a real enterprise through the explicit proxy; the
 * fake implementation keeps content on local disk so the whole pipeline,
 * including crash recovery, can be exercised without credentials.
 */
export interface BoxGateway {
  readonly kind: 'fake' | 'http';

  whoAmI(): Promise<BoxIdentity>;

  /** Idempotent: returns the existing folder when it is already there. */
  ensureFolder(parentFolderId: string, name: string): Promise<BoxFolder>;
  ensureFolderPath(rootFolderId: string, segments: readonly string[]): Promise<BoxFolder>;
  getFolder(folderId: string): Promise<BoxFolder | null>;
  listFolder(folderId: string): Promise<BoxItemSummary[]>;
  findFileByName(folderId: string, name: string): Promise<BoxFile | null>;

  /** Throws BOX_CONFLICT rather than silently overwriting an existing name. */
  preflightUpload(request: { parentFolderId: string; name: string; size: number }): Promise<void>;

  uploadDirect(request: UploadDirectRequest): Promise<BoxFile>;

  createUploadSession(request: {
    parentFolderId: string;
    name: string;
    size: number;
  }): Promise<UploadSessionInfo>;
  getUploadSession(sessionId: string): Promise<UploadSessionInfo | null>;
  uploadPart(request: UploadPartRequest): Promise<UploadedPart>;
  listUploadSessionParts(sessionId: string): Promise<UploadedPart[]>;
  commitUploadSession(request: CommitSessionRequest): Promise<BoxFile>;
  abortUploadSession(sessionId: string): Promise<void>;

  getFile(fileId: string): Promise<BoxFile | null>;
  moveFile(request: { fileId: string; targetFolderId: string; newName?: string }): Promise<BoxFile>;

  setMetadata(fileId: string, values: MetadataValues): Promise<void>;
  updateMetadata(fileId: string, values: MetadataValues): Promise<void>;
  getMetadata(fileId: string): Promise<Record<string, unknown> | null>;

  extractStructured(request: AiExtractionRequest): Promise<AiExtractionResponse>;

  getMetadataTemplate(): Promise<MetadataTemplateSpec | null>;
  createMetadataTemplate(spec: MetadataTemplateSpec): Promise<void>;

  close(): Promise<void>;
}
