/**
 * The typed intent vocabulary (docs/architecture/08-intents-and-work.md).
 * Free-form feedback is the fallback (`comment`), not the model.
 */
export const INTENT_TYPES = [
  "comment",
  "question",
  "replace-text",
  "remove",
  "move",
  "choose",
  "reject-option",
  "add-constraint",
  "approve-node",
  "request-implementation",
  "request-verification",
  "accept-result",
  "reopen",
] as const;

export type IntentType = (typeof INTENT_TYPES)[number];

export type TextQuote = Readonly<{ exact: string; prefix?: string; suffix?: string }>;

export type BoardAnchor = Readonly<{
  semanticId: string;
  whiteboardArtifactId: string;
  baseRevisionId?: string;
  sceneHash?: string;
  draftId?: string;
  draftVersion?: number;
  elementAnchor: Readonly<{
    anchorId: string;
    elementId: string;
    version?: number;
    versionNonce?: number;
    type?: string;
    label?: string;
  }>;
}>;

/** Independent anchor clues; geometry is UI metadata, never durable. */
export type IntentTarget = Readonly<{
  semanticId?: string;
  domHint?: string | null;
  textQuote?: TextQuote;
  boardAnchor?: BoardAnchor;
}>;

export type IntentInput = Readonly<{
  intentId: string;
  intentType: IntentType;
  target: IntentTarget;
  body: Readonly<Record<string, unknown>>;
}>;
