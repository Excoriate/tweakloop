import { WhiteboardError } from "./errors.js";

export const WHITEBOARD_PUBLICATION_PIN_PROTOCOL =
  "tweakloop.whiteboard-publication-pin/v1" as const;
export const WHITEBOARD_PUBLICATION_RECEIPT_PROTOCOL =
  "tweakloop.whiteboard-publication-receipt/v1" as const;

export type WhiteboardPublicationPin = Readonly<{
  protocol: typeof WHITEBOARD_PUBLICATION_PIN_PROTOCOL;
  artifactId: string;
  draftId: string;
  baseRevisionId: string;
  draftVersion: number;
  sceneHash: string;
  elementIndexHash: string;
  expectedHeadRevisionId: string;
}>;

/** Values read inside the same transaction that will append the revision and CAS the head. */
export type WhiteboardPublicationTransactionSnapshot = Readonly<{
  artifactId: string;
  draftId: string;
  baseRevisionId: string;
  draftVersion: number;
  sceneHash: string;
  elementIndexHash: string;
  currentHeadRevisionId: string;
}>;

export type WhiteboardPublicationDecision =
  | Readonly<{
      status: "accepted";
      pin: WhiteboardPublicationPin;
    }>
  | Readonly<{
      status: "rejected";
      code:
        | "whiteboard.publish-stale-draft"
        | "whiteboard.publish-stale-scene"
        | "whiteboard.publish-stale-head";
      message: string;
      revision: null;
    }>;

export type WhiteboardPublicationReceipt = Readonly<{
  protocol: typeof WHITEBOARD_PUBLICATION_RECEIPT_PROTOCOL;
  artifactId: string;
  revisionId: string;
  draftId: string;
  baseRevisionId: string;
  draftVersion: number;
  sceneHash: string;
  elementIndexHash: string;
  expectedHeadRevisionId: string;
}>;

export function createWhiteboardPublicationPin(
  value: Omit<WhiteboardPublicationPin, "protocol">,
): WhiteboardPublicationPin {
  validatePublicationTuple(value);
  return { protocol: WHITEBOARD_PUBLICATION_PIN_PROTOCOL, ...value };
}

/**
 * This decision must run after reading `current` inside the revision transaction. An accepted value
 * is permission for that transaction to append exactly the pin's hashes and CAS exactly its expected
 * head; it is not a preflight result that can safely cross a transaction boundary.
 */
export function decidePinnedWhiteboardPublication(
  pin: WhiteboardPublicationPin,
  current: WhiteboardPublicationTransactionSnapshot,
): WhiteboardPublicationDecision {
  if (pin.protocol !== WHITEBOARD_PUBLICATION_PIN_PROTOCOL) {
    throw invalid("whiteboard publication pin protocol is unsupported");
  }
  validatePublicationTuple(pin);
  validateTransactionSnapshot(current);
  if (
    current.artifactId !== pin.artifactId ||
    current.draftId !== pin.draftId ||
    current.baseRevisionId !== pin.baseRevisionId ||
    current.draftVersion !== pin.draftVersion
  ) {
    return {
      status: "rejected",
      code: "whiteboard.publish-stale-draft",
      message: "whiteboard draft identity or version changed after the publication pin was created",
      revision: null,
    };
  }
  if (current.sceneHash !== pin.sceneHash || current.elementIndexHash !== pin.elementIndexHash) {
    return {
      status: "rejected",
      code: "whiteboard.publish-stale-scene",
      message: "whiteboard scene or element index changed after the publication pin was created",
      revision: null,
    };
  }
  if (
    current.currentHeadRevisionId !== pin.expectedHeadRevisionId ||
    current.baseRevisionId !== pin.expectedHeadRevisionId
  ) {
    return {
      status: "rejected",
      code: "whiteboard.publish-stale-head",
      message: "whiteboard artifact head changed after the publication pin was created",
      revision: null,
    };
  }
  return { status: "accepted", pin };
}

/** Create the public receipt only after the accepted transaction has committed the revision. */
export function committedWhiteboardPublicationReceipt(
  decision: Extract<WhiteboardPublicationDecision, Readonly<{ status: "accepted" }>>,
  revisionId: string,
): WhiteboardPublicationReceipt {
  validateIdentifier(revisionId, "revisionId");
  return {
    protocol: WHITEBOARD_PUBLICATION_RECEIPT_PROTOCOL,
    artifactId: decision.pin.artifactId,
    revisionId,
    draftId: decision.pin.draftId,
    baseRevisionId: decision.pin.baseRevisionId,
    draftVersion: decision.pin.draftVersion,
    sceneHash: decision.pin.sceneHash,
    elementIndexHash: decision.pin.elementIndexHash,
    expectedHeadRevisionId: decision.pin.expectedHeadRevisionId,
  };
}

function validatePublicationTuple(
  value: Omit<WhiteboardPublicationPin, "protocol"> | WhiteboardPublicationPin,
): void {
  validateIdentifier(value.artifactId, "artifactId");
  validateIdentifier(value.draftId, "draftId");
  validateIdentifier(value.baseRevisionId, "baseRevisionId");
  validateIdentifier(value.expectedHeadRevisionId, "expectedHeadRevisionId");
  validateHash(value.sceneHash, "sceneHash");
  validateHash(value.elementIndexHash, "elementIndexHash");
  if (!Number.isSafeInteger(value.draftVersion) || value.draftVersion < 0) {
    throw invalid("draftVersion must be a non-negative safe integer");
  }
}

function validateTransactionSnapshot(value: WhiteboardPublicationTransactionSnapshot): void {
  validatePublicationTuple({
    ...value,
    expectedHeadRevisionId: value.currentHeadRevisionId,
  });
}

function validateHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw invalid(`${label} must be a lowercase SHA-256 hash`);
}

function validateIdentifier(value: string, label: string): void {
  if (value.length < 1 || value.length > 256 || hasControlCharacter(value)) {
    throw invalid(`${label} must be a non-empty printable identifier`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function invalid(message: string): WhiteboardError {
  return new WhiteboardError("whiteboard.publish-pin-invalid", message, 400);
}
