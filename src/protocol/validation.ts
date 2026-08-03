import { Ajv } from "ajv";
import type { CommandEnvelope } from "./envelopes.js";
import { commandEnvelopeSchema, commandPayloadSchemas } from "./schemas/command-envelope.js";

export type ValidationOk = Readonly<{ ok: true; envelope: CommandEnvelope }>;
export type ValidationError = Readonly<{ ok: false; code: string; message: string }>;
export type ValidationResult = ValidationOk | ValidationError;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateEnvelope = ajv.compile(commandEnvelopeSchema);
const payloadValidators = new Map(
  Object.entries(commandPayloadSchemas).map(([type, schema]) => [type, ajv.compile(schema)]),
);

export function validateCommand(input: unknown): ValidationResult {
  if (!validateEnvelope(input)) {
    return {
      ok: false,
      code: "protocol.invalid-envelope",
      message: ajv.errorsText(validateEnvelope.errors),
    };
  }
  const envelope = input as CommandEnvelope;
  const validatePayload = payloadValidators.get(envelope.type);
  if (!validatePayload) {
    return {
      ok: false,
      code: "protocol.unknown-command",
      message: `unknown command type: ${envelope.type}`,
    };
  }
  if (!validatePayload(envelope.payload)) {
    return {
      ok: false,
      code: "protocol.invalid-payload",
      message: ajv.errorsText(validatePayload.errors),
    };
  }
  return { ok: true, envelope };
}
