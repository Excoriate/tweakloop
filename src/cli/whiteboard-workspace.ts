import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { CommandResult } from "../protocol/envelopes.js";
import { canonicalizeWhiteboardScene } from "../whiteboard/scene.js";
import {
  type DaemonConnection,
  fetchWhiteboardObject,
  getWhiteboardDraft,
  publishWhiteboardDraft,
  putWhiteboardDraft,
  type WhiteboardDraftConflict,
  type WhiteboardDraftMetadata,
} from "./daemon-client.js";

const WORKSPACE_PROTOCOL = "tweakloop.whiteboard-workspace/v1" as const;

type TargetElement = Readonly<{
  elementId: string;
  elementType: string;
  anchorId: string | null;
}>;

type SceneElementIdentity = Readonly<{
  elementId: string;
  elementType: string;
  isDeleted: boolean;
  anchorId: string | null;
}>;

type PendingSync = Readonly<{
  clientSequence: number;
  sceneHash: string;
}>;

type PendingPublish = Readonly<{
  commandId: string;
  idempotencyKey: string;
  revisionId: string;
  draftVersion: number;
  sceneHash: string;
}>;

type WorkspaceState = Readonly<{
  protocol: typeof WORKSPACE_PROTOCOL;
  workspaceId: string;
  scenePath: string;
  artifactId: string;
  draftId: string;
  baseRevisionId: string;
  draftVersion: number;
  sceneHash: string;
  elementIndexHash: string;
  clientId: string;
  nextClientSequence: number;
  agentId: string;
  needsInitialSync: boolean;
  targetElements: readonly TargetElement[];
  pendingSync: PendingSync | null;
  blockedConflict: WhiteboardDraftConflict | null;
  pendingPublish: PendingPublish | null;
  publishedRevisionId: string | null;
}>;

export type WhiteboardWorkspaceCheckout = Readonly<{
  status: "checked-out";
  artifactId: string;
  draftVersion: number;
  sceneHash: string;
  scenePath: string;
  statePath: string;
  targetElementIds: readonly string[];
}>;

export type WhiteboardNativeEditorRoute = Readonly<{
  kind: "native-excalidraw-editor";
  scenePath: string;
  requirement: string;
  blocked: string;
  syncCommand: readonly ["tweak", "whiteboard", "workspace", "sync", string, "--json"];
}>;

export function nativeEditorRoute(scenePath: string): WhiteboardNativeEditorRoute {
  return {
    kind: "native-excalidraw-editor",
    scenePath,
    requirement:
      "open and save this exact file with an Excalidraw editor that owns element schema, versions, nonces, and bindings",
    blocked:
      "if no controllable native Excalidraw editor is available, stop; do not synthesize non-trivial element JSON",
    syncCommand: ["tweak", "whiteboard", "workspace", "sync", scenePath, "--json"],
  };
}

export type WhiteboardWorkspaceSyncResult =
  | Readonly<{
      status: "accepted";
      artifactId: string;
      draftVersion: number;
      sceneHash: string;
      statePath: string;
    }>
  | Readonly<{
      status: "conflict";
      conflict: WhiteboardDraftConflict;
      retained: true;
      statePath: string;
      recovery: "checkout-fresh-or-use-explicit-conflict-resolution";
    }>;

export type WhiteboardWorkspacePublishResult = Readonly<{
  status: "accepted";
  artifactId: string;
  revisionId: string;
  draftVersion: number;
  sceneHash: string;
  unchanged: boolean;
  statePath: string;
}>;

export class WhiteboardWorkspaceError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "WhiteboardWorkspaceError";
    this.code = code;
    this.details = details;
  }
}

type PutDraftInput = Parameters<typeof putWhiteboardDraft>[1];
type PublishDraftInput = Parameters<typeof publishWhiteboardDraft>[1];

export type WhiteboardWorkspaceClient = Readonly<{
  getDraft: (connection: DaemonConnection, artifactId: string) => Promise<WhiteboardDraftMetadata>;
  fetchScene: (connection: DaemonConnection, sceneHash: string) => Promise<Buffer>;
  putDraft: (
    connection: DaemonConnection,
    input: PutDraftInput,
  ) => Promise<WhiteboardDraftMetadata | WhiteboardDraftConflict>;
  publishDraft: (connection: DaemonConnection, input: PublishDraftInput) => Promise<CommandResult>;
}>;

