import type { SemanticSceneRequest, SemanticSceneResponse } from "../whiteboard/semantic-scene.js";
import type { DaemonConnection } from "./daemon-client.js";

export const WHITEBOARD_AUTOMATION_MINT_PROTOCOL =
  "tweakloop.whiteboard-automation-mint/v1" as const;
export const WHITEBOARD_AUTOMATION_TOKEN_PROTOCOL =
  "tweakloop.whiteboard-automation-token/v1" as const;
export const WHITEBOARD_AUTOMATION_OPERATION_ID = "whiteboard.semantic-scene.apply.v1" as const;
export const WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION = 1 as const;

type AutomationTokenMint = Readonly<{
  protocol: typeof WHITEBOARD_AUTOMATION_TOKEN_PROTOCOL;
  automationToken: string;
  expiresAt: number;
  operationId: typeof WHITEBOARD_AUTOMATION_OPERATION_ID;
  routeSetVersion: typeof WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION;
}>;

export class WhiteboardAutomationClientError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options: Readonly<{
      status?: number;
      retryable?: boolean;
      details?: Readonly<Record<string, unknown>>;
    }> = {},
  ) {
    super(message);
    this.name = "WhiteboardAutomationClientError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export async function applyWhiteboardSemanticScene(
  connection: DaemonConnection,
  input: Readonly<{
    sessionId: string;
    runtimeCapability: string;
    request: SemanticSceneRequest;
  }>,
  options: Readonly<{ fetch?: typeof fetch }> = {},
): Promise<SemanticSceneResponse> {
  const request = input.request;
  const fetcher = options.fetch ?? fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const minted = await mintWhiteboardAutomationToken(connection, input, fetcher);
      return await applyWithAutomationToken(connection, minted.automationToken, request, fetcher);
    } catch (error) {
      if (attempt === 0 && shouldRetryWithFreshToken(error)) continue;
      throw error;
    }
  }
  throw new WhiteboardAutomationClientError(
    "whiteboard.automation-retry-exhausted",
    "whiteboard automation retry was exhausted",
  );
}

export async function mintWhiteboardAutomationToken(
  connection: DaemonConnection,
  input: Readonly<{
    sessionId: string;
    runtimeCapability: string;
    request: SemanticSceneRequest;
  }>,
  fetcher: typeof fetch = fetch,
): Promise<AutomationTokenMint> {
  const body = {
    protocol: WHITEBOARD_AUTOMATION_MINT_PROTOCOL,
    sessionId: input.sessionId,
    runtimeCapability: input.runtimeCapability,
    artifactId: input.request.artifactId,
    method: "POST" as const,
    operationId: WHITEBOARD_AUTOMATION_OPERATION_ID,
    routeSetVersion: WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
    request: input.request,
  };
  let response: Response;
  try {
    response = await fetcher(new URL("/api/v1/automation/whiteboard-tokens", connection.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw transportUncertain("whiteboard automation token response was not received");
  }
  const parsed = await parseResponse(response);
  if (!response.ok) throw responseError(response.status, parsed);
  if (
    !isRecord(parsed) ||
    parsed.protocol !== WHITEBOARD_AUTOMATION_TOKEN_PROTOCOL ||
    typeof parsed.automationToken !== "string" ||
    parsed.automationToken.length < 32 ||
    parsed.automationToken.length > 1024 ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    parsed.operationId !== WHITEBOARD_AUTOMATION_OPERATION_ID ||
    parsed.routeSetVersion !== WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION
  ) {
    throw new WhiteboardAutomationClientError(
      "whiteboard.automation-response-invalid",
      "daemon returned an invalid whiteboard automation token response",
    );
  }
  return parsed as unknown as AutomationTokenMint;
}

async function applyWithAutomationToken(
  connection: DaemonConnection,
  automationToken: string,
  request: SemanticSceneRequest,
  fetcher: typeof fetch,
): Promise<SemanticSceneResponse> {
  let response: Response;
  try {
    response = await fetcher(
      new URL(
        `/api/v1/whiteboards/${encodeURIComponent(request.artifactId)}/scene-commands`,
        connection.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${automationToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      },
    );
  } catch {
    throw transportUncertain("whiteboard scene response was not received");
  }
  const parsed = await parseResponse(response);
  if (!response.ok) throw responseError(response.status, parsed);
  if (
    !isRecord(parsed) ||
    parsed.protocol !== "tweakloop.whiteboard-scene-response/v1" ||
    parsed.status !== "accepted" ||
    parsed.artifactId !== request.artifactId ||
    parsed.idempotencyKey !== request.idempotencyKey
  ) {
    throw new WhiteboardAutomationClientError(
      "whiteboard.scene-response-invalid",
      "daemon returned an invalid semantic scene response",
    );
  }
  return parsed as unknown as SemanticSceneResponse;
}

async function parseResponse(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw transportUncertain("whiteboard response body was not received");
  }
  if (text.length > 65_536) {
    throw new WhiteboardAutomationClientError(
      "whiteboard.response-too-large",
      "daemon returned an oversized whiteboard response",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WhiteboardAutomationClientError(
      "whiteboard.response-invalid",
      "daemon returned a non-JSON whiteboard response",
    );
  }
}

function transportUncertain(message: string): WhiteboardAutomationClientError {
  return new WhiteboardAutomationClientError("whiteboard.automation-transport-uncertain", message, {
    retryable: true,
  });
}

function responseError(status: number, value: unknown): WhiteboardAutomationClientError {
  const record = isRecord(value) ? value : null;
  const rawCode = typeof record?.code === "string" ? record.code : "whiteboard.request-failed";
  const code = rawCode.slice(0, 128);
  const rawMessage =
    typeof record?.error === "string" ? record.error : `whiteboard request failed (${status})`;
  const message = rawMessage.length <= 1024 ? rawMessage : `${rawMessage.slice(0, 1021)}...`;
  const details = boundedDetails(record?.details);
  return new WhiteboardAutomationClientError(code, message, {
    status,
    retryable: FRESH_TOKEN_RETRY_CODES.has(code),
    details,
  });
}

const FRESH_TOKEN_RETRY_CODES = new Set([
  "whiteboard.automation-token-used",
  "whiteboard.automation-token-expired",
  "whiteboard.automation-token-revoked",
  "whiteboard.automation-token-stale",
]);

function shouldRetryWithFreshToken(error: unknown): boolean {
  return error instanceof WhiteboardAutomationClientError && error.retryable;
}

function boundedDetails(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 16)) {
    if (typeof item === "string") result[key.slice(0, 64)] = item.slice(0, 512);
    else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      result[key.slice(0, 64)] = item;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
