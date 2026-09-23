import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetadataTemplateSpec } from '../gateway';

export interface FakeFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface FakeFile {
  id: string;
  name: string;
  parentId: string;
  size: number;
  sha1: string;
  versionId: string;
  createdAt: string;
  modifiedAt: string;
  contentModifiedAt: string | null;
  metadata: Record<string, unknown> | null;
  businessMetadata?: Record<string, Record<string, unknown>>;
}

export interface FakeSessionPart {
  partId: string;
  offset: number;
  size: number;
  sha1: string;
}

export interface FakeSession {
  sessionId: string;
  parentId: string;
  name: string;
  size: number;
  partSize: number;
  totalParts: number;
  expiresAt: string | null;
  state: 'OPEN' | 'COMMITTED' | 'ABORTED';
  parts: Record<string, FakeSessionPart>;
}

export interface FakeState {
  nextId: number;
  folders: Record<string, FakeFolder>;
  files: Record<string, FakeFile>;
  trash?: Record<string, FakeFile>;
  sessions: Record<string, FakeSession>;
  aiCalls: Record<string, number>;
  uploadAttempts: number;
  template: MetadataTemplateSpec | null;
  templates?: Record<string, MetadataTemplateSpec>;
}

export const FAKE_ROOT_ID = '0';

function initialState(): FakeState {
  return {
    nextId: 1000,
    folders: { [FAKE_ROOT_ID]: { id: FAKE_ROOT_ID, name: 'All Files', parentId: null } },
    files: {},
    sessions: {},
    aiCalls: {},
    uploadAttempts: 0,
    template: null,
  };
}

/**
 * JSON file backed state for the fake Box enterprise. Reads and writes are
 * synchronous so that a mutation cannot interleave with another one inside a
 * single Node process, which is what keeps parallel part uploads consistent.
 */
export class FakeBoxState {
  readonly rootDir: string;
  readonly objectsDir: string;
  readonly sessionsDir: string;
  readonly statePath: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.objectsDir = join(rootDir, 'objects');
    this.sessionsDir = join(rootDir, 'sessions');
    this.statePath = join(rootDir, 'state.json');
    mkdirSync(this.objectsDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });
    if (!existsSync(this.statePath)) this.#write(initialState());
  }

  read(): FakeState {
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8')) as FakeState;
    } catch {
      const fresh = initialState();
      this.#write(fresh);
      return fresh;
    }
  }

  mutate<T>(fn: (state: FakeState) => T): T {
    const state = this.read();
    const result = fn(state);
    this.#write(state);
    return result;
  }

  nextId(prefix: string): string {
    return this.mutate((state) => {
      state.nextId += 1;
      return `${prefix}${state.nextId}`;
    });
  }

  objectPath(fileId: string): string {
    return join(this.objectsDir, fileId);
  }

  partPath(sessionId: string, offset: number): string {
    return join(this.sessionsDir, sessionId, `${offset}.part`);
  }

  sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }

  #write(state: FakeState): void {
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.statePath);
  }
}
