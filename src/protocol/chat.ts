import type { BoardAnchor, TextQuote } from "./intents.js";

export const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export type ChatChoiceOption = Readonly<{
  key: string;
  label: string;
}>;

/**
 * Chat content is one tagged value family. Questions and answers remain
 * immutable messages; their lifecycle is derived from reply/supersession
 * links rather than owned by a second aggregate.
 */
export type ChatContent =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{
      type: "choice-question";
      prompt: string;
      options: readonly ChatChoiceOption[];
    }>
  | Readonly<{
      type: "choice-answer";
      questionMessageId: string;
      optionKey: string;
      supersedesAnswerMessageId: string | null;
    }>;

/** Read old chat events as tagged text without rewriting their history. */
export function chatContentOrText(content: ChatContent | undefined, text: string): ChatContent {
  return content ?? { type: "text", text };
}

/** Compatibility text for existing transcript consumers. */
export function chatContentText(content: ChatContent): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "choice-question":
      return content.prompt;
    case "choice-answer":
      return content.optionKey;
  }
}

/** Legacy quoted context retained for wire compatibility. */
export type ChatContext = Readonly<{
  revisionId?: string;
  semanticId?: string;
  domHint?: string | null;
  textQuote?: TextQuote;
  boardAnchor?: BoardAnchor;
}>;

export type ChatAttachment = Readonly<{
  hash: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
}>;

type ChatReferenceBase = Readonly<{
  label: string;
}>;

/**
 * Durable, typed chat references. Every variant carries the stable identity
 * needed to resolve it again; labels are presentation hints, never identity.
 */
export type ChatReference =
  | (ChatReferenceBase &
      Readonly<{
        kind: "file";
        hash: string;
        artifactId?: string;
        revisionId?: string;
      }>)
  | (ChatReferenceBase &
      Readonly<{
        kind: "document";
        artifactId: string;
        revisionId?: string;
      }>)
  | (ChatReferenceBase &
      Readonly<{
        kind: "selection";
        artifactId: string;
        revisionId: string;
        textQuote?: TextQuote;
        semanticId?: string;
        boardAnchor?: BoardAnchor;
      }>)
  | (ChatReferenceBase &
      Readonly<{
        kind: "comment";
        artifactId: string;
        revisionId?: string;
        intentId: string;
      }>)
  | (ChatReferenceBase &
      Readonly<{
        kind: "task";
        artifactId: string;
        workId: string;
      }>)
  | (ChatReferenceBase &
      Readonly<{
        kind: "whiteboard";
        artifactId: string;
        revisionId?: string;
        elementIds?: readonly string[];
        anchorIds?: readonly string[];
      }>);