const DEFAULT_CLIENT: WhiteboardWorkspaceClient = {
  getDraft: getWhiteboardDraft,
  fetchScene: fetchWhiteboardObject,
  putDraft: putWhiteboardDraft,
  publishDraft: publishWhiteboardDraft,
};

export type WhiteboardWorkspaceOptions = Readonly<{
  client?: WhiteboardWorkspaceClient;
  newId?: (prefix: string) => string;
}>;

/**
 * A deterministic checkout/sync/publish workflow for agents. Low-level CAS
 * commands remain available, but ordinary callers never shuttle draft IDs,
 * base revisions, sequence numbers, or publication IDs by hand.
 */
export class ManagedWhiteboardWorkspace {
  readonly connection: DaemonConnection;
  readonly client: WhiteboardWorkspaceClient;
  readonly newId: (prefix: string) => string;

  constructor(connection: DaemonConnection, options: WhiteboardWorkspaceOptions = {}) {
    this.connection = connection;
    this.client = options.client ?? DEFAULT_CLIENT;
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  async checkout(
    input: Readonly<{
      artifactId: string;
      scenePath: string;
      agentId: string;
      targetElementIds?: readonly string[];
    }>,
  ): Promise<WhiteboardWorkspaceCheckout> {
    const scenePath = normalizeScenePath(input.scenePath);
    const statePath = whiteboardSyncStatePath(scenePath);
    if (existsSync(scenePath) || existsSync(statePath)) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-exists",
        "checkout refuses to replace an existing scene or sync-state sidecar",
        { scenePath, statePath },
      );
    }

