/** Captured from Box when creating a job; never supplied by the browser. */
export interface JobDestinations {
  readonly mode: 'real' | 'fake';
  readonly rootFolderId: string;
  readonly rootFolderName: string;
  readonly capturedAt: string;
  readonly entries: readonly {
    readonly key: string;
    readonly folderId: string;
    readonly parentFolderId: string | null;
    readonly label: string;
    readonly boxPath: string;
    readonly description?: string;
  }[];
}
