import type { BusinessMetadataDraft, BusinessTemplate } from '@shuttle-lite/core';
export interface ReviewExtractionView {
  readonly provider: string;
  readonly documentType: string | null;
  readonly businessDomain: string | null;
  readonly businessIdentifier: string | null;
  readonly effectiveDate: string | null;
  readonly suggestedTags: readonly string[];
  readonly confidence: number | null;
  readonly references: readonly string[];
}

export interface ReviewCommandView {
  readonly id: string;
  readonly state: 'PENDING' | 'CLAIMED' | 'DONE' | 'REJECTED';
  readonly rejectionReason: string | null;
  readonly createdAt: string;
}

export interface ReviewItemView {
  readonly businessMetadata?: BusinessMetadataDraft & {
    template: BusinessTemplate | null;
    canExtract: boolean;
  };
  readonly itemId: string;
  readonly jobId: string;
  readonly state: string;
  readonly sourceRelativePath: string;
  readonly sourceFileName: string;
  readonly sourceSize: number;
  readonly sourceSha1: string | null;
  readonly boxFileId: string | null;
  readonly boxSha1: string | null;
  readonly boxVersionId: string | null;
  readonly lastErrorCategory: string | null;
  readonly lastError: string | null;
  readonly operatorAction: string | null;
  /** Retryable via the same approval, or blocked until the operator changes something. */
  readonly needsAttention: boolean;
  /** Operator-chosen placement name. Null means the source file name is used. */
  readonly finalName: string | null;
  readonly suggestedDestinationKey: string | null;
  /**
   * False when the AI declined, which it does by answering with the catalog's
   * needs-review key. That key is a real folder, so the screen must not offer
   * it as "approve as suggested". Computed here rather than in the client
   * component: the rule lives in `@shuttle-lite/routing` and that package is
   * not importable from the browser bundle.
   */
  readonly hasRoutingDecision: boolean;
  readonly suggestionSource: string | null;
  readonly suggestionReason: string | null;
  readonly extraction: ReviewExtractionView | null;
  readonly reviewCommand: ReviewCommandView | null;
}

export interface DestinationOption {
  readonly key: string;
  readonly label: string;
  readonly boxPath: string;
}