    const draft = await this.client.getDraft(
      this.connection,
      requireText(input.artifactId, "artifactId"),
    );
    const bytes = await this.client.fetchScene(this.connection, draft.sceneHash);
    const canonical = canonicalizeWhiteboardScene(bytes);
    if (
      canonical.hash !== draft.sceneHash ||
      canonical.elementIndexHash !== draft.elementIndexHash
    ) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-object-mismatch",
        "draft metadata does not match the fetched canonical scene",
        {
          expectedSceneHash: draft.sceneHash,
          actualSceneHash: canonical.hash,
          expectedElementIndexHash: draft.elementIndexHash,
          actualElementIndexHash: canonical.elementIndexHash,
        },
      );
    }

    const targetElements = selectTargets(
      sceneElementIdentities(canonical.scene),
      input.targetElementIds ?? [],
    );
    if (draft.artifactId !== input.artifactId) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-response-mismatch",
        "draft response belongs to another artifact",
        { requestedArtifactId: input.artifactId, actualArtifactId: draft.artifactId },
      );
    }
    const startsAfterPublishedRevision = draft.publishedRevisionId !== null;
    const state: WorkspaceState = {
      protocol: WORKSPACE_PROTOCOL,
      workspaceId: this.connection.descriptor.workspaceId,
      scenePath,
      artifactId: draft.artifactId,
      draftId: startsAfterPublishedRevision ? this.newId("draft") : draft.draftId,
      baseRevisionId: draft.publishedRevisionId ?? draft.baseRevisionId,
      draftVersion: startsAfterPublishedRevision ? 0 : draft.draftVersion,
      sceneHash: draft.sceneHash,
      elementIndexHash: draft.elementIndexHash,
      clientId: this.newId("whiteboard_client"),
      nextClientSequence: 1,
      agentId: requireText(input.agentId, "agentId"),
      needsInitialSync: startsAfterPublishedRevision,
      targetElements,
      pendingSync: null,
      blockedConflict: null,
      pendingPublish: null,
      publishedRevisionId: null,
    };

    createWorkspacePair(scenePath, canonical.bytes, statePath, encodeState(state), this.newId);
    return {
      status: "checked-out",
      artifactId: state.artifactId,
      draftVersion: state.draftVersion,
      sceneHash: state.sceneHash,
      scenePath,
      statePath,
      targetElementIds: targetElements.map((target) => target.elementId),
    };
  }

  async sync(scenePathInput: string): Promise<WhiteboardWorkspaceSyncResult> {
    const scenePath = normalizeScenePath(scenePathInput);
    const statePath = whiteboardSyncStatePath(scenePath);
    let state = readState(statePath);
    this.validateBinding(state, scenePath);

    if (state.publishedRevisionId !== null) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-published",
        `workspace was already published as ${state.publishedRevisionId}; check out the new head before editing again`,
      );
    }
    if (state.blockedConflict !== null) return retainedConflict(state.blockedConflict, statePath);

    const canonical = canonicalizeWhiteboardScene(readFileSync(scenePath));
    validateTargets(state.targetElements, sceneElementIdentities(canonical.scene));
    if (state.pendingSync !== null && state.pendingSync.sceneHash !== canonical.hash) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-ambiguous-sync",
        "the scene changed after a sync request with an unknown outcome; restore those bytes and retry before making another edit",
        {
          pendingSceneHash: state.pendingSync.sceneHash,
          currentSceneHash: canonical.hash,
          clientSequence: state.pendingSync.clientSequence,
        },
      );
    }

    const pendingSync =
      state.pendingSync ??
      ({
        clientSequence: state.nextClientSequence,
        sceneHash: canonical.hash,
      } satisfies PendingSync);
    if (state.pendingSync === null) {
      state = { ...state, pendingSync };
      writeState(statePath, state, this.newId);
    }

    const result = await this.client.putDraft(this.connection, {
      artifactId: state.artifactId,
      draftId: state.draftId,
      baseRevisionId: state.baseRevisionId,
      expectedDraftVersion: state.draftVersion,
      clientId: state.clientId,
      clientSequence: pendingSync.clientSequence,
      agentId: state.agentId,
      bytes: canonical.bytes,
    });

    if (result.status === "conflict") {
      const conflicted: WorkspaceState = {
        ...state,
        nextClientSequence: pendingSync.clientSequence + 1,
        pendingSync: null,
        blockedConflict: result,
      };
      writeState(statePath, conflicted, this.newId);
      return retainedConflict(result, statePath);
    }

    assertAcceptedDraft(result, state, canonical.hash, canonical.elementIndexHash);
    const accepted: WorkspaceState = {
      ...state,
      draftVersion: result.draftVersion,
      sceneHash: result.sceneHash,
      elementIndexHash: result.elementIndexHash,
      nextClientSequence: pendingSync.clientSequence + 1,
      pendingSync: null,
      blockedConflict: null,
      pendingPublish: null,
      publishedRevisionId: result.publishedRevisionId,
      needsInitialSync: false,
    };
    writeState(statePath, accepted, this.newId);
    return {
      status: "accepted",
      artifactId: accepted.artifactId,
      draftVersion: accepted.draftVersion,
      sceneHash: accepted.sceneHash,
      statePath,
    };
  }

  async publish(scenePathInput: string): Promise<WhiteboardWorkspacePublishResult> {
    const scenePath = normalizeScenePath(scenePathInput);
    const statePath = whiteboardSyncStatePath(scenePath);
    let state = readState(statePath);
    this.validateBinding(state, scenePath);

    if (state.blockedConflict !== null) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-conflicted",
        `conflict ${state.blockedConflict.conflictId} must be resolved before publication`,
        { conflictId: state.blockedConflict.conflictId },
      );
    }
    if (state.pendingSync !== null) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-pending-sync",
        "a sync request has an unknown outcome; retry sync before publication",
      );
    }
    if (state.needsInitialSync) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-needs-sync",
        "a workspace checked out from a published revision must be synced once to initialize its new live draft",
      );
    }
    if (state.publishedRevisionId !== null) {
      return {
        status: "accepted",
        artifactId: state.artifactId,
        revisionId: state.publishedRevisionId,
        draftVersion: state.draftVersion,
        sceneHash: state.sceneHash,
        unchanged: true,
        statePath,
      };
    }

    const canonical = canonicalizeWhiteboardScene(readFileSync(scenePath));
    validateTargets(state.targetElements, sceneElementIdentities(canonical.scene));
    if (canonical.hash !== state.sceneHash) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-unsynced",
        "working scene has changes that are not in the observed draft; sync before publication",
        { observedSceneHash: state.sceneHash, workingSceneHash: canonical.hash },
      );
    }

    const pendingPublish =
      state.pendingPublish ??
      ({
        commandId: this.newId("cmd"),
        idempotencyKey: this.newId("whiteboard_publish"),
        revisionId: this.newId("rev"),
        draftVersion: state.draftVersion,
        sceneHash: state.sceneHash,
      } satisfies PendingPublish);
    if (state.pendingPublish === null) {
      state = { ...state, pendingPublish };
      writeState(statePath, state, this.newId);
    }
    if (
      pendingPublish.draftVersion !== state.draftVersion ||
      pendingPublish.sceneHash !== state.sceneHash
    ) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-invalid-state",
        "pending publication does not describe the currently observed draft",
      );
    }

    const result = await this.client.publishDraft(this.connection, {
      artifactId: state.artifactId,
      draftId: state.draftId,
      expectedDraftVersion: state.draftVersion,
      expectedHeadRevisionId: state.baseRevisionId,
      revisionId: pendingPublish.revisionId,
      agentId: state.agentId,
      commandId: pendingPublish.commandId,
      idempotencyKey: pendingPublish.idempotencyKey,
    });
    if (result.status === "rejected") {
      writeState(statePath, { ...state, pendingPublish: null }, this.newId);
      throw new WhiteboardWorkspaceError(
        result.code,
        result.message,
        result.details && typeof result.details === "object"
          ? (result.details as Readonly<Record<string, unknown>>)
          : {},
      );
    }

    const response = requirePublishResponse(result.response, state);
    const published: WorkspaceState = {
      ...state,
      pendingPublish: null,
      publishedRevisionId: response.revisionId,
    };
    writeState(statePath, published, this.newId);
    return {
      status: "accepted",
      artifactId: state.artifactId,
      revisionId: response.revisionId,
      draftVersion: state.draftVersion,
      sceneHash: state.sceneHash,
      unchanged: response.unchanged,
      statePath,
    };
  }

  private validateBinding(state: WorkspaceState, scenePath: string): void {
    if (
      state.workspaceId !== this.connection.descriptor.workspaceId ||
      state.scenePath !== scenePath
    ) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-binding-mismatch",
        "sync-state belongs to another daemon workspace or working file",
        {
          expectedWorkspaceId: this.connection.descriptor.workspaceId,
          actualWorkspaceId: state.workspaceId,
          expectedScenePath: scenePath,
          actualScenePath: state.scenePath,
        },
      );
    }
  }
}

