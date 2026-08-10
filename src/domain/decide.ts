import {
  type ChatContent,
  type ChatContext,
  type ChatReference,
  chatContentOrText,
} from "../protocol/chat.js";
import type { ActorRef } from "../protocol/envelopes.js";
import type { IntentTarget } from "../protocol/intents.js";
import type { DomainCommand } from "./commands.js";
import type { DomainEvent } from "./events.js";
import type { ChatMessageState, DomainState, WorkState } from "./state.js";

function defaultProvenance(sourcePath: string | null) {
  return sourcePath === null
    ? ({ kind: "imported-snapshot" } as const)
    : ({ kind: "workspace-source" } as const);
}

function targetFromChatContext(context: ChatContext | null): IntentTarget {
  if (context === null) return {};
  return {
    ...(context.semanticId === undefined ? {} : { semanticId: context.semanticId }),
    ...(context.domHint === undefined ? {} : { domHint: context.domHint }),
    ...(context.textQuote === undefined ? {} : { textQuote: context.textQuote }),
    ...(context.boardAnchor === undefined ? {} : { boardAnchor: context.boardAnchor }),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isStrictRevisionDescendant(
  state: DomainState,
  revisionId: string,
  ancestorRevisionId: string,
): boolean {
  if (revisionId === ancestorRevisionId) return false;
  const visited = new Set<string>();
  let current = state.revisions.get(revisionId) ?? null;
  while (current !== null && current.parentId !== null) {
    if (current.parentId === ancestorRevisionId) return true;
    if (visited.has(current.parentId)) return false;
    visited.add(current.parentId);
    current = state.revisions.get(current.parentId) ?? null;
  }
  return false;
}

function validateAttachment(
  state: DomainState,
  sessionId: string,
  artifactId: string,
  revisionId: string,
  role: "primary" | "opened" | "whiteboard",
): Decision | null {
  const session = state.sessions.get(sessionId);
  if (!session) return reject("session.unknown", `unknown session: ${sessionId}`);
  if (session.status === "ended") return reject("session.ended", `session ${sessionId} has ended`);
  const artifact = state.artifacts.get(artifactId);
  if (!artifact) return reject("artifact.unknown", `unknown artifact: ${artifactId}`);
  const revision = state.revisions.get(revisionId);
  if (!revision || revision.artifactId !== artifactId) {
    return reject(
      "revision.unknown",
      `revision ${revisionId} does not belong to artifact ${artifactId}`,
    );
  }
  const existing = session.artifacts.find((item) => item.artifactId === artifactId);
  if (existing && (existing.attachedRevisionId !== revisionId || existing.role !== role)) {
    return reject(
      "session.attachment-conflict",
      `artifact ${artifactId} is already attached to session ${sessionId}`,
      { existing },
    );
  }
  if (
    role === "primary" &&
    session.primaryArtifactId !== null &&
    session.primaryArtifactId !== artifactId
  ) {
    return reject(
      "session.primary-conflict",
      `session ${sessionId} already has primary artifact ${session.primaryArtifactId}`,
    );
  }
  return null;
}

export type Decision =
  | Readonly<{ ok: true; events: readonly DomainEvent[]; response: unknown }>
  | Readonly<{ ok: false; code: string; message: string; details?: unknown }>;

function reject(code: string, message: string, details?: unknown): Decision {
  return { ok: false, code, message, details };
}

function actorFromAuthor(author: string): ActorRef {
  const separator = author.indexOf(":");
  const kind = author.slice(0, separator);
  const id = author.slice(separator + 1);
  if (separator > 0 && id.length > 0 && ["human", "agent", "system"].includes(kind)) {
    return { kind: kind as ActorRef["kind"], id };
  }
  return { kind: "system", id: author };
}

function answerChain(
  state: DomainState,
  questionMessageId: string,
): Readonly<{
  answers: readonly ChatMessageState[];
  current: ChatMessageState | null;
  ambiguous: boolean;
}> {
  const answers = [...state.chat.values()].filter(
    (message) =>
      message.content.type === "choice-answer" &&
      message.content.questionMessageId === questionMessageId,
  );
  const superseded = new Set(
    answers.flatMap((message) =>
      message.content.type === "choice-answer" && message.content.supersedesAnswerMessageId !== null
        ? [message.content.supersedesAnswerMessageId]
        : [],
    ),
  );
  const current = answers.filter((message) => !superseded.has(message.messageId));
  return {
    answers,
    current: current.length === 1 ? (current[0] ?? null) : null,
    ambiguous: answers.length > 0 && current.length !== 1,
  };
}

function validateChatContent(
  state: DomainState,
  command: Extract<DomainCommand, { type: "chat.send" }>,
  content: ChatContent,
): string | Decision {
  if (content.type === "text") return content.text;
  const actor = command.actor ?? actorFromAuthor(command.author);
  const sessionId = command.sessionId ?? null;
  if (command.author !== `${actor.kind}:${actor.id}`) {
    return reject(
      "chat.actor-author-mismatch",
      "typed chat authorship must match the authenticated actor",
    );
  }

  if (content.type === "choice-question") {
    if (actor.kind !== "agent") {
      return reject("chat.question-agent-required", "only an agent may ask a choice question");
    }
    if (sessionId === null) {
      return reject(
        "chat.question-session-required",
        "a choice question requires an exact session",
      );
    }
    const session = state.sessions.get(sessionId);
    if (!session) return reject("chat.question-session-unknown", `unknown session: ${sessionId}`);
    if (session.status !== "active") {
      return reject("chat.question-session-inactive", `session ${sessionId} is not active`);
    }
    if (session.agentId !== actor.id) {
      return reject(
        "chat.question-session-owner-mismatch",
        `agent ${actor.id} does not own session ${sessionId}`,
      );
    }
    if (content.prompt.trim().length === 0) {
      return reject("chat.question-prompt-required", "a choice question requires a prompt");
    }
    if (content.options.length < 2 || content.options.length > 8) {
      return reject(
        "chat.question-option-count",
        "a choice question requires between 2 and 8 options",
      );
    }
    if (content.options.some((option) => option.key.trim().length === 0)) {
      return reject("chat.question-option-key-required", "every choice option requires a key");
    }
    if (content.options.some((option) => option.label.trim().length === 0)) {
      return reject("chat.question-option-label-required", "every choice option requires a label");
    }
    if (new Set(content.options.map((option) => option.key)).size !== content.options.length) {
      return reject("chat.question-option-key-duplicate", "choice option keys must be unique");
    }
    if (new Set(content.options.map((option) => option.label)).size !== content.options.length) {
      return reject("chat.question-option-label-duplicate", "choice option labels must be unique");
    }
    return content.prompt;
  }

  if (actor.kind !== "human") {
    return reject("chat.answer-human-required", "only a human may answer a choice question");
  }
  if (sessionId === null) {
    return reject("chat.answer-session-required", "a choice answer requires an exact session");
  }
  const session = state.sessions.get(sessionId);
  if (!session) return reject("chat.answer-session-unknown", `unknown session: ${sessionId}`);
  if (session.status !== "active") {
    return reject("chat.answer-session-inactive", `session ${sessionId} is not active`);
  }
  const question = state.chat.get(content.questionMessageId);
  if (!question) {
    return reject(
      "chat.answer-question-unknown",
      `unknown question message: ${content.questionMessageId}`,
    );
  }
  if (question.content.type !== "choice-question") {
    return reject(
      "chat.answer-question-required",
      `message ${content.questionMessageId} is not a choice question`,
    );
  }
  if (question.sessionId !== sessionId) {
    return reject(
      "chat.answer-session-mismatch",
      `question ${content.questionMessageId} belongs to a different session`,
    );
  }
  const selected = question.content.options.find((option) => option.key === content.optionKey);
  if (!selected) {
    return reject(
      "chat.answer-option-unknown",
      `question ${content.questionMessageId} has no option ${content.optionKey}`,
    );
  }
  const chain = answerChain(state, content.questionMessageId);
  if (chain.ambiguous) {
    return reject(
      "chat.answer-current-ambiguous",
      `question ${content.questionMessageId} has no unique current answer`,
    );
  }
  if (chain.current === null && content.supersedesAnswerMessageId !== null) {
    return reject(
      "chat.answer-supersession-stale",
      "the first answer cannot supersede another message",
    );
  }
  if (chain.current !== null && content.supersedesAnswerMessageId === null) {
    return reject(
      "chat.answer-supersession-required",
      `answer must supersede current answer ${chain.current.messageId}`,
    );
  }
  if (chain.current !== null && content.supersedesAnswerMessageId !== chain.current.messageId) {
    return reject(
      "chat.answer-supersession-stale",
      `answer must supersede current answer ${chain.current.messageId}`,
    );
  }
  return selected.label;
}

function validateRevisionReference(
  state: DomainState,
  revisionId: string,
  artifactId: string,
): Decision | null {
  const revision = state.revisions.get(revisionId);
  if (!revision || revision.artifactId !== artifactId) {
    return reject(
      "revision.unknown",
      `revision ${revisionId} does not belong to artifact ${artifactId}`,
    );
  }
  return null;
}

function validateChatReference(
  state: DomainState,
  reference: ChatReference,
  attachmentHashes: ReadonlySet<string>,
): Decision | null {
  if (reference.kind === "file") {
    if (!attachmentHashes.has(reference.hash)) {
      return reject(
        "attachment.reference-missing",
        `file reference ${reference.hash} has no matching chat attachment`,
      );
    }
    if (reference.artifactId !== undefined && !state.artifacts.has(reference.artifactId)) {
      return reject("artifact.unknown", `unknown referenced artifact: ${reference.artifactId}`);
    }
    if (reference.revisionId !== undefined) {
      const revision = state.revisions.get(reference.revisionId);
      if (
        !revision ||
        (reference.artifactId !== undefined && revision.artifactId !== reference.artifactId)
      ) {
        return reject("revision.unknown", `unknown referenced revision: ${reference.revisionId}`);
      }
    }
    return null;
  }

  const artifact = state.artifacts.get(reference.artifactId);
  if (!artifact) {
    return reject("artifact.unknown", `unknown referenced artifact: ${reference.artifactId}`);
  }

  switch (reference.kind) {
    case "document":
      if (artifact.format === "whiteboard") {
        return reject(
          "chat.reference-kind-mismatch",
          `artifact ${reference.artifactId} is a whiteboard, not a document`,
        );
      }
      return reference.revisionId === undefined
        ? null
        : validateRevisionReference(state, reference.revisionId, reference.artifactId);

    case "selection": {
      const revisionError = validateRevisionReference(
        state,
        reference.revisionId,
        reference.artifactId,
      );
      if (revisionError) return revisionError;
      const boardAnchor = reference.boardAnchor;
      if (boardAnchor === undefined) return null;
      const board = state.artifacts.get(boardAnchor.whiteboardArtifactId);
      if (board?.format !== "whiteboard") {
        return reject(
          "whiteboard.unknown",
          `unknown whiteboard: ${boardAnchor.whiteboardArtifactId}`,
        );
      }
      return boardAnchor.baseRevisionId === undefined
        ? null
        : validateRevisionReference(
            state,
            boardAnchor.baseRevisionId,
            boardAnchor.whiteboardArtifactId,
          );
    }

    case "comment": {
      const intent = state.intents.get(reference.intentId);
      if (!intent) return reject("intent.unknown", `unknown intent: ${reference.intentId}`);
      if (intent.artifactId !== reference.artifactId) {
        return reject(
          "chat.reference-mismatch",
          `intent ${reference.intentId} does not belong to artifact ${reference.artifactId}`,
        );
      }
      if (reference.revisionId !== undefined && reference.revisionId !== intent.revisionId) {
        return reject(
          "chat.reference-stale",
          `intent ${reference.intentId} belongs to revision ${intent.revisionId}, not ${reference.revisionId}`,
        );
      }
      return null;
    }

    case "task": {
      const work = state.work.get(reference.workId);
      if (!work) return reject("work.unknown", `unknown work item: ${reference.workId}`);
      return work.artifactId === reference.artifactId
        ? null
        : reject(
            "chat.reference-mismatch",
            `work ${reference.workId} does not belong to artifact ${reference.artifactId}`,
          );
    }

    case "whiteboard":
      if (artifact.format !== "whiteboard") {
        return reject("whiteboard.unknown", `artifact ${reference.artifactId} is not a whiteboard`);
      }
      return reference.revisionId === undefined
        ? null
        : validateRevisionReference(state, reference.revisionId, reference.artifactId);
  }
}

/**
 * The pure decision boundary: no I/O, no clock, no randomness.
 * Given current state and a command, decide which facts become true.
 */
export function decide(state: DomainState, command: DomainCommand): Decision {
  switch (command.type) {
    case "workspace.open": {
      if (state.workspaceOpened) {
        return {
          ok: true,
          events: [],
          response: { alreadyOpen: true, projectId: state.projectId },
        };
      }
      return {
        ok: true,
        events: [
          {
            type: "workspace.opened",
            workspaceId: command.workspaceId,
            projectId: command.projectId,
            rootPath: command.rootPath,
          },
        ],
        response: { alreadyOpen: false, projectId: command.projectId },
      };
    }

    case "artifact.register": {
      if (state.artifacts.has(command.artifactId)) {
        return reject(
          "artifact.already-registered",
          `artifact ${command.artifactId} is already registered`,
          { artifactId: command.artifactId },
        );
      }
      if (command.sourcePath !== null) {
        for (const existing of state.artifacts.values()) {
          if (existing.sourcePath === command.sourcePath) {
            return reject(
              "artifact.source-already-registered",
              `source ${command.sourcePath} is already registered as ${existing.artifactId}`,
              { artifactId: existing.artifactId },
            );
          }
        }
      }
      return {
        ok: true,
        events: [
          {
            type: "artifact.registered",
            artifactId: command.artifactId,
            name: command.name,
            format: command.format,
            sourcePath: command.sourcePath,
            provenance: command.provenance ?? defaultProvenance(command.sourcePath),
          },
        ],
        response: { artifactId: command.artifactId },
      };
    }

    case "artifact.create": {
      if (state.artifacts.has(command.artifactId)) {
        return reject(
          "artifact.already-registered",
          `artifact ${command.artifactId} is already registered`,
        );
      }
      if (state.revisions.has(command.revisionId)) {
        return reject("revision.duplicate-id", `revision ${command.revisionId} already exists`);
      }
      if (command.sourcePath !== null) {
        for (const existing of state.artifacts.values()) {
          if (existing.sourcePath === command.sourcePath) {
            return reject(
              "artifact.source-already-registered",
              `source ${command.sourcePath} is already registered as ${existing.artifactId}`,
            );
          }
        }
      }
      if (command.attachment !== null) {
        const session = state.sessions.get(command.attachment.sessionId);
        if (!session) {
          return reject("session.unknown", `unknown session: ${command.attachment.sessionId}`);
        }
        if (session.status === "ended") {
          return reject("session.ended", `session ${command.attachment.sessionId} has ended`);
        }
        if (
          command.attachment.role === "primary" &&
          session.primaryArtifactId !== null &&
          session.primaryArtifactId !== command.artifactId
        ) {
          return reject(
            "session.primary-conflict",
            `session ${session.sessionId} already has primary artifact ${session.primaryArtifactId}`,
          );
        }
      }
      const sessionId = command.attachment?.sessionId ?? null;
      const events: DomainEvent[] = [
        {
          type: "artifact.registered",
          artifactId: command.artifactId,
          name: command.name,
          format: command.format,
          sourcePath: command.sourcePath,
          provenance: command.provenance,
        },
        {
          type: "artifact.revision-published",
          artifactId: command.artifactId,
          revisionId: command.revisionId,
          parentId: null,
          seq: 1,
          format: command.format,
          entryPath: command.entryPath,
          entryHash: command.entryHash,
          files: command.files,
          producer: command.producer,
          sourcePath: command.sourcePath,
          sessionId,
        },
      ];
      if (command.attachment !== null) {
        events.push({
          type: "session.artifact-attached",
          sessionId: command.attachment.sessionId,
          artifactId: command.artifactId,
          revisionId: command.revisionId,
          role: command.attachment.role,
        });
      }
      return {
        ok: true,
        events,
        response: {
          artifactId: command.artifactId,
          revisionId: command.revisionId,
          sessionId,
          created: true,
        },
      };
    }

    case "session.open-artifact": {
      const session = state.sessions.get(command.sessionId);
      if (!session) return reject("session.unknown", `unknown session: ${command.sessionId}`);
      if (session.status === "ended") {
        return reject("session.ended", `session ${command.sessionId} has ended`);
      }
      const existingArtifact = state.artifacts.get(command.artifactId);
      if (
        existingArtifact &&
        (existingArtifact.sourcePath !== command.sourcePath ||
          existingArtifact.format !== command.format)
      ) {
        return reject(
          "artifact.identity-conflict",
          `artifact ${command.artifactId} does not match the requested source and format`,
        );
      }
      if (!existingArtifact) {
        for (const candidate of state.artifacts.values()) {
          if (candidate.sourcePath === command.sourcePath) {
            return reject(
              "artifact.source-already-registered",
              `source ${command.sourcePath} is already registered as ${candidate.artifactId}`,
              { artifactId: candidate.artifactId },
            );
          }
        }
      }
      const existingMembership = session.artifacts.find(
        (item) => item.artifactId === command.artifactId,
      );
      if (
        command.role === "primary" &&
        session.primaryArtifactId !== null &&
        session.primaryArtifactId !== command.artifactId
      ) {
        return reject(
          "session.primary-conflict",
          `session ${command.sessionId} already has primary artifact ${session.primaryArtifactId}`,
        );
      }
      const headId = state.heads.get(command.artifactId);
      const head = headId === undefined ? undefined : state.revisions.get(headId);
      const unchanged = head?.entryHash === command.entryHash;
      if (!unchanged && state.revisions.has(command.revisionId)) {
        return reject("revision.duplicate-id", `revision ${command.revisionId} already exists`);
      }
      const revisionId = unchanged && head ? head.revisionId : command.revisionId;
      const revisionSeq = unchanged && head ? head.seq : (head?.seq ?? 0) + 1;
      const events: DomainEvent[] = [];
      if (!existingArtifact) {
        events.push({
          type: "artifact.registered",
          artifactId: command.artifactId,
          name: command.name,
          format: command.format,
          sourcePath: command.sourcePath,
          provenance: command.provenance,
        });
      }
      if (!unchanged) {
        events.push({
          type: "artifact.revision-published",
          artifactId: command.artifactId,
          revisionId,
          parentId: head?.revisionId ?? null,
          seq: revisionSeq,
          format: command.format,
          entryPath: command.entryPath,
          entryHash: command.entryHash,
          files: command.files,
          producer: command.producer,
          sourcePath: command.sourcePath,
          sessionId: command.sessionId,
        });
      }
      if (!existingMembership) {
        events.push({
          type: "session.artifact-attached",
          sessionId: command.sessionId,
          artifactId: command.artifactId,
          revisionId,
          role: command.role,
        });
      }
      return {
        ok: true,
        events,
        response: {
          sessionId: command.sessionId,
          artifactId: command.artifactId,
          revisionId,
          seq: revisionSeq,
          created: !existingArtifact,
          unchanged,
          alreadyAttached: existingMembership !== undefined,
          attachedRevisionId: existingMembership?.attachedRevisionId ?? revisionId,
        },
      };
    }

    case "artifact.publish": {
      const artifact = state.artifacts.get(command.artifactId);
      if (!artifact) {
        return reject("artifact.unknown", `unknown artifact: ${command.artifactId}`);
      }
      const headId = state.heads.get(command.artifactId);
      const head = headId !== undefined ? state.revisions.get(headId) : undefined;
      if (head && head.entryHash === command.entryHash) {
        return {
          ok: true,
          events: [],
          response: { unchanged: true, revisionId: head.revisionId, seq: head.seq },
        };
      }
      const seq = (head?.seq ?? 0) + 1;
      return {
        ok: true,
        events: [
          {
            type: "artifact.revision-published",
            artifactId: command.artifactId,
            revisionId: command.revisionId,
            parentId: head?.revisionId ?? null,
            seq,
            format: command.format,
            entryPath: command.entryPath,
            entryHash: command.entryHash,
            files: command.files,
            producer: command.producer,
            sourcePath: command.sourcePath,
            sessionId: command.sessionId ?? null,
          },
        ],
        response: { unchanged: false, revisionId: command.revisionId, seq },
      };
    }

    case "review.submit-batch": {
      if (!state.artifacts.has(command.artifactId)) {
        return reject("artifact.unknown", `unknown artifact: ${command.artifactId}`);
      }
      const revision = state.revisions.get(command.revisionId);
      if (!revision || revision.artifactId !== command.artifactId) {
        return reject(
          "revision.unknown",
          `revision ${command.revisionId} does not belong to artifact ${command.artifactId}`,
        );
      }
      const sourceMessageId = command.sourceMessageId ?? null;
      if (sourceMessageId !== null) {
        const message = state.chat.get(sourceMessageId);
        if (!message) {
          return reject("chat.message-unknown", `unknown chat message: ${sourceMessageId}`);
        }
        if (!message.author.startsWith("human:")) {
          return reject(
            "chat.message-agent-authored",
            `agent-authored chat message ${sourceMessageId} cannot become human review work`,
          );
        }
        if (message.promotedIntentId !== null || message.promotedWorkId !== null) {
          return reject(
            "chat.message-already-promoted",
            `chat message ${sourceMessageId} is already tracked as work`,
          );
        }
        if (message.artifactId === null) {
          return reject(
            "chat.message-artifact-required",
            `chat message ${sourceMessageId} is not attached to an artifact`,
          );
        }
        if (message.artifactId !== command.artifactId) {
          return reject(
            "chat.message-artifact-mismatch",
            `chat message ${sourceMessageId} belongs to artifact ${message.artifactId}`,
          );
        }
        const headRevisionId = state.heads.get(message.artifactId) ?? null;
        const contextualRevisionId =
          message.context?.revisionId ?? message.context?.boardAnchor?.baseRevisionId ?? null;
        if (
          headRevisionId !== command.revisionId ||
          (contextualRevisionId !== null && contextualRevisionId !== command.revisionId)
        ) {
          return reject(
            "chat.message-base-revision-mismatch",
            `chat message ${sourceMessageId} cannot be tracked from revision ${command.revisionId}`,
            { headRevisionId, contextualRevisionId },
          );
        }
        if (command.intents.length !== 1 || command.intents[0]?.intentType !== "comment") {
          return reject(
            "chat.message-intent-mismatch",
            "tracking a chat message requires exactly one comment intent",
          );
        }
        const intent = command.intents[0];
        const expectedTarget = targetFromChatContext(message.context);
        const expectedBody = { text: message.text, sourceMessageId };
        if (
          canonicalJson(intent.target) !== canonicalJson(expectedTarget) ||
          canonicalJson(intent.body) !== canonicalJson(expectedBody)
        ) {
          return reject(
            "chat.message-content-mismatch",
            `chat message ${sourceMessageId} text or context was changed during promotion`,
          );
        }
        if (
          (command.sessionId ?? null) !== message.sessionId ||
          (command.assigneeAgentId ?? null) !== message.recipientAgentId
        ) {
          return reject(
            "chat.message-routing-mismatch",
            `chat message ${sourceMessageId} session or assigned agent was changed during promotion`,
          );
        }
      }
      for (const intent of command.intents) {
        if (state.intents.has(intent.intentId)) {
          return reject("intent.duplicate-id", `intent ${intent.intentId} already exists`);
        }
      }
      const intentIds = command.intents.map((intent) => intent.intentId);
      const events: DomainEvent[] = [
        {
          type: "review.batch-submitted",
          batchId: command.batchId,
          artifactId: command.artifactId,
          revisionId: command.revisionId,
          intentIds,
          sourceMessageId,
          assigneeAgentId: command.assigneeAgentId ?? null,
          sessionId: command.sessionId ?? null,
        },
        ...command.intents.map(
          (intent): DomainEvent => ({
            type: "intent.created",
            intentId: intent.intentId,
            batchId: command.batchId,
            artifactId: command.artifactId,
            revisionId: command.revisionId,
            intentType: intent.intentType,
            target: intent.target,
            body: intent.body,
            sourceMessageId,
          }),
        ),
        {
          type: "work.created",
          workId: command.workId,
          artifactId: command.artifactId,
          baseRevisionId: command.revisionId,
          intentIds,
          sourceMessageId,
          assigneeAgentId: command.assigneeAgentId ?? null,
          sessionId: command.sessionId ?? null,
        },
      ];
      return {
        ok: true,
        events,
        response: { batchId: command.batchId, workId: command.workId, intentIds },
      };
    }

    case "review.submit-comments": {
      if (!state.artifacts.has(command.artifactId)) {
        return reject("artifact.unknown", `unknown artifact: ${command.artifactId}`);
      }
      const revision = state.revisions.get(command.revisionId);
      if (!revision || revision.artifactId !== command.artifactId) {
        return reject(
          "revision.unknown",
          `revision ${command.revisionId} does not belong to artifact ${command.artifactId}`,
        );
      }
      for (const intent of command.intents) {
        if (intent.intentType !== "comment") {
          return reject("intent.comment-required", "comment-only review accepts comment intents");
        }
        if (state.intents.has(intent.intentId)) {
          return reject("intent.duplicate-id", `intent ${intent.intentId} already exists`);
        }
      }
      const intentIds = command.intents.map((intent) => intent.intentId);
      return {
        ok: true,
        events: [
          {
            type: "review.batch-submitted",
            batchId: command.batchId,
            artifactId: command.artifactId,
            revisionId: command.revisionId,
            intentIds,
            sourceMessageId: null,
            assigneeAgentId: command.assigneeAgentId ?? null,
            sessionId: command.sessionId ?? null,
          },
          ...command.intents.map(
            (intent): DomainEvent => ({
              type: "intent.created",
              intentId: intent.intentId,
              batchId: command.batchId,
              artifactId: command.artifactId,
              revisionId: command.revisionId,
              intentType: "comment",
              target: intent.target,
              body: intent.body,
              sourceMessageId: null,
            }),
          ),
        ],
        response: { batchId: command.batchId, intentIds, tracked: false },
      };
    }

    case "work.create-from-intents": {
      const intents = command.intentIds.map((intentId) => state.intents.get(intentId));
      const missingIndex = intents.indexOf(undefined);
      if (missingIndex >= 0) {
        return reject("intent.unknown", `unknown intent: ${command.intentIds[missingIndex]}`);
      }
      const known = intents.filter((intent) => intent !== undefined);
      const artifactId = known[0]?.artifactId;
      const revisionId = known[0]?.revisionId;
      if (
        artifactId === undefined ||
        revisionId === undefined ||
        known.some((intent) => intent.artifactId !== artifactId || intent.revisionId !== revisionId)
      ) {
        return reject(
          "work.intent-scope-mismatch",
          "tracked intents must belong to one artifact revision",
        );
      }
      const related = [...state.work.values()].filter((work) =>
        command.intentIds.some((intentId) => work.intentIds.includes(intentId)),
      );
      const relatedIds = new Set(related.map((work) => work.workId));
      if (relatedIds.size > 1) {
        return reject("work.intent-conflict", "intents are already linked to different work items");
      }
      const existing = related[0];
      if (existing) {
        if (!command.intentIds.every((intentId) => existing.intentIds.includes(intentId))) {
          return reject("work.intent-conflict", "some intents are linked to other work");
        }
        if (existing.addressed && existing.decisionStatus === "accepted") {
          return {
            ok: true,
            events: [
              {
                type: "decision.reopened",
                decisionId: command.decisionId,
                workId: existing.workId,
                reason: command.reason,
              },
            ],
            response: { workId: existing.workId, created: false, reopened: true },
          };
        }
        return {
          ok: true,
          events: [],
          response: { workId: existing.workId, created: false, reopened: false },
        };
      }
      if (state.work.has(command.workId)) {
        return reject("work.duplicate-id", `work ${command.workId} already exists`);
      }
      return {
        ok: true,
        events: [
          {
            type: "work.created",
            workId: command.workId,
            artifactId,
            baseRevisionId: revisionId,
            intentIds: command.intentIds,
            sourceMessageId: known[0]?.sourceMessageId ?? null,
            assigneeAgentId: command.assigneeAgentId ?? null,
            sessionId: command.sessionId ?? null,
          },
        ],
        response: { workId: command.workId, created: true, reopened: false },
      };
    }

    case "work.claim": {
      const candidates = command.workId
        ? [state.work.get(command.workId)].filter((work) => work !== undefined)
        : [...state.work.values()];
      if (command.workId && candidates.length === 0) {
        return reject("work.unknown", `unknown work item: ${command.workId}`);
      }
      for (const work of candidates) {
        if (work.claim !== null || work.addressed) continue;
        if (work.assigneeAgentId !== null && work.assigneeAgentId !== command.agentId) {
          if (command.workId) {
            return reject(
              "work.assigned-to-other-agent",
              `work ${work.workId} is assigned to ${work.assigneeAgentId}`,
            );
          }
          continue;
        }
        const artifact = state.artifacts.get(work.artifactId);
        const intents = work.intentIds
          .map((id) => state.intents.get(id))
          .filter((intent) => intent !== undefined)
          .map((intent) => ({
            intentId: intent.intentId,
            intentType: intent.intentType,
            target: intent.target,
            body: intent.body,
          }));
        return {
          ok: true,
          events: [
            {
              type: "work.claimed",
              workId: work.workId,
              claimId: command.claimId,
              agentId: command.agentId,
            },
          ],
          response: {
            status: "claimed",
            workId: work.workId,
            claimId: command.claimId,
            agentId: command.agentId,
            artifactId: work.artifactId,
            assigneeAgentId: work.assigneeAgentId,
            sessionId: work.sessionId,
            sourcePath: artifact?.sourcePath ?? null,
            baseRevisionId: work.baseRevisionId,
            intents,
          },
        };
      }
      return { ok: true, events: [], response: { status: "none" } };
    }

    case "work.complete": {
      const work = state.work.get(command.workId);
      if (!work) return reject("work.unknown", `unknown work item: ${command.workId}`);
      if (work.claim === null) {
        return reject("work.not-claimed", `work ${command.workId} has no active claim`);
      }
      if (work.claim.claimId !== command.claimId) {
        return reject(
          "work.stale-claim",
          `claim ${command.claimId} is not the active claim for work ${command.workId}`,
        );
      }
      if (work.claim.agentId !== command.agentId) {
        return reject(
          "work.wrong-agent",
          `agent ${command.agentId} does not own claim ${command.claimId}`,
        );
      }
      if (work.addressed) {
        return reject("work.already-addressed", `work ${command.workId} was already addressed`);
      }
      if (command.revisionId !== null) {
        const revision = state.revisions.get(command.revisionId);
        if (!revision || revision.artifactId !== work.artifactId) {
          return reject(
            "revision.unknown",
            `revision ${command.revisionId} does not belong to artifact ${work.artifactId}`,
          );
        }
        if (!isStrictRevisionDescendant(state, command.revisionId, work.baseRevisionId)) {
          return reject(
            "revision.not-descendant",
            `revision ${command.revisionId} is not newer work derived from base ${work.baseRevisionId}`,
          );
        }
      }
      const addressedIntentIds = command.addressedIntentIds ?? work.intentIds;
      const invalid = validateAddressedIntents(state, work, addressedIntentIds);
      if (invalid) return invalid;
      const addressed = new Set(
        work.intentIds.filter(
          (intentId) => state.intents.get(intentId)?.addressedByWorkId !== null,
        ),
      );
      for (const intentId of addressedIntentIds) addressed.add(intentId);
      const complete = work.intentIds.every((intentId) => addressed.has(intentId));
      if (!complete) {
        return {
          ok: true,
          events: [
            {
              type: "work.progressed",
              workId: command.workId,
              claimId: command.claimId,
              agentId: command.agentId,
              summary: command.summary,
              revisionId: command.revisionId,
              addressedIntentIds,
            },
            {
              type: "work.claim-released",
              workId: command.workId,
              claimId: command.claimId,
              agentId: command.agentId,
              reason: "progress",
            },
          ],
          response: {
            workId: command.workId,
            status: "progressed",
            remainingIntentIds: work.intentIds.filter((intentId) => !addressed.has(intentId)),
          },
        };
      }
      return {
        ok: true,
        events: [
          {
            type: "work.addressed" as const,
            workId: command.workId,
            claimId: command.claimId,
            agentId: command.agentId,
            summary: command.summary,
            revisionId: command.revisionId,
            addressedIntentIds,
          },
        ],
        response: { workId: command.workId, status: "addressed" },
      };
    }

    case "work.progress": {
      const work = state.work.get(command.workId);
      if (!work) return reject("work.unknown", `unknown work item: ${command.workId}`);
      if (work.claim === null) {
        return reject("work.not-claimed", `work ${command.workId} has no active claim`);
      }
      if (work.claim.claimId !== command.claimId) {
        return reject(
          "work.stale-claim",
          `claim ${command.claimId} is not the active claim for work ${command.workId}`,
        );
      }
      if (work.claim.agentId !== command.agentId) {
        return reject(
          "work.wrong-agent",
          `agent ${command.agentId} does not own claim ${command.claimId}`,
        );
      }
      if (command.revisionId !== null) {
        const revision = state.revisions.get(command.revisionId);
        if (!revision || revision.artifactId !== work.artifactId) {
          return reject(
            "revision.unknown",
            `revision ${command.revisionId} does not belong to artifact ${work.artifactId}`,
          );
        }
      }
      const invalid = validateAddressedIntents(state, work, command.addressedIntentIds);
      if (invalid) return invalid;
      const alreadyAddressed = new Set(
        work.intentIds.filter(
          (intentId) => state.intents.get(intentId)?.addressedByWorkId !== null,
        ),
      );
      for (const intentId of command.addressedIntentIds) alreadyAddressed.add(intentId);
      if (work.intentIds.every((intentId) => alreadyAddressed.has(intentId))) {
        return reject(
          "work.progress-would-complete",
          "all intents are addressed; use work.complete to finalize the agent result",
        );
      }
      const events: DomainEvent[] = [
        {
          type: "work.progressed",
          workId: command.workId,
          claimId: command.claimId,
          agentId: command.agentId,
          summary: command.summary,
          revisionId: command.revisionId,
          addressedIntentIds: command.addressedIntentIds,
        },
      ];
      if (command.releaseClaim) {
        events.push({
          type: "work.claim-released",
          workId: command.workId,
          claimId: command.claimId,
          agentId: command.agentId,
          reason: "progress",
        });
      }
      return {
        ok: true,
        events,
        response: {
          workId: command.workId,
          status: "progressed",
          claimReleased: command.releaseClaim,
          remainingIntentIds: work.intentIds.filter((intentId) => !alreadyAddressed.has(intentId)),
        },
      };
    }

    case "work.reclaim": {
      const work = state.work.get(command.workId);
      if (!work) return reject("work.unknown", `unknown work item: ${command.workId}`);
      if (work.addressed) {
        return reject("work.already-addressed", `work ${command.workId} was already addressed`);
      }
      if (work.claim === null || work.claim.claimId !== command.staleClaimId) {
        return reject(
          "work.stale-claim",
          `claim ${command.staleClaimId} is not the active claim for work ${command.workId}`,
        );
      }
      if (work.assigneeAgentId !== null && work.assigneeAgentId !== command.agentId) {
        return reject(
          "work.assigned-to-other-agent",
          `work ${work.workId} is assigned to ${work.assigneeAgentId}`,
        );
      }
      return {
        ok: true,
        events: [
          {
            type: "work.abandoned",
            workId: work.workId,
            claimId: work.claim.claimId,
            agentId: work.claim.agentId,
          },
          {
            type: "work.claimed",
            workId: work.workId,
            claimId: command.claimId,
            agentId: command.agentId,
          },
        ],
        response: {
          status: "claimed",
          recovered: true,
          workId: work.workId,
          claimId: command.claimId,
          agentId: command.agentId,
          artifactId: work.artifactId,
          assigneeAgentId: work.assigneeAgentId,
          sessionId: work.sessionId,
          baseRevisionId: work.baseRevisionId,
        },
      };
    }

    case "decision.accept": {
      if (command.actor.kind !== "human") {
        return reject("decision.human-required", "only a human actor may accept work");
      }
      const work = state.work.get(command.workId);
      if (!work) return reject("work.unknown", `unknown work item: ${command.workId}`);
      if (!work.addressed) {
        return reject("decision.not-addressed", `work ${command.workId} is not addressed`);
      }
      if (work.decisionStatus === "accepted") {
        return reject("decision.already-accepted", `work ${command.workId} is already accepted`);
      }
      return {
        ok: true,
        events: [
          {
            type: "decision.accepted",
            decisionId: command.decisionId,
            workId: command.workId,
            reason: command.reason,
          },
        ],
        response: { workId: command.workId, decision: "accepted" },
      };
    }

    case "decision.reopen": {
      if (command.actor.kind !== "human") {
        return reject("decision.human-required", "only a human actor may reopen work");
      }
      const work = state.work.get(command.workId);
      if (!work) return reject("work.unknown", `unknown work item: ${command.workId}`);
      if (!work.addressed && work.decisionStatus !== "accepted") {
        return reject("decision.not-addressed", `work ${command.workId} is not addressed`);
      }
      const events: DomainEvent[] = [];
      if (work.claim) {
        events.push({
          type: "work.claim-released",
          workId: work.workId,
          claimId: work.claim.claimId,
          agentId: work.claim.agentId,
          reason: "reopened",
        });
      }
      events.push({
        type: "decision.reopened",
        decisionId: command.decisionId,
        workId: command.workId,
        reason: command.reason,
      });
      return {
        ok: true,
        events,
        response: { workId: command.workId, decision: "reopened" },
      };
    }

    case "chat.send": {
      if (state.chat.has(command.messageId)) {
        return reject("chat.message-exists", `chat message already exists: ${command.messageId}`);
      }
      const content = chatContentOrText(command.content, command.text);
      const contentResult = validateChatContent(state, command, content);
      if (typeof contentResult !== "string") return contentResult;
      if (command.artifactId !== null && !state.artifacts.has(command.artifactId)) {
        return reject("artifact.unknown", `unknown artifact: ${command.artifactId}`);
      }
      for (const mention of command.mentions) {
        if (!state.artifacts.has(mention)) {
          return reject("artifact.unknown", `unknown mentioned artifact: ${mention}`);
        }
      }
      const correlatedWorkId = command.workId ?? null;
      const correlatedIntentId = command.intentId ?? null;
      const correlatedWork =
        correlatedWorkId === null ? undefined : state.work.get(correlatedWorkId);
      if (correlatedWorkId !== null && !correlatedWork) {
        return reject("work.unknown", `unknown work item: ${correlatedWorkId}`);
      }
      const correlatedIntent =
        correlatedIntentId === null ? undefined : state.intents.get(correlatedIntentId);
      if (correlatedIntentId !== null && !correlatedIntent) {
        return reject("intent.unknown", `unknown intent: ${correlatedIntentId}`);
      }
      if (
        command.author.startsWith("human:") &&
        command.sessionId != null &&
        correlatedWorkId === null &&
        correlatedIntentId === null
      ) {
        const session = state.sessions.get(command.sessionId);
        if (!session) {
          return reject("session.unknown", `unknown session: ${command.sessionId}`);
        }
        if (session.status !== "active") {
          return reject("session.inactive", `session ${command.sessionId} is not active`);
        }
        if (command.recipientAgentId != null && command.recipientAgentId !== session.agentId) {
          return reject(
            "chat.recipient-not-session-owner",
            `session ${command.sessionId} is owned by ${session.agentId}, not ${command.recipientAgentId}`,
          );
        }
      }
      if (
        command.artifactId !== null &&
        correlatedWork !== undefined &&
        correlatedWork.artifactId !== command.artifactId
      ) {
        return reject(
          "chat.correlation-mismatch",
          `work ${correlatedWorkId} does not belong to artifact ${command.artifactId}`,
        );
      }
      if (
        command.artifactId !== null &&
        correlatedIntent !== undefined &&
        correlatedIntent.artifactId !== command.artifactId
      ) {
        return reject(
          "chat.correlation-mismatch",
          `intent ${correlatedIntentId} does not belong to artifact ${command.artifactId}`,
        );
      }
      const attachments = command.attachments ?? [];
      const attachmentHashes = new Set(attachments.map((attachment) => attachment.hash));
      const references = command.references ?? [];
      for (const reference of references) {
        const invalid = validateChatReference(state, reference, attachmentHashes);
        if (invalid) return invalid;
      }
      return {
        ok: true,
        events: [
          {
            type: "chat.message",
            messageId: command.messageId,
            artifactId: command.artifactId,
            author: command.author,
            text: contentResult,
            content,
            context: command.context,
            mentions: command.mentions,
            references,
            attachments,
            sessionId: command.sessionId ?? null,
            recipientAgentId: command.recipientAgentId ?? null,
            threadId: command.threadId ?? null,
            workId: correlatedWorkId,
            intentId: correlatedIntentId,
          },
        ],
        response: { messageId: command.messageId },
      };
    }

    case "chat.delivery-offer": {
      const message = state.chat.get(command.messageId);
      if (!message) {
        return reject("chat.message-unknown", `unknown chat message: ${command.messageId}`);
      }
      if (!message.author.startsWith("human:")) {
        return reject("chat.delivery-agent-authored", "agent-authored chat is not deliverable");
      }
      if (message.content.type !== "text") {
        return reject(
          "chat.delivery-non-text",
          "typed question answers are consumed through their exact question, not inbound delivery",
        );
      }
      if (
        message.correlatedWorkId !== null ||
        message.correlatedIntentId !== null ||
        message.promotedWorkId !== null ||
        message.promotedIntentId !== null
      ) {
        return reject(
          "chat.delivery-promoted",
          "chat correlated or promoted to work is not independently deliverable",
        );
      }
      if (message.sessionId !== command.sessionId) {
        return reject("chat.delivery-wrong-session", "chat belongs to a different session");
      }
      if (message.recipientAgentId !== null && message.recipientAgentId !== command.agentId) {
        return reject("chat.delivery-wrong-agent", "chat is routed to a different agent");
      }
      const session = state.sessions.get(command.sessionId);
      if (session?.status !== "active") {
        return reject("chat.delivery-session-inactive", "delivery requires an active session");
      }
      if (session.agentId !== command.agentId || session.processNonce !== command.processNonce) {
        return reject(
          "chat.delivery-session-owner-mismatch",
          "delivery agent and process must exactly own the session",
        );
      }
      if (message.delivery?.status === "acknowledged") {
        return reject("chat.delivery-acknowledged", "chat is already acknowledged");
      }
      if (message.delivery?.status === "paused") {
        return reject("chat.delivery-paused", "chat delivery is paused");
      }
      const expectedAttempt = (message.delivery?.attemptNumber ?? 0) + 1;
      if (command.attemptNumber !== expectedAttempt) {
        return reject(
          "chat.delivery-attempt-out-of-order",
          `attempt ${command.attemptNumber} must be ${expectedAttempt}`,
        );
      }
      return {
        ok: true,
        events: [
          {
            type: "chat.delivery-offered",
            messageId: command.messageId,
            sessionId: command.sessionId,
            attemptId: command.attemptId,
            attemptNumber: command.attemptNumber,
            agentId: command.agentId,
            offeredAt: command.offeredAt,
          },
        ],
        response: {
          messageId: command.messageId,
          attemptId: command.attemptId,
          attemptNumber: command.attemptNumber,
          status: "offered",
        },
      };
    }

    case "chat.delivery-acknowledge": {
      const message = state.chat.get(command.messageId);
      if (!message) {
        return reject("chat.message-unknown", `unknown chat message: ${command.messageId}`);
      }
      const session = state.sessions.get(command.sessionId);
      if (session?.status !== "active") {
        return reject(
          "chat.delivery-session-inactive",
          "acknowledgment requires an active session",
        );
      }
      if (session.agentId !== command.agentId || session.processNonce !== command.processNonce) {
        return reject(
          "chat.delivery-session-owner-mismatch",
          "acknowledgment agent and process must exactly own the session",
        );
      }
      if (message.sessionId !== command.sessionId) {
        return reject("chat.delivery-wrong-session", "chat belongs to a different session");
      }
      if (message.recipientAgentId !== null && message.recipientAgentId !== command.agentId) {
        return reject("chat.delivery-wrong-agent", "chat is routed to a different agent");
      }
      const delivery = message.delivery;
      if (delivery?.status !== "offered" || delivery.attemptId !== command.attemptId) {
        return reject(
          "chat.delivery-stale-attempt",
          "acknowledgment requires the latest offered attempt",
        );
      }
      if (delivery.agentId !== command.agentId) {
        return reject("chat.delivery-wrong-agent", "attempt belongs to a different agent");
      }
      return {
        ok: true,
        events: [
          {
            type: "chat.delivery-acknowledged",
            messageId: command.messageId,
            sessionId: command.sessionId,
            attemptId: command.attemptId,
            attemptNumber: delivery.attemptNumber,
            agentId: delivery.agentId,
            offeredAt: delivery.offeredAt,
            acknowledgedAt: command.acknowledgedAt,
          },
        ],
        response: {
          messageId: command.messageId,
          attemptId: command.attemptId,
          attemptNumber: delivery.attemptNumber,
          agentId: delivery.agentId,
          status: "acknowledged",
        },
      };
    }

    case "chat.delivery-pause": {
      const message = state.chat.get(command.messageId);
      if (!message) {
        return reject("chat.message-unknown", `unknown chat message: ${command.messageId}`);
      }
      const delivery = message.delivery;
      if (
        delivery?.status !== "offered" ||
        delivery.attemptId !== command.attemptId ||
        delivery.attemptNumber < 5
      ) {
        return reject(
          "chat.delivery-pause-ineligible",
          "only the fifth current unacknowledged attempt may pause delivery",
        );
      }
      if (message.sessionId === null) {
        return reject("chat.delivery-wrong-session", "deliverable chat requires a session");
      }
      return {
        ok: true,
        events: [
          {
            type: "chat.delivery-paused",
            messageId: command.messageId,
            sessionId: message.sessionId,
            attemptId: delivery.attemptId,
            attemptNumber: delivery.attemptNumber,
            agentId: delivery.agentId,
            offeredAt: delivery.offeredAt,
            pausedAt: command.pausedAt,
            reason: command.reason,
          },
        ],
        response: { messageId: command.messageId, status: "paused", reason: command.reason },
      };
    }

    case "chat.delivery-resume": {
      const message = state.chat.get(command.messageId);
      if (!message) {
        return reject("chat.message-unknown", `unknown chat message: ${command.messageId}`);
      }
      if (message.delivery?.status !== "paused") {
        return reject("chat.delivery-not-paused", "only paused chat delivery may be resumed");
      }
      if (message.sessionId === null) {
        return reject("chat.delivery-wrong-session", "deliverable chat requires a session");
      }
      return {
        ok: true,
        events: [
          {
            type: "chat.delivery-resumed",
            messageId: command.messageId,
            sessionId: message.sessionId,
            resumedAt: command.resumedAt,
          },
        ],
        response: { messageId: command.messageId, status: "resumed" },
      };
    }

    case "session.start": {
      if (state.sessions.has(command.sessionId)) {
        return reject("session.duplicate-id", `session ${command.sessionId} already exists`);
      }
      if (command.artifactId !== null && !state.artifacts.has(command.artifactId)) {
        return reject("artifact.unknown", `unknown artifact: ${command.artifactId}`);
      }
      if (command.artifactId === null && command.baseRevisionId !== null) {
        return reject(
          "session.base-without-artifact",
          "an artifact-free session cannot have a base revision",
        );
      }
      const attachedRevisionId =
        command.artifactId === null
          ? null
          : (command.baseRevisionId ?? state.heads.get(command.artifactId) ?? null);
      if (command.artifactId !== null && attachedRevisionId === null) {
        return reject(
          "revision.required",
          `artifact ${command.artifactId} has no revision to attach`,
        );
      }
      if (command.baseRevisionId !== null) {
        const revision = state.revisions.get(command.baseRevisionId);
        if (!revision || revision.artifactId !== command.artifactId) {
          return reject(
            "revision.unknown",
            `revision ${command.baseRevisionId} does not belong to artifact ${command.artifactId}`,
          );
        }
      }
      const events: DomainEvent[] = [
        {
          type: "session.started",
          sessionId: command.sessionId,
          artifactId: command.artifactId,
          originatingAgentId: command.agentId,
          agentId: command.agentId,
          processNonce: command.processNonce,
          baseRevisionId: command.baseRevisionId,
          title: command.title,
          goal: command.goal,
          predecessorSessionId: null,
          handoffSummary: null,
        },
      ];
      if (command.artifactId !== null && attachedRevisionId !== null) {
        events.push({
          type: "session.artifact-attached",
          sessionId: command.sessionId,
          artifactId: command.artifactId,
          revisionId: attachedRevisionId,
          role: "primary",
        });
      }
      return {
        ok: true,
        events,
        response: {
          sessionId: command.sessionId,
          artifactId: command.artifactId,
          status: "active",
        },
      };
    }

    case "session.attach-artifact": {
      const invalid = validateAttachment(
        state,
        command.sessionId,
        command.artifactId,
        command.revisionId,
        command.role,
      );
      if (invalid) return invalid;
      const session = state.sessions.get(command.sessionId);
      const existing = session?.artifacts.find((item) => item.artifactId === command.artifactId);
      if (existing) {
        return {
          ok: true,
          events: [],
          response: {
            sessionId: command.sessionId,
            artifactId: command.artifactId,
            revisionId: command.revisionId,
            alreadyAttached: true,
          },
        };
      }
      return {
        ok: true,
        events: [
          {
            type: "session.artifact-attached",
            sessionId: command.sessionId,
            artifactId: command.artifactId,
            revisionId: command.revisionId,
            role: command.role,
          },
        ],
        response: {
          sessionId: command.sessionId,
          artifactId: command.artifactId,
          revisionId: command.revisionId,
          alreadyAttached: false,
        },
      };
    }

    case "session.handoff": {
      const existing = state.sessions.get(command.sessionId);
      if (!existing) return reject("session.unknown", `unknown session: ${command.sessionId}`);
      if (existing.agentId !== command.agentId) {
        return reject(
          "session.wrong-agent",
          `agent ${command.agentId} does not own ${command.sessionId}`,
        );
      }
      if (existing.status === "ended") {
        return reject("session.ended", `session ${command.sessionId} has ended`);
      }
      return {
        ok: true,
        events: [
          {
            type: "session.handoff-offered",
            sessionId: command.sessionId,
            agentId: command.agentId,
            toAgentId: command.toAgentId,
            summary: command.summary,
          },
        ],
        response: {
          sessionId: command.sessionId,
          status: "handed-off",
          toAgentId: command.toAgentId,
        },
      };
    }

    case "session.resume": {
      if (state.sessions.has(command.sessionId)) {
        return reject("session.duplicate-id", `session ${command.sessionId} already exists`);
      }
      const predecessor = state.sessions.get(command.predecessorSessionId);
      if (!predecessor) {
        return reject("session.unknown", `unknown session: ${command.predecessorSessionId}`);
      }
      const permitted =
        predecessor.agentId === command.agentId ||
        (predecessor.status === "handed-off" && predecessor.handoffToAgentId === command.agentId);
      if (!permitted) {
        return reject(
          "session.handoff-required",
          `session ${predecessor.sessionId} was not handed off to ${command.agentId}`,
        );
      }
      const primaryArtifactId = predecessor.primaryArtifactId;
      const baseRevisionId =
        primaryArtifactId === null
          ? null
          : (command.baseRevisionId ?? state.heads.get(primaryArtifactId) ?? null);
      if (baseRevisionId !== null) {
        const revision = state.revisions.get(baseRevisionId);
        if (!revision || revision.artifactId !== primaryArtifactId) {
          return reject(
            "revision.unknown",
            `revision ${baseRevisionId} does not belong to artifact ${primaryArtifactId}`,
          );
        }
      }
      if (primaryArtifactId === null && command.baseRevisionId !== null) {
        return reject(
          "session.base-without-artifact",
          "an artifact-free predecessor cannot have a base revision",
        );
      }
      const events: DomainEvent[] = [
        {
          type: "session.started",
          sessionId: command.sessionId,
          artifactId: primaryArtifactId,
          originatingAgentId: predecessor.originatingAgentId,
          agentId: command.agentId,
          processNonce: command.processNonce,
          baseRevisionId,
          title: command.title ?? predecessor.title,
          goal: command.goal ?? predecessor.goal,
          predecessorSessionId: predecessor.sessionId,
          handoffSummary: predecessor.handoffSummary,
        },
      ];
      for (const membership of predecessor.artifacts) {
        events.push({
          type: "session.artifact-attached",
          sessionId: command.sessionId,
          artifactId: membership.artifactId,
          revisionId:
            membership.artifactId === primaryArtifactId && baseRevisionId !== null
              ? baseRevisionId
              : (state.heads.get(membership.artifactId) ?? membership.attachedRevisionId),
          role: membership.role,
        });
      }
      return {
        ok: true,
        events,
        response: {
          sessionId: command.sessionId,
          artifactId: primaryArtifactId,
          predecessorSessionId: predecessor.sessionId,
          status: "active",
        },
      };
    }

    case "session.end": {
      const existing = state.sessions.get(command.sessionId);
      if (!existing) return reject("session.unknown", `unknown session: ${command.sessionId}`);
      if (existing.agentId !== command.agentId) {
        return reject(
          "session.wrong-agent",
          `agent ${command.agentId} does not own ${command.sessionId}`,
        );
      }
      if (existing.status === "ended") {
        return reject("session.ended", `session ${command.sessionId} has already ended`);
      }
      return {
        ok: true,
        events: [
          {
            type: "session.ended",
            sessionId: command.sessionId,
            agentId: command.agentId,
            summary: command.summary,
          },
        ],
        response: { sessionId: command.sessionId, status: "ended" },
      };
    }
  }
}

function validateAddressedIntents(
  state: DomainState,
  work: WorkState,
  intentIds: readonly string[],
): Decision | null {
  for (const intentId of intentIds) {
    if (!work.intentIds.includes(intentId)) {
      return reject(
        "work.foreign-intent",
        `intent ${intentId} does not belong to work ${work.workId}`,
      );
    }
    const addressedBy = state.intents.get(intentId)?.addressedByWorkId;
    if (addressedBy !== null && addressedBy !== undefined && addressedBy !== work.workId) {
      return reject(
        "work.intent-already-addressed",
        `intent ${intentId} was addressed by ${addressedBy}`,
      );
    }
  }
  return null;
}
