export const NATIVE_HOOK_BIND_REQUEST_PROTOCOL = "tweakloop.native-hook-bind/v1" as const;
export const NATIVE_HOOK_BINDING_PROTOCOL = "tweakloop.native-hook-binding/v1" as const;
export const NATIVE_HOOK_OBSERVE_REQUEST_PROTOCOL = "tweakloop.native-hook-observe/v1" as const;
export const NATIVE_HOOK_OBSERVATION_PROTOCOL = "tweakloop.native-hook-observation/v1" as const;

export const NATIVE_HOOK_CLIENTS = ["codex", "claude-code", "cursor"] as const;
export type NativeHookClient = (typeof NATIVE_HOOK_CLIENTS)[number];

export type NativeHookBindRequest = Readonly<{
  protocol: typeof NATIVE_HOOK_BIND_REQUEST_PROTOCOL;
  sessionId: string;
  runtimeCapability: string;
  client: NativeHookClient;
  profileId: string;
  nativeConversationId: string;
  bindingSecret: string;
}>;

export type NativeHookObserveRequest = Readonly<{
  protocol: typeof NATIVE_HOOK_OBSERVE_REQUEST_PROTOCOL;
  client: NativeHookClient;
  profileId: string;
  nativeConversationId: string;
  bindingSecret: string;
}>;

export type NativeHookBindingResponse = Readonly<{
  protocol: typeof NATIVE_HOOK_BINDING_PROTOCOL;
  kind: "bound";
  sessionId: string;
  client: NativeHookClient;
  unchanged: boolean;
}>;

export type NativeHookObservation =
  | Readonly<{
      protocol: typeof NATIVE_HOOK_OBSERVATION_PROTOCOL;
      kind: "none";
    }>
  | Readonly<{
      protocol: typeof NATIVE_HOOK_OBSERVATION_PROTOCOL;
      kind: "continue";
      sessionId: string;
      messageId: string;
    }>;

export class NativeHookProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeHookProtocolError";
  }
}

export function parseNativeHookBindRequest(value: unknown): NativeHookBindRequest {
  const input = requireRecord(value, "native hook bind request");
  requireClosedKeys(input, [
    "protocol",
    "sessionId",
    "runtimeCapability",
    "client",
    "profileId",
    "nativeConversationId",
    "bindingSecret",
  ]);
  if (input.protocol !== NATIVE_HOOK_BIND_REQUEST_PROTOCOL) {
    invalid("native-hook.protocol-invalid", "native hook bind protocol is invalid");
  }
  return {
    protocol: NATIVE_HOOK_BIND_REQUEST_PROTOCOL,
    sessionId: requireString(input.sessionId, "sessionId", 256),
    runtimeCapability: requireSecret(input.runtimeCapability, "runtimeCapability"),
    client: requireClient(input.client),
    profileId: requireString(input.profileId, "profileId", 1024),
    nativeConversationId: requireString(input.nativeConversationId, "nativeConversationId", 1024),
    bindingSecret: requireSecret(input.bindingSecret, "bindingSecret"),
  };
}

export function parseNativeHookObserveRequest(value: unknown): NativeHookObserveRequest {
  const input = requireRecord(value, "native hook observe request");
  requireClosedKeys(input, [
    "protocol",
    "client",
    "profileId",
    "nativeConversationId",
    "bindingSecret",
  ]);
  if (input.protocol !== NATIVE_HOOK_OBSERVE_REQUEST_PROTOCOL) {
    invalid("native-hook.protocol-invalid", "native hook observe protocol is invalid");
  }
  return {
    protocol: NATIVE_HOOK_OBSERVE_REQUEST_PROTOCOL,
    client: requireClient(input.client),
    profileId: requireString(input.profileId, "profileId", 1024),
    nativeConversationId: requireString(input.nativeConversationId, "nativeConversationId", 1024),
    bindingSecret: requireSecret(input.bindingSecret, "bindingSecret"),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("native-hook.request-invalid", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireClosedKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    invalid(
      "native-hook.request-invalid",
      `native hook request contains unsupported fields: ${unknown.sort().join(", ")}`,
    );
  }
}

function requireClient(value: unknown): NativeHookClient {
  if (typeof value !== "string" || !NATIVE_HOOK_CLIENTS.includes(value as NativeHookClient)) {
    invalid("native-hook.client-invalid", "client must be codex, claude-code, or cursor");
  }
  return value as NativeHookClient;
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    hasAsciiControlCharacter(value)
  ) {
    invalid(
      "native-hook.request-invalid",
      `${label} must be a non-empty string without control characters`,
    );
  }
  return value;
}

function requireSecret(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 1024 ||
    hasAsciiControlCharacter(value)
  ) {
    invalid("native-hook.request-invalid", `${label} has an invalid format`);
  }
  return value;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function invalid(code: string, message: string): never {
  throw new NativeHookProtocolError(code, message);
}