export function whiteboardSyncStatePath(scenePath: string): string {
  const absolute = resolve(scenePath);
  return join(dirname(absolute), `.${basename(absolute)}.tweakloop-sync.json`);
}

function normalizeScenePath(value: string): string {
  const absolute = resolve(requireText(value, "scenePath"));
  if (extname(absolute).toLowerCase() !== ".excalidraw") {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-path-invalid",
      "managed whiteboard workspaces require a .excalidraw working file",
      { scenePath: absolute },
    );
  }
  return absolute;
}

function selectTargets(
  elements: readonly SceneElementIdentity[],
  requestedIds: readonly string[],
): TargetElement[] {
  const uniqueIds = new Set(requestedIds.map((id) => requireText(id, "targetElementId")));
  const liveById = new Map(
    elements
      .filter((element) => !element.isDeleted)
      .map((element) => [element.elementId, element] as const),
  );
  return [...uniqueIds].map((elementId) => {
    const element = liveById.get(elementId);
    if (!element) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-target-unknown",
        `target element ${elementId} is not live in the checked-out scene`,
        { elementId },
      );
    }
    return {
      elementId,
      elementType: element.elementType,
      anchorId: element.anchorId,
    };
  });
}

function validateTargets(
  targets: readonly TargetElement[],
  elements: readonly SceneElementIdentity[],
): void {
  const liveById = new Map(
    elements
      .filter((element) => !element.isDeleted)
      .map((element) => [element.elementId, element] as const),
  );
  for (const target of targets) {
    const current = liveById.get(target.elementId);
    if (!current) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-target-missing",
        `target element ${target.elementId} was deleted or replaced`,
        { elementId: target.elementId, expectedType: target.elementType },
      );
    }
    if (current.elementType !== target.elementType) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-target-replaced",
        `target element ${target.elementId} changed type from ${target.elementType} to ${current.elementType}`,
        {
          elementId: target.elementId,
          expectedType: target.elementType,
          actualType: current.elementType,
        },
      );
    }
    if (target.anchorId !== null && current.anchorId !== target.anchorId) {
      throw new WhiteboardWorkspaceError(
        "whiteboard.workspace-target-anchor-replaced",
        `target element ${target.elementId} changed collaboration anchor from ${target.anchorId} to ${current.anchorId ?? "missing"}`,
        {
          elementId: target.elementId,
          expectedAnchorId: target.anchorId,
          actualAnchorId: current.anchorId,
        },
      );
    }
  }
}

function sceneElementIdentities(scene: Readonly<Record<string, unknown>>): SceneElementIdentity[] {
  const elements = scene.elements;
  if (!Array.isArray(elements)) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-scene-invalid",
      "canonical scene has no elements array",
    );
  }
  return elements.map((value) => {
    const element = requireObject(value, "scene element");
    return {
      elementId: requireText(element.id, "scene element id"),
      elementType: requireText(element.type, "scene element type"),
      isDeleted: element.isDeleted === true,
      anchorId: collaborationAnchorId(element),
    };
  });
}

