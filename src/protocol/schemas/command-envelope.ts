/**
 * JSON Schemas for the public command protocol. Schemas are data,
 * versioned independently from implementation code.
 */

import { CHAT_ATTACHMENT_MAX_BYTES } from "../chat.js";

export const actorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: {
    kind: { enum: ["human", "agent", "system"] },
    id: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
  },
} as const;

const artifactProvenanceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { enum: ["workspace-source", "imported-snapshot", "generated"] },
    originalName: { type: "string", minLength: 1 },
  },
} as const;

const revisionFilesSchema = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["path", "hash", "mediaType"],
    properties: {
      path: { type: "string", minLength: 1 },
      hash: { type: "string", minLength: 1 },
      mediaType: { type: "string", minLength: 1 },
    },
  },
} as const;

export const commandEnvelopeSchema = {
  $id: "https://tweakloop.dev/schemas/command-envelope/v1.json",
  type: "object",
  additionalProperties: false,
  required: ["protocol", "commandId", "idempotencyKey", "workspaceId", "actor", "type", "payload"],
  properties: {
    protocol: { const: "tweakloop.command/v1" },
    commandId: { type: "string", minLength: 1 },
    idempotencyKey: { type: "string", minLength: 1 },
    workspaceId: { type: "string", minLength: 1 },
    actor: actorSchema,
    type: { type: "string", minLength: 1 },
    expected: {
      type: "object",
      additionalProperties: false,
      required: ["streamId", "streamVersion"],
      properties: {
        streamId: { type: "string", minLength: 1 },
        streamVersion: { type: "integer", minimum: 0 },
      },
    },
    payload: {},
  },
} as const;

export const boardAnchorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["semanticId", "whiteboardArtifactId", "elementAnchor"],
  properties: {
    semanticId: { type: "string", minLength: 1 },
    whiteboardArtifactId: { type: "string", minLength: 1 },
    baseRevisionId: { type: "string", minLength: 1 },
    sceneHash: { type: "string", minLength: 1 },
    draftId: { type: "string", minLength: 1 },
    draftVersion: { type: "integer", minimum: 0 },
    elementAnchor: {
      type: "object",
      additionalProperties: false,
      required: ["anchorId", "elementId"],
      properties: {
        anchorId: { type: "string", minLength: 1 },
        elementId: { type: "string", minLength: 1 },
        version: { type: "integer", minimum: 0 },
        versionNonce: { type: "integer", minimum: 0 },
        type: { type: "string", minLength: 1 },
        label: { type: "string", minLength: 1 },
      },
    },
  },
} as const;

const textQuoteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["exact"],
  properties: {
    exact: { type: "string" },
    prefix: { type: "string" },
    suffix: { type: "string" },
  },
} as const;

const pinnedRevisionProperties = {
  artifactId: { type: "string", minLength: 1 },
  revisionId: { type: "string", minLength: 1 },
} as const;

export const chatAttachmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hash", "fileName", "mediaType", "byteLength"],
  properties: {
    hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    fileName: { type: "string", minLength: 1, maxLength: 255 },
    mediaType: { type: "string", minLength: 1, maxLength: 255 },
    byteLength: { type: "integer", minimum: 0, maximum: CHAT_ATTACHMENT_MAX_BYTES },
  },
} as const;

export const chatContentSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "text"],
      properties: {
        type: { const: "text" },
        text: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "prompt", "options"],
      properties: {
        type: { const: "choice-question" },
        prompt: { type: "string", minLength: 1 },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "label"],
            properties: {
              key: { type: "string", minLength: 1 },
              label: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "questionMessageId", "optionKey", "supersedesAnswerMessageId"],
      properties: {
        type: { const: "choice-answer" },
        questionMessageId: { type: "string", minLength: 1 },
        optionKey: { type: "string", minLength: 1 },
        supersedesAnswerMessageId: { type: ["string", "null"], minLength: 1 },
      },
    },
  ],
} as const;

export const chatReferenceSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "label", "hash"],
      properties: {
        kind: { const: "file" },
        label: { type: "string", minLength: 1 },
        hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        ...pinnedRevisionProperties,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "label", "artifactId"],
      properties: {
        kind: { const: "document" },
        label: { type: "string", minLength: 1 },
        ...pinnedRevisionProperties,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "label", "artifactId", "revisionId"],
      anyOf: [
        { type: "object", required: ["textQuote"], properties: { textQuote: {} } },
        { type: "object", required: ["semanticId"], properties: { semanticId: {} } },
        { type: "object", required: ["boardAnchor"], properties: { boardAnchor: {} } },
      ],
      properties: {
        kind: { const: "selection" },
        label: { type: "string", minLength: 1 },
        ...pinnedRevisionProperties,
        textQuote: {
          ...textQuoteSchema,
          properties: {
            ...textQuoteSchema.properties,
            exact: { type: "string", minLength: 1 },
          },
        },
        semanticId: { type: "string", minLength: 1 },
        boardAnchor: boardAnchorSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "label", "artifactId", "intentId"],
      properties: {
        kind: { const: "comment" },
        label: { type: "string", minLength: 1 },
        ...pinnedRevisionProperties,
        intentId: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "label", "artifactId", "workId"],
      properties: {
        kind: { const: "task" },
        label: { type: "string", minLength: 1 },
        artifactId: { type: "string", minLength: 1 },
        workId: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "label", "artifactId"],
      properties: {
        kind: { const: "whiteboard" },
        label: { type: "string", minLength: 1 },
        ...pinnedRevisionProperties,
        elementIds: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        anchorIds: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
      },
    },
  ],
} as const;

const targetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    semanticId: { type: "string", minLength: 1 },
    domHint: { type: ["string", "null"] },
    textQuote: textQuoteSchema,
    boardAnchor: boardAnchorSchema,
  },
} as const;

/** Payload schema per command type. Unknown types are rejected. */
export const commandPayloadSchemas: Readonly<Record<string, object>> = {
  "workspace.open": {
    $id: "https://tweakloop.dev/schemas/command/workspace-open/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["projectId", "rootPath"],
    properties: {
      projectId: { type: "string", minLength: 1 },
      rootPath: { type: "string", minLength: 1 },
    },
  },
  "artifact.register": {
    $id: "https://tweakloop.dev/schemas/command/artifact-register/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["artifactId", "name", "format"],
    properties: {
      artifactId: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      format: { enum: ["html", "markdown", "whiteboard"] },
      sourcePath: { type: ["string", "null"] },
      provenance: artifactProvenanceSchema,
    },
  },
  "artifact.create": {
    $id: "https://tweakloop.dev/schemas/command/artifact-create/v1.json",
    type: "object",
    additionalProperties: false,
    required: [
      "artifactId",
      "name",
      "format",
      "sourcePath",
      "provenance",
      "revisionId",
      "entryPath",
      "entryHash",
      "files",
      "producer",
      "attachment",
    ],
    properties: {
      artifactId: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      format: { enum: ["html", "markdown", "whiteboard"] },
      sourcePath: { type: ["string", "null"] },
      provenance: artifactProvenanceSchema,
      revisionId: { type: "string", minLength: 1 },
      entryPath: { type: "string", minLength: 1 },
      entryHash: { type: "string", minLength: 1 },
      files: revisionFilesSchema,
      producer: actorSchema,
      attachment: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["sessionId", "role"],
            properties: {
              sessionId: { type: "string", minLength: 1 },
              role: { enum: ["primary", "opened", "whiteboard"] },
            },
          },
        ],
      },
    },
  },
  "session.open-artifact": {
    $id: "https://tweakloop.dev/schemas/command/session-open-artifact/v1.json",
    type: "object",
    additionalProperties: false,
    required: [
      "sessionId",
      "artifactId",
      "name",
      "format",
      "sourcePath",
      "provenance",
      "revisionId",
      "entryPath",
      "entryHash",
      "files",
      "producer",
      "role",
    ],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      artifactId: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      format: { enum: ["html", "markdown", "whiteboard"] },
      sourcePath: { type: "string", minLength: 1 },
      provenance: artifactProvenanceSchema,
      revisionId: { type: "string", minLength: 1 },
      entryPath: { type: "string", minLength: 1 },
      entryHash: { type: "string", minLength: 1 },
      files: revisionFilesSchema,
      producer: actorSchema,
      role: { enum: ["primary", "opened", "whiteboard"] },
    },
  },
  "artifact.publish": {
    $id: "https://tweakloop.dev/schemas/command/artifact-publish/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["artifactId", "revisionId", "format", "entryPath", "entryHash", "files", "producer"],
    properties: {
      artifactId: { type: "string", minLength: 1 },
      revisionId: { type: "string", minLength: 1 },
      format: { enum: ["html", "markdown", "whiteboard"] },
      entryPath: { type: "string", minLength: 1 },
      entryHash: { type: "string", minLength: 1 },
      files: revisionFilesSchema,
      producer: actorSchema,
      sourcePath: { type: ["string", "null"] },
      sessionId: { type: ["string", "null"], minLength: 1 },
    },
  },
  "review.submit-batch": {
    $id: "https://tweakloop.dev/schemas/command/review-submit-batch/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["batchId", "workId", "artifactId", "revisionId", "intents"],
    properties: {
      batchId: { type: "string", minLength: 1 },
      workId: { type: "string", minLength: 1 },
      artifactId: { type: "string", minLength: 1 },
      revisionId: { type: "string", minLength: 1 },
      sourceMessageId: { type: ["string", "null"], minLength: 1 },
      assigneeAgentId: { type: ["string", "null"], minLength: 1 },
      sessionId: { type: ["string", "null"], minLength: 1 },
      intents: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["intentId", "intentType", "target", "body"],
          properties: {
            intentId: { type: "string", minLength: 1 },
            intentType: {
              enum: [
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
              ],
            },
            target: targetSchema,
            body: { type: "object" },
          },
        },
      },
    },
  },
  "review.submit-comments": {
    $id: "https://tweakloop.dev/schemas/command/review-submit-comments/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["batchId", "artifactId", "revisionId", "intents"],
    properties: {
      batchId: { type: "string", minLength: 1 },
      artifactId: { type: "string", minLength: 1 },
      revisionId: { type: "string", minLength: 1 },
      assigneeAgentId: { type: ["string", "null"], minLength: 1 },
      sessionId: { type: ["string", "null"], minLength: 1 },
      intents: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["intentId", "intentType", "target", "body"],
          properties: {
            intentId: { type: "string", minLength: 1 },
            intentType: { const: "comment" },
            target: targetSchema,
            body: { type: "object" },
          },
        },
      },
    },
  },
  "work.create-from-intents": {
    $id: "https://tweakloop.dev/schemas/command/work-create-from-intents/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["workId", "intentIds", "decisionId", "reason"],
    properties: {
      workId: { type: "string", minLength: 1 },
      intentIds: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
      decisionId: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1 },
      assigneeAgentId: { type: ["string", "null"], minLength: 1 },
      sessionId: { type: ["string", "null"], minLength: 1 },
    },
  },
  "session.attach-artifact": {
    $id: "https://tweakloop.dev/schemas/command/session-attach-artifact/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "artifactId", "revisionId", "role"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      artifactId: { type: "string", minLength: 1 },
      revisionId: { type: "string", minLength: 1 },
      role: { enum: ["primary", "opened", "whiteboard"] },
    },
  },
  "chat.send": {
    $id: "https://tweakloop.dev/schemas/command/chat-send/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["messageId"],
    anyOf: [
      {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string", minLength: 1 } },
      },
      {
        type: "object",
        required: ["references"],
        properties: { references: { type: "array", minItems: 1 } },
      },
      {
        type: "object",
        required: ["attachments"],
        properties: { attachments: { type: "array", minItems: 1 } },
      },
      {
        type: "object",
        required: ["content"],
        properties: { content: chatContentSchema },
      },
    ],
    properties: {
      messageId: { type: "string", minLength: 1 },
      artifactId: { type: ["string", "null"] },
      text: { type: "string" },
      content: chatContentSchema,
      mentions: { type: "array", items: { type: "string", minLength: 1 } },
      references: { type: "array", items: chatReferenceSchema },
      attachments: { type: "array", items: chatAttachmentSchema },
      context: {
        type: "object",
        additionalProperties: false,
        properties: {
          revisionId: { type: "string", minLength: 1 },
          semanticId: { type: "string", minLength: 1 },
          domHint: { type: ["string", "null"] },
          textQuote: textQuoteSchema,
          boardAnchor: boardAnchorSchema,
        },
      },
      sessionId: { type: ["string", "null"], minLength: 1 },
      recipientAgentId: { type: ["string", "null"], minLength: 1 },
      threadId: { type: ["string", "null"], minLength: 1 },
      workId: { type: ["string", "null"], minLength: 1 },
      intentId: { type: ["string", "null"], minLength: 1 },
    },
  },
  "chat.delivery-offer": {
    $id: "https://tweakloop.dev/schemas/command/chat-delivery-offer/v1.json",
    type: "object",
    additionalProperties: false,
    required: [
      "messageId",
      "sessionId",
      "agentId",
      "processNonce",
      "attemptId",
      "attemptNumber",
      "offeredAt",
    ],
    properties: {
      messageId: { type: "string", minLength: 1 },
      sessionId: { type: "string", minLength: 1 },
      agentId: { type: "string", minLength: 1 },
      processNonce: { type: "string", minLength: 1 },
      attemptId: { type: "string", minLength: 1 },
      attemptNumber: { type: "integer", minimum: 1 },
      offeredAt: { type: "string", minLength: 1 },
    },
  },
  "chat.delivery-acknowledge": {
    $id: "https://tweakloop.dev/schemas/command/chat-delivery-acknowledge/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["messageId", "sessionId", "agentId", "processNonce", "attemptId", "acknowledgedAt"],
    properties: {
      messageId: { type: "string", minLength: 1 },
      sessionId: { type: "string", minLength: 1 },
      agentId: { type: "string", minLength: 1 },
      processNonce: { type: "string", minLength: 1 },
      attemptId: { type: "string", minLength: 1 },
      acknowledgedAt: { type: "string", minLength: 1 },
    },
  },
  "chat.delivery-pause": {
    $id: "https://tweakloop.dev/schemas/command/chat-delivery-pause/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["messageId", "attemptId", "pausedAt", "reason"],
    properties: {
      messageId: { type: "string", minLength: 1 },
      attemptId: { type: "string", minLength: 1 },
      pausedAt: { type: "string", minLength: 1 },
      reason: { const: "retry-budget-exhausted" },
    },
  },
  "chat.delivery-resume": {
    $id: "https://tweakloop.dev/schemas/command/chat-delivery-resume/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["messageId", "resumedAt"],
    properties: {
      messageId: { type: "string", minLength: 1 },
      resumedAt: { type: "string", minLength: 1 },
    },
  },
  "work.claim": {
    $id: "https://tweakloop.dev/schemas/command/work-claim/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["claimId", "agentId"],
    properties: {
      claimId: { type: "string", minLength: 1 },
      agentId: { type: "string", minLength: 1 },
      workId: { type: ["string", "null"], minLength: 1 },
    },
  },
  "work.complete": {
    $id: "https://tweakloop.dev/schemas/command/work-complete/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["workId", "claimId", "agentId", "summary"],
    properties: {
      workId: { type: "string", minLength: 1 },
      claimId: { type: "string", minLength: 1 },
      agentId: { type: "string", minLength: 1 },
      summary: { type: "string", minLength: 1 },
      revisionId: { type: ["string", "null"] },
      addressedIntentIds: { type: "array", items: { type: "string", minLength: 1 } },
    },
  },
  "work.progress": {
    $id: "https://tweakloop.dev/schemas/command/work-progress/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["workId", "claimId", "agentId", "summary", "addressedIntentIds"],
    properties: {
      workId: { type: "string", minLength: 1 },
      claimId: { type: "string", minLength: 1 },
      agentId: { type: "string", minLength: 1 },
      summary: { type: "string", minLength: 1 },
      revisionId: { type: ["string", "null"] },
      addressedIntentIds: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      releaseClaim: { type: "boolean" },
    },
  },
  "work.reclaim": {
    $id: "https://tweakloop.dev/schemas/command/work-reclaim/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["workId", "staleClaimId", "claimId", "agentId"],
    properties: {
      workId: { type: "string", minLength: 1 },
      staleClaimId: { type: "string", minLength: 1 },
      claimId: { type: "string", minLength: 1 },
      agentId: { type: "string", minLength: 1 },
    },
  },
  "decision.accept": {
    $id: "https://tweakloop.dev/schemas/command/decision-accept/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["decisionId", "workId"],
    properties: {
      decisionId: { type: "string", minLength: 1 },
      workId: { type: "string", minLength: 1 },
      reason: { type: ["string", "null"] },
    },
  },
  "decision.reopen": {
    $id: "https://tweakloop.dev/schemas/command/decision-reopen/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["decisionId", "workId", "reason"],
    properties: {
      decisionId: { type: "string", minLength: 1 },
      workId: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1 },
    },
  },
  "session.start": {
    $id: "https://tweakloop.dev/schemas/command/session-start/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "artifactId", "agentId", "processNonce", "title", "goal"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      artifactId: { type: ["string", "null"], minLength: 1 },
      agentId: { type: "string", minLength: 1 },
      processNonce: { type: "string", minLength: 1 },
      runtimeCapabilityHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      baseRevisionId: { type: ["string", "null"], minLength: 1 },
      title: { type: "string", minLength: 1 },
      goal: { type: "string", minLength: 1 },
    },
  },
  "session.handoff": {
    $id: "https://tweakloop.dev/schemas/command/session-handoff/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "agentId", "toAgentId", "summary"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      agentId: { type: "string", minLength: 1 },
      toAgentId: { type: "string", minLength: 1 },
      summary: { type: "string", minLength: 1 },
    },
  },
  "session.resume": {
    $id: "https://tweakloop.dev/schemas/command/session-resume/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "predecessorSessionId", "agentId", "processNonce"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      predecessorSessionId: { type: "string", minLength: 1 },
      agentId: { type: "string", minLength: 1 },
      processNonce: { type: "string", minLength: 1 },
      runtimeCapabilityHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      baseRevisionId: { type: ["string", "null"], minLength: 1 },
      title: { type: ["string", "null"], minLength: 1 },
      goal: { type: ["string", "null"], minLength: 1 },
    },
  },
  "session.end": {
    $id: "https://tweakloop.dev/schemas/command/session-end/v1.json",
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "agentId", "summary"],
    properties: {
      sessionId: { type: "string", minLength: 1 },
      agentId: { type: "string", minLength: 1 },
      summary: { type: "string", minLength: 1 },
    },
  },
};
