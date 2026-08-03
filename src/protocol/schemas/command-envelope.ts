/**
 * JSON Schemas for the public command protocol. Schemas are data,
 * versioned independently from implementation code.
 */

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
      format: { enum: ["html", "markdown"] },
      sourcePath: { type: ["string", "null"] },
    },
  },
};