function collaborationAnchorId(element: Readonly<Record<string, unknown>>): string | null {
  if (element.customData === undefined || element.customData === null) return null;
  const customData = requireObject(element.customData, "element customData");
  if (customData.tweakloop === undefined || customData.tweakloop === null) return null;
  const tweakloop = requireObject(customData.tweakloop, "element customData.tweakloop");
  if (tweakloop.anchorId === undefined || tweakloop.anchorId === null) return null;
  return requireText(tweakloop.anchorId, "element customData.tweakloop.anchorId");
}

function assertAcceptedDraft(
  result: WhiteboardDraftMetadata,
  state: WorkspaceState,
  sceneHash: string,
  elementIndexHash: string,
): void {
  if (
    result.artifactId !== state.artifactId ||
    result.draftId !== state.draftId ||
    result.baseRevisionId !== state.baseRevisionId ||
    result.sceneHash !== sceneHash ||
    result.elementIndexHash !== elementIndexHash
  ) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-response-mismatch",
      "accepted draft response does not match the submitted workspace state",
    );
  }
}

function retainedConflict(
  conflict: WhiteboardDraftConflict,
  statePath: string,
): WhiteboardWorkspaceSyncResult {
  return {
    status: "conflict",
    conflict,
    retained: true,
    statePath,
    recovery: "checkout-fresh-or-use-explicit-conflict-resolution",
  };
}

function requirePublishResponse(
  value: unknown,
  state: WorkspaceState,
): Readonly<{ revisionId: string; unchanged: boolean }> {
  const response = requireObject(value, "accepted publication response must be an object");
  const revisionId = requireText(response.revisionId, "publication revisionId");
  if (
    response.artifactId !== state.artifactId ||
    response.draftId !== state.draftId ||
    response.draftVersion !== state.draftVersion ||
    response.sceneHash !== state.sceneHash ||
    (response.unchanged !== true && response.unchanged !== false)
  ) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-response-mismatch",
      "publication response does not match the observed draft",
    );
  }
  return { revisionId, unchanged: response.unchanged };
}

function createWorkspacePair(
  scenePath: string,
  sceneBytes: Buffer,
  statePath: string,
  stateBytes: Buffer,
  newId: (prefix: string) => string,
): void {
  mkdirSync(dirname(scenePath), { recursive: true });
  const sceneTmp = join(dirname(scenePath), `.${basename(scenePath)}.${newId("tmp")}`);
  const stateTmp = join(dirname(statePath), `.${basename(statePath)}.${newId("tmp")}`);
  let sceneCreated = false;
  try {
    writeFileSync(sceneTmp, sceneBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(stateTmp, stateBytes, { flag: "wx", mode: 0o600 });
    linkSync(sceneTmp, scenePath);
    sceneCreated = true;
    linkSync(stateTmp, statePath);
  } catch (error) {
    if (sceneCreated) unlinkIfPresent(scenePath);
    throw error;
  } finally {
    unlinkIfPresent(sceneTmp);
    unlinkIfPresent(stateTmp);
  }
}

function writeState(
  statePath: string,
  state: WorkspaceState,
  newId: (prefix: string) => string,
): void {
  const tmp = join(dirname(statePath), `.${basename(statePath)}.${newId("tmp")}`);
  try {
    writeFileSync(tmp, encodeState(state), { flag: "wx", mode: 0o600 });
    renameSync(tmp, statePath);
  } finally {
    unlinkIfPresent(tmp);
  }
}

function encodeState(state: WorkspaceState): Buffer {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
}

function readState(statePath: string): WorkspaceState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-unreadable",
      "sync-state sidecar is missing, unreadable, or invalid JSON",
      { statePath, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  try {
    return validateState(parsed);
  } catch (error) {
    if (error instanceof WhiteboardWorkspaceError) throw error;
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-invalid",
      "sync-state sidecar has an invalid shape",
      { statePath },
    );
  }
}

function validateState(value: unknown): WorkspaceState {
  const state = requireObject(value, "sync-state must be an object");
  if (state.protocol !== WORKSPACE_PROTOCOL) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-version",
      "sync-state uses an unsupported protocol version",
    );
  }
  const targets = requireArray(state.targetElements, "targetElements").map((value) => {
    const target = requireObject(value, "target element must be an object");
    return {
      elementId: requireText(target.elementId, "target elementId"),
      elementType: requireText(target.elementType, "target elementType"),
      anchorId: target.anchorId === null ? null : requireText(target.anchorId, "target anchorId"),
    };
  });
  return {
    protocol: WORKSPACE_PROTOCOL,
    workspaceId: requireText(state.workspaceId, "workspaceId"),
    scenePath: requireText(state.scenePath, "scenePath"),
    artifactId: requireText(state.artifactId, "artifactId"),
    draftId: requireText(state.draftId, "draftId"),
    baseRevisionId: requireText(state.baseRevisionId, "baseRevisionId"),
    draftVersion: requireNonNegativeInteger(state.draftVersion, "draftVersion"),
    sceneHash: requireHash(state.sceneHash, "sceneHash"),
    elementIndexHash: requireHash(state.elementIndexHash, "elementIndexHash"),
    clientId: requireText(state.clientId, "clientId"),
    nextClientSequence: requirePositiveInteger(state.nextClientSequence, "nextClientSequence"),
    agentId: requireText(state.agentId, "agentId"),
    needsInitialSync: requireBoolean(state.needsInitialSync, "needsInitialSync"),
    targetElements: targets,
    pendingSync: parsePendingSync(state.pendingSync),
    blockedConflict: parseConflict(state.blockedConflict),
    pendingPublish: parsePendingPublish(state.pendingPublish),
    publishedRevisionId:
      state.publishedRevisionId === null
        ? null
        : requireText(state.publishedRevisionId, "publishedRevisionId"),
  };
}

function parsePendingSync(value: unknown): PendingSync | null {
  if (value === null) return null;
  const pending = requireObject(value, "pendingSync");
  return {
    clientSequence: requirePositiveInteger(pending.clientSequence, "pending clientSequence"),
    sceneHash: requireHash(pending.sceneHash, "pending sceneHash"),
  };
}

function parsePendingPublish(value: unknown): PendingPublish | null {
  if (value === null) return null;
  const pending = requireObject(value, "pendingPublish");
  return {
    commandId: requireText(pending.commandId, "pending commandId"),
    idempotencyKey: requireText(pending.idempotencyKey, "pending idempotencyKey"),
    revisionId: requireText(pending.revisionId, "pending revisionId"),
    draftVersion: requireNonNegativeInteger(pending.draftVersion, "pending draftVersion"),
    sceneHash: requireHash(pending.sceneHash, "pending sceneHash"),
  };
}

function parseConflict(value: unknown): WhiteboardDraftConflict | null {
  if (value === null) return null;
  const conflict = requireObject(value, "blockedConflict");
  if (
    conflict.protocol !== "tweakloop.whiteboard-draft/v1" ||
    conflict.status !== "conflict" ||
    conflict.code !== "whiteboard.draft-conflict"
  ) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-invalid",
      "blockedConflict is not a whiteboard draft conflict",
    );
  }
  return {
    protocol: "tweakloop.whiteboard-draft/v1",
    status: "conflict",
    code: "whiteboard.draft-conflict",
    conflictId: requireText(conflict.conflictId, "conflictId"),
    artifactId: requireText(conflict.artifactId, "conflict artifactId"),
    draftId: requireText(conflict.draftId, "conflict draftId"),
    baseRevisionId: requireText(conflict.baseRevisionId, "conflict baseRevisionId"),
    expectedDraftVersion: requireNonNegativeInteger(
      conflict.expectedDraftVersion,
      "expectedDraftVersion",
    ),
    currentDraftVersion: requireNonNegativeInteger(
      conflict.currentDraftVersion,
      "currentDraftVersion",
    ),
    submittedSceneHash: requireHash(conflict.submittedSceneHash, "submittedSceneHash"),
    currentSceneHash: requireHash(conflict.currentSceneHash, "currentSceneHash"),
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-invalid",
      `${field} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-invalid",
      `${field} must be an array`,
    );
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-invalid",
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  const hash = requireText(value, field);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-invalid",
      `${field} must be a lowercase sha256 hash`,
    );
  }
  return hash;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-invalid",
      `${field} must be a non-negative integer`,
    );
  }
  return Number(value);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (value !== true && value !== false) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-invalid",
      `${field} must be a boolean`,
    );
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const integer = requireNonNegativeInteger(value, field);
  if (integer < 1) {
    throw new WhiteboardWorkspaceError(
      "whiteboard.workspace-state-invalid",
      `${field} must be a positive integer`,
    );
  }
  return integer;
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
