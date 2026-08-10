/**
 * Tweakloop review shell (Phase 1-2). Every render derives from the
 * projection snapshot; committed events over SSE only trigger a
 * snapshot refresh — the DOM is never the source of truth.
 */

const BRIDGE_PROTOCOL = "tweakloop.bridge/v1";
const COMMAND_PROTOCOL = "tweakloop.command/v1";
const COLLABORATION_TAB_STORAGE = "tweakloop-collaboration-tab";
const WHITEBOARD_BROWSER_OPERATION_PROTOCOL = "tweakloop.whiteboard-browser-operation/v1";
const WHITEBOARD_CONTEXT_HISTORY_KEY = "tweakloopWhiteboardContextId";
const WHITEBOARD_CLIENT_ID_STORAGE = "tweakloop-whiteboard-client-id";
const WHITEBOARD_SEQUENCE_STORAGE_PREFIX = "tweakloop-whiteboard-next-sequence";
const WHITEBOARD_PENDING_STORAGE_PREFIX = "tweakloop-whiteboard-pending-operation";

function storedCollaborationTab() {
  const stored = localStorage.getItem(COLLABORATION_TAB_STORAGE);
  return ["work", "feedback", "chat"].includes(stored) ? stored : "chat";
}

function storedWhiteboardContextId() {
  const existing = history.state?.[WHITEBOARD_CONTEXT_HISTORY_KEY];
  if (typeof existing === "string" && existing.startsWith("tab_") && existing.length <= 256) {
    return existing;
  }
  const created = `tab_${crypto.randomUUID()}`;
  const previous = history.state && typeof history.state === "object" ? history.state : {};
  history.replaceState({ ...previous, [WHITEBOARD_CONTEXT_HISTORY_KEY]: created }, "");
  return created;
}

function storedWhiteboardClientId(contextId) {
  try {
    const raw = sessionStorage.getItem(WHITEBOARD_CLIENT_ID_STORAGE);
    const stored = raw ? JSON.parse(raw) : null;
    if (
      stored?.protocol === "tweakloop.whiteboard-browser-client/v1" &&
      stored.contextId === contextId &&
      typeof stored.clientId === "string" &&
      stored.clientId.startsWith("browser_") &&
      stored.clientId.length <= 256
    ) {
      return stored.clientId;
    }
    const created = `browser_${crypto.randomUUID()}`;
    sessionStorage.setItem(
      WHITEBOARD_CLIENT_ID_STORAGE,
      JSON.stringify({
        protocol: "tweakloop.whiteboard-browser-client/v1",
        contextId,
        clientId: created,
      }),
    );
    return created;
  } catch {
    // Draft writes fail closed before transport if retry custody is unavailable.
    return `browser_${crypto.randomUUID()}`;
  }
}

function whiteboardStorageKey(prefix, artifactId) {
  return `${prefix}:${artifactId}`;
}

function whiteboardOperationBelongsToOpener(operation) {
  try {
    return (
      window.opener !== null &&
      !window.opener.closed &&
      window.opener.history.state?.[WHITEBOARD_CONTEXT_HISTORY_KEY] === operation.contextId
    );
  } catch {
    // Cross-origin or detached openers cannot establish custody ownership.
    return false;
  }
}

function loadWhiteboardPendingOperation(artifactId) {
  try {
    const raw = sessionStorage.getItem(
      whiteboardStorageKey(WHITEBOARD_PENDING_STORAGE_PREFIX, artifactId),
    );
    if (raw === null) return { operation: null, error: null };
    const operation = JSON.parse(raw);
    if (
      operation?.protocol !== WHITEBOARD_BROWSER_OPERATION_PROTOCOL ||
      operation.artifactId !== artifactId ||
      typeof operation.contextId !== "string" ||
      !operation.contextId.startsWith("tab_") ||
      operation.contextId.length > 256 ||
      typeof operation.clientId !== "string" ||
      !Number.isSafeInteger(operation.clientSequence) ||
      operation.clientSequence < 1 ||
      typeof operation.draftId !== "string" ||
      typeof operation.baseRevisionId !== "string" ||
      !Number.isSafeInteger(operation.expectedVersion) ||
      operation.expectedVersion < 0 ||
      (operation.conflictId !== null && typeof operation.conflictId !== "string") ||
      typeof operation.body !== "string"
    ) {
      throw new Error("stored operation has an invalid shape");
    }
    const scene = JSON.parse(operation.body);
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      throw new Error("stored operation does not contain a whiteboard scene");
    }
    if (operation.contextId !== state.whiteboardContextId) {
      if (whiteboardOperationBelongsToOpener(operation)) {
        // window.open clones sessionStorage. This is the opener's custody copied into a distinct
        // storage area, so the child must neither replay it nor let it block child-owned custody.
        return { operation: null, error: null };
      }
      throw new Error("stored operation belongs to another browser context");
    }
    return { operation, error: null };
  } catch {
    return {
      operation: null,
      error:
        "A queued whiteboard edit could not be recovered from this tab. Saving is paused to avoid duplicating or replacing it.",
    };
  }
}

function retainWhiteboardOperation(record, scene, expectedVersion, conflictId = null) {
  const existing = loadWhiteboardPendingOperation(record.artifactId);
  if (existing.error) throw new Error(existing.error);
  if (existing.operation) {
    throw new Error("another whiteboard edit still has an unknown outcome");
  }
  const sequenceKey = whiteboardStorageKey(WHITEBOARD_SEQUENCE_STORAGE_PREFIX, record.artifactId);
  const storedNext = Number(sessionStorage.getItem(sequenceKey));
  const clientSequence = Number.isSafeInteger(storedNext) && storedNext >= 1 ? storedNext : 1;
  // Burn the sequence before retaining the request. A crash between these writes skips a
  // sequence; it can never reuse one that might have reached the daemon.
  sessionStorage.setItem(sequenceKey, String(clientSequence + 1));
  const operation = {
    protocol: WHITEBOARD_BROWSER_OPERATION_PROTOCOL,
    artifactId: record.artifactId,
    contextId: state.whiteboardContextId,
    clientId: state.whiteboardClientId,
    clientSequence,
    draftId: record.draftId,
    baseRevisionId: record.baseRevisionId,
    expectedVersion,
    conflictId,
    body: JSON.stringify(scene),
  };
  sessionStorage.setItem(
    whiteboardStorageKey(WHITEBOARD_PENDING_STORAGE_PREFIX, record.artifactId),
    JSON.stringify(operation),
  );
  return operation;
}

function releaseWhiteboardOperation(operation) {
  try {
    const key = whiteboardStorageKey(WHITEBOARD_PENDING_STORAGE_PREFIX, operation.artifactId);
    const current = loadWhiteboardPendingOperation(operation.artifactId).operation;
    if (
      current?.clientId === operation.clientId &&
      current.clientSequence === operation.clientSequence
    ) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // An accepted operation is safe to replay. If cleanup is unavailable, the exact receipt is
    // recovered on refresh rather than manufacturing a second mutation.
  }
}

const $ = (id) => document.getElementById(id);

const els = {
  connection: $("connection"),
  workspace: $("workspace"),
  workspaceShell: $("workspace-shell"),
  workspaceExport: $("workspace-export"),
  workspaceExportStatus: $("workspace-export-status"),
  themeToggle: $("theme-toggle"),
  artifactToolbar: $("artifact-toolbar"),
  artifactSelect: $("artifact-select"),
  artifactList: $("artifact-list"),
  documentsEmpty: $("documents-empty"),
  documentAdd: $("document-add"),
  documentOpenFiles: $("document-open-files"),
  documentNewWhiteboard: $("document-new-whiteboard"),
  activeOutline: $("active-outline"),
  modeInteract: $("mode-interact"),
  outlineRail: $("outline-rail"),
  outlineList: $("outline-list"),
  outlineEmpty: $("outline-empty"),
  outlineCollapse: $("outline-collapse"),
  revisionSelect: $("revision-select"),
  restoreRevision: $("restore-revision"),
  modeToggle: $("mode-toggle"),
  publishWhiteboard: $("publish-whiteboard"),
  viewerExpand: $("viewer-expand"),
  viewerFullscreen: $("viewer-fullscreen"),
  viewerFlash: $("viewer-flash"),
  viewerBody: $("viewer-body"),
  viewerTransition: $("viewer-transition"),
  viewerFrame: $("viewer-frame"),
  viewerEmpty: $("viewer-empty"),
  startSurface: $("start-surface"),
  startAgentAssurance: $("start-agent-assurance"),
  startOpenFiles: $("start-open-files"),
  startOpenWorkspace: $("start-open-workspace"),
  startNewWhiteboard: $("start-new-whiteboard"),
  artifactFileInput: $("artifact-file-input"),
  workspaceDirectoryInput: $("workspace-directory-input"),
  onboardingLive: $("onboarding-live"),
  onboardingProgress: $("onboarding-progress"),
  onboardingProgressTitle: $("onboarding-progress-title"),
  onboardingResults: $("onboarding-results"),
  onboardingRecovery: $("onboarding-recovery"),
  onboardingDismiss: $("onboarding-dismiss"),
  nodesNote: $("nodes-note"),
  tabs: [...document.querySelectorAll(".tabs [data-tab]")],
  panels: [...document.querySelectorAll("[data-panel]")],
  collaborationStack: $("collaboration-stack"),
  draftForm: $("draft-form"),
  draftTarget: $("draft-target"),
  draftIntentType: $("draft-intent-type"),
  draftTextCaption: $("draft-text-caption"),
  draftText: $("draft-text"),
  draftRationaleField: $("draft-rationale-field"),
  draftRationale: $("draft-rationale"),
  draftAdd: $("draft-add"),
  draftSend: $("draft-send"),
  draftCancel: $("draft-cancel"),
  draftsContext: $("drafts-context"),
  draftList: $("draft-list"),
  draftsEmpty: $("drafts-empty"),
  localReviewQueue: $("local-review-queue"),
  submitReview: $("submit-review"),
  flash: $("flash"),
  intentList: $("intent-list"),
  resolvedIntentList: $("resolved-intent-list"),
  resolvedCommentsCount: $("resolved-comments-count"),
  resolvedCommentsEmpty: $("resolved-comments-empty"),
  feedbackEmpty: $("feedback-empty"),
  tasksSummary: $("tasks-summary"),
  workList: $("work-list"),
  workEmpty: $("work-empty"),
  chatList: $("chat-list"),
  chatEmpty: $("chat-empty"),
  chatPresence: $("chat-presence"),
  chatContext: $("chat-context"),
  chatMentions: $("chat-mentions"),
  chatAttachments: $("chat-attachments"),
  chatMentionList: $("chat-mention-list"),
  chatAttach: $("chat-attach"),
  chatFileInput: $("chat-file-input"),
  chatInput: $("chat-input"),
  chatSend: $("chat-send"),
  chatSendRequirement: $("chat-send-requirement"),
  chatComposerHint: $("chat-composer-hint"),
  chatFlash: $("chat-flash"),
  chatExpand: $("chat-expand"),
  decisionDialog: $("decision-dialog"),
  decisionDialogTitle: $("decision-dialog-title"),
  decisionDialogContext: $("decision-dialog-context"),
  decisionReason: $("decision-reason"),
  decisionCancel: $("decision-cancel"),
  decisionRetry: $("decision-retry"),
  decisionSubmit: $("decision-submit"),
  timeline: $("timeline"),
  timelineEmpty: $("timeline-empty"),
  agentName: $("agent-name"),
  agentHeaderMark: $("agent-header-mark"),
  agentSheetMark: $("agent-sheet-mark"),
  agentStatus: $("agent-status"),
  notificationsToggle: $("notifications-toggle"),
  notificationsStatus: $("notifications-status"),
  taskbarCurrent: $("taskbar-current"),
  taskbarDrafts: $("taskbar-drafts"),
  taskbarOpen: $("taskbar-open"),
  taskbarAddressed: $("taskbar-addressed"),
  sheetToggle: $("agent-sheet-toggle"),
  sheetSummary: $("agent-sheet-summary"),
  agentRail: $("agent-rail"),
  agentRailContent: $("agent-rail-content"),
  agentCollapse: $("agent-collapse"),
  draftsCount: $("drafts-count"),
  commentsCount: $("comments-count"),
  tasksCount: $("tasks-count"),
  chatCount: $("chat-count"),
};

const state = {
  snapshot: null,
  selectedArtifactId: null,
  /** null → auto-follow the head revision. */
  pinnedRevisionId: null,
  mode: "interact",
  /** {intentId, intentType, target, body, artifactId, revisionId} */
  drafts: [],
  /** {target, artifactId, revisionId} awaiting the draft form. */
  pendingTarget: null,
  /** {revisionId, semanticId?, domHint?, textQuote?} for the next chat message. */
  chatContext: null,
  /** Typed stable references attached to the next chat message. */
  chatReferences: [],
  /** Local upload records; only ready descriptors may enter chat.send. */
  pendingAttachments: [],
  chatSending: false,
  /** Durable chat ids currently being explicitly promoted into typed work. */
  promotingMessageIds: new Set(),
  /** Intent id -> exact retryable work-creation envelope values for the current UI operation. */
  trackingIntentOperations: new Map(),
  /** Exact question id -> one idempotent human answer attempt owned by this shell. */
  questionAnswerAttempts: new Map(),
  /** {session, options, index} while the @-mention popover is open. */
  mention: null,
  /** [{agentId, state}] from the presence poll. */
  presence: [],
  presenceKey: "",
  presenceFailures: 0,
  presenceReconnecting: false,
  /** {work, invoker} while the explicit another-pass dialog is open. */
  decisionRequest: null,
  /** Artifact-exact context minted by `tweak open <path> --agent <id>`. */
  sessionContext: { artifactId: null, agentId: null, sessionId: null },
  activeTab: storedCollaborationTab(),
  chatExpanded: false,
  notificationsEnabled:
    localStorage.getItem("tweakloop-ready-notifications") === "enabled" &&
    "Notification" in window &&
    Notification.permission === "granted",
  railOpen: false,
  outlineCollapsed: false,
  agentCollapsed: false,
  canvasWide: false,
  /** Last bridge-confirmed artifact/revision pair. */
  committedView: null,
  /** {artifactId, revisionId, src, status, previous, timer}. */
  viewerNavigation: null,
  /** {artifactId, revisionId, target} awaiting the exact immutable revision. */
  pendingReveal: null,
  /** Shell element that invoked the floating comment composer. */
  pendingTargetInvoker: null,
  bridgePort: null,
  outlineLoading: false,
  nodes: [],
  whiteboardLoads: new Set(),
  currentWhiteboards: [],
  whiteboardDrafts: new Map(),
  whiteboardInitializations: new Map(),
  whiteboardPendingApplies: new Map(),
  whiteboardStreams: new Map(),
  whiteboardContextId: storedWhiteboardContextId(),
  whiteboardClientId: null,
  lastSeq: 0,
  onboarding: {
    busy: false,
    title: "",
    results: [],
    recovery: null,
    retry: null,
    invoker: null,
  },
  focusViewerOnReady: false,
};
state.whiteboardClientId = storedWhiteboardClientId(state.whiteboardContextId);

const flashTimers = new Map();
let refreshTimer = null;
let agentActivityTimer = null;
const renderedEntities = {
  drafts: new Map(),
  intents: new Map(),
  work: new Map(),
  chat: new Map(),
};
let hasRenderedSnapshot = false;

// ---- derived selectors ------------------------------------------------------

function artifacts() {
  return state.snapshot?.artifacts ?? [];
}

function artifactKind(artifact) {
  const format = String(artifact?.format ?? "").toLowerCase();
  const sourcePath = String(artifact?.sourcePath ?? artifact?.name ?? "").toLowerCase();
  if (format === "whiteboard" || sourcePath.endsWith(".excalidraw")) return "whiteboard";
  if (format === "markdown" || format === "md" || /\.(md|markdown|mdown)$/.test(sourcePath)) {
    return "markdown";
  }
  if (format === "html" || /\.html?$/.test(sourcePath)) return "html";
  return "document";
}

function artifactKindLabel(kind) {
  if (kind === "markdown") return "Markdown";
  if (kind === "html") return "HTML";
  if (kind === "whiteboard") return "Whiteboard";
  return "Document";
}

function svgIcon(kind, className) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add(className);

  const definitions = {
    markdown: [
      ["path", { d: "M6.5 2.75h7l4 4V21.25h-11z" }],
      ["path", { d: "M13.5 2.75v4h4" }],
      ["path", { d: "M8.75 15v-4l1.75 2 1.75-2v4" }],
      ["path", { d: "M14.25 11v4m-1.35-1.35 1.35 1.35 1.35-1.35" }],
    ],
    html: [
      ["path", { d: "M6.5 2.75h7l4 4V21.25h-11z" }],
      ["path", { d: "M13.5 2.75v4h4" }],
      ["path", { d: "m10 11.25-2 1.75 2 1.75m4-3.5 2 1.75-2 1.75m-.75-4.25-2.5 5" }],
    ],
    whiteboard: [
      ["rect", { x: "3.25", y: "4.25", width: "17.5", height: "15.5", rx: "2.5" }],
      ["circle", { cx: "8", cy: "9", r: "1.25" }],
      ["circle", { cx: "16", cy: "15", r: "1.25" }],
      ["path", { d: "m9.2 9.5 5.6 5M6.5 16l3-3 2 1.75" }],
    ],
    document: [
      ["path", { d: "M6.5 2.75h7l4 4V21.25h-11z" }],
      ["path", { d: "M13.5 2.75v4h4M9 11h6M9 14h6M9 17h4" }],
    ],
    human: [
      ["circle", { cx: "12", cy: "8", r: "3.25" }],
      ["path", { d: "M5.75 20c.65-4.05 2.75-6.1 6.25-6.1s5.6 2.05 6.25 6.1" }],
    ],
    agent: [
      ["path", { d: "m12 3 .85 3.15L16 7l-3.15.85L12 11l-.85-3.15L8 7l3.15-.85z" }],
      ["path", { d: "m7 12 .6 2.4L10 15l-2.4.6L7 18l-.6-2.4L4 15l2.4-.6z" }],
      ["path", { d: "m16.5 13 .65 2.35 2.35.65-2.35.65L16.5 19l-.65-2.35L13.5 16l2.35-.65z" }],
    ],
  };

  for (const [tag, attrs] of definitions[kind] ?? definitions.document) {
    const child = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, value);
    svg.append(child);
  }
  return svg;
}

function entityMotion(kind, id, signature) {
  const entities = renderedEntities[kind];
  const previous = entities.get(id);
  entities.set(id, signature);
  if (!hasRenderedSnapshot) return "";
  if (previous === undefined) return " is-entering";
  if (previous !== signature) return " is-updating";
  return "";
}

function setLiveText(element, text) {
  if (element.textContent === text) return;
  element.textContent = text;
  if (!hasRenderedSnapshot) return;
  element.classList.remove("state-pulse");
  void element.offsetWidth;
  element.classList.add("state-pulse");
  element.addEventListener("animationend", () => element.classList.remove("state-pulse"), {
    once: true,
  });
}

function selectedArtifact() {
  const list = artifacts();
  return list.find((a) => a.artifactId === state.selectedArtifactId) ?? list[0] ?? null;
}

function revisionsOf(artifactId) {
  return (state.snapshot?.revisions ?? [])
    .filter((r) => r.artifactId === artifactId)
    .sort((a, b) => a.seq - b.seq);
}

function viewedRevision() {
  const artifact = selectedArtifact();
  if (!artifact) return null;
  const revs = revisionsOf(artifact.artifactId);
  if (revs.length === 0) return null;
  return revs.find((r) => r.revisionId === state.pinnedRevisionId) ?? revs[revs.length - 1];
}

function revisionSeq(revisionId) {
  return (state.snapshot?.revisions ?? []).find((r) => r.revisionId === revisionId)?.seq ?? null;
}

function chatMessages() {
  const visibleArtifactIds = activeArtifactIds();
  return (state.snapshot?.chat ?? [])
    .filter((m) => m.artifactId === null || visibleArtifactIds.has(m.artifactId))
    .sort((a, b) => a.createdSeq - b.createdSeq);
}

function isHumanAuthor(author) {
  return author.startsWith("human") || author === "browser" || author === "alex";
}

const AGENT_PROFILES = [
  {
    token: "claude-code",
    label: "Claude Code",
    mark: "CC",
    aliases: new Set(["claude", "claude-code", "anthropic-claude", "anthropic-claude-code"]),
  },
  {
    token: "codex",
    label: "Codex",
    mark: "CD",
    aliases: new Set(["codex", "codex-cli", "openai-codex"]),
  },
  {
    token: "grok",
    label: "Grok",
    mark: "GK",
    aliases: new Set(["grok", "x-grok", "xai-grok"]),
  },
  {
    token: "cursor",
    label: "Cursor",
    mark: "CU",
    aliases: new Set(["cursor", "cursor-agent"]),
  },
];

function rawAgentLabel(agentId) {
  const raw = String(agentId ?? "").trim();
  return raw.replace(/^(agent:)+/i, "").trim() || "Agent";
}

function normalizedAgentToken(agentId) {
  return rawAgentLabel(agentId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deterministicAgentHue(label) {
  let hash = 2166136261;
  for (const character of label) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 360;
}

function fallbackAgentMark(label) {
  const parts = label.match(/[\p{L}\p{N}]+/gu) ?? [];
  const mark = parts
    .slice(0, 2)
    .map((part) => [...part][0])
    .join("")
    .toUpperCase();
  return mark || "AI";
}

function resolveAgentProfile(agentId) {
  const label = rawAgentLabel(agentId);
  const normalized = normalizedAgentToken(agentId);
  const known = AGENT_PROFILES.find((profile) => profile.aliases.has(normalized));
  if (known) return { ...known, rawLabel: label, hue: null };
  return {
    token: "custom",
    label,
    rawLabel: label,
    mark: fallbackAgentMark(label),
    hue: deterministicAgentHue(normalized || label),
  };
}

function applyAgentMark(element, profile) {
  element.textContent = profile.mark;
  element.dataset.agentProfile = profile.token;
  if (profile.hue === null) element.style.removeProperty("--agent-mark-hue");
  else element.style.setProperty("--agent-mark-hue", String(profile.hue));
}

function artifactName(artifactId) {
  return artifacts().find((a) => a.artifactId === artifactId)?.name ?? artifactId;
}

function activeArtifactIds() {
  const ids = new Set();
  const selected = selectedArtifact();
  if (selected) ids.add(selected.artifactId);
  for (const node of state.nodes) {
    const embeddedArtifactId = node?.boardAnchor?.whiteboardArtifactId;
    if (embeddedArtifactId) ids.add(embeddedArtifactId);
  }
  return ids;
}

function livePresenceForAgent(agentId) {
  if (!agentId || state.presenceReconnecting) return null;
  const token = normalizedAgentToken(agentId);
  const presence = state.presence.find((item) => normalizedAgentToken(item.agentId) === token);
  if (!presence || presence.state === "expired") return null;
  const expiresAt = Date.parse(presence.expiresAt ?? "");
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null;
  return presence;
}

function assignedAgentPresence() {
  return livePresenceForAgent(state.sessionContext.agentId);
}

function recentAcknowledgementForAgent(agentId) {
  const sessionId = state.sessionContext.sessionId;
  if (!agentId || !sessionId) return null;
  const token = normalizedAgentToken(agentId);
  return (state.snapshot?.chat ?? [])
    .filter(
      (message) =>
        isHumanAuthor(message.author) &&
        message.sessionId === sessionId &&
        message.delivery?.status === "acknowledged" &&
        normalizedAgentToken(message.delivery.agentId) === token &&
        progressAgeState(message.delivery.acknowledgedAt) === "recent",
    )
    .sort(
      (left, right) =>
        Date.parse(left.delivery.acknowledgedAt) - Date.parse(right.delivery.acknowledgedAt),
    )
    .at(-1);
}

function isLegalWorkState(work) {
  if (work.status === "open" || work.status === "claimed") {
    return work.decision === "pending" || work.decision === "reopened";
  }
  return (
    work.status === "addressed" && (work.decision === "pending" || work.decision === "accepted")
  );
}

function currentSessionArtifacts() {
  const sessionId = state.sessionContext.sessionId;
  if (!sessionId) return [];
  return (state.snapshot?.sessionArtifacts ?? []).filter((item) => item.sessionId === sessionId);
}

function safeAgentName() {
  return state.sessionContext.agentId?.replace(/^agent:/, "") ?? null;
}

function announceOnboarding(message) {
  els.onboardingLive.textContent = "";
  requestAnimationFrame(() => {
    els.onboardingLive.textContent = message;
  });
}

function setOnboardingBusy(busy) {
  state.onboarding.busy = busy;
  els.viewerBody.setAttribute("aria-busy", String(busy));
  for (const button of [
    els.startOpenFiles,
    els.startOpenWorkspace,
    els.startNewWhiteboard,
    els.documentOpenFiles,
    els.documentNewWhiteboard,
  ]) {
    button.disabled = busy;
  }
  renderOnboardingProgress();
}

function setOnboardingRecovery(message, retry = null) {
  state.onboarding.recovery = message;
  state.onboarding.retry = retry;
  renderOnboardingProgress();
  announceOnboarding(message);
  requestAnimationFrame(() => els.onboardingRecovery.focus());
}

function clearOnboardingProgress() {
  state.onboarding.title = "";
  state.onboarding.results = [];
  state.onboarding.recovery = null;
  state.onboarding.retry = null;
  renderOnboardingProgress();
}

function renderOnboardingProgress() {
  const onboarding = state.onboarding;
  const visible = onboarding.busy || onboarding.results.length > 0 || onboarding.recovery !== null;
  els.onboardingProgress.hidden = !visible;
  if (!visible) return;
  els.onboardingProgressTitle.textContent = onboarding.title || "Working…";
  els.onboardingResults.replaceChildren(
    ...onboarding.results.map((result) =>
      el(
        "li",
        { class: "onboarding-result", "data-state": result.state },
        el(
          "span",
          { "aria-hidden": "true" },
          result.state === "error" ? "!" : result.state === "added" ? "✓" : "·",
        ),
        el("strong", {}, result.name),
        el("span", { class: "onboarding-result-status" }, result.status),
      ),
    ),
  );
  els.onboardingRecovery.hidden = onboarding.recovery === null;
  els.onboardingRecovery.tabIndex = -1;
  if (onboarding.recovery !== null) {
    const retry = onboarding.retry
      ? el("button", { type: "button", class: "small" }, "Retry")
      : null;
    retry?.addEventListener("click", () => onboarding.retry?.());
    els.onboardingRecovery.replaceChildren(el("span", {}, onboarding.recovery), retry);
  } else {
    els.onboardingRecovery.replaceChildren();
  }
  els.onboardingDismiss.hidden = onboarding.busy;
}

// ---- dom helpers ------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== ""));
  return node;
}

function chip(text) {
  return el("span", { class: "chip" }, text);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function targetLabel(target) {
  const elementLabel = target?.boardAnchor?.elementAnchor?.label;
  if (elementLabel) return `✎ ${truncate(elementLabel, 60)}`;
  const anchor = target?.semanticId ? `⌖ ${target.semanticId}` : null;
  const quote = target?.textQuote?.exact ? `“${truncate(target.textQuote.exact, 60)}”` : null;
  if (anchor && quote) return `${anchor} · ${quote}`;
  return anchor ?? quote ?? "⌖ (unanchored)";
}

function normalizeTarget(payload) {
  const target = {};
  if (payload.semanticId) target.semanticId = payload.semanticId;
  if (payload.domHint) target.domHint = payload.domHint;
  if (payload.textQuote?.exact) {
    target.textQuote = { exact: payload.textQuote.exact };
    if (payload.textQuote.prefix) target.textQuote.prefix = payload.textQuote.prefix;
    if (payload.textQuote.suffix) target.textQuote.suffix = payload.textQuote.suffix;
  }
  if (payload.boardAnchor?.semanticId && payload.boardAnchor?.elementAnchor?.elementId) {
    target.boardAnchor = structuredClone(payload.boardAnchor);
  }
  return target;
}

function bodyText(body) {
  const b = body ?? {};
  return b.text ?? b.value ?? b.statement ?? JSON.stringify(b);
}

const PROGRESS_RECENT_WINDOW_MS = 5 * 60 * 1000;

function relativeTime(iso) {
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta) || delta < 1000) return "now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 45) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Presentation-only age: event time is durable; presence never changes this classification. */
function progressAgeState(recordedAt) {
  const eventTime = Date.parse(recordedAt);
  const ageMs = Date.now() - eventTime;
  if (!Number.isFinite(eventTime) || ageMs < 0) return "unknown";
  return ageMs <= PROGRESS_RECENT_WINDOW_MS ? "recent" : "old";
}

/** Long text renders clamped to ~2 lines with an explicit disclosure control. */
function clampable(text, className, lines = 2) {
  const p = el("p", { class: className }, text);
  if (text.length <= 140) return p;
  const contentId = `clamp_${crypto.randomUUID()}`;
  p.id = contentId;
  p.classList.add("clamp");
  p.style.setProperty("--clamp-lines", String(lines));
  const toggle = el(
    "button",
    {
      type: "button",
      class: "clamp-toggle",
      "aria-expanded": "false",
      "aria-controls": contentId,
    },
    "Show more",
  );
  toggle.addEventListener("click", () => {
    const expanded = p.classList.toggle("expanded");
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? "Show less" : "Show more";
  });
  return el("div", { class: "clampable" }, p, toggle);
}

function timelineCategory(eventType) {
  if (eventType.startsWith("artifact.")) return "revision";
  const head = eventType.split(".")[0];
  return ["workspace", "review", "intent", "work", "chat"].includes(head) ? head : "workspace";
}

function setConnection(kind, label, explanation = label) {
  els.connection.className = `badge badge-${kind}`;
  els.connection.textContent = label;
  els.connection.title = explanation;
  els.connection.setAttribute("aria-label", explanation);
}

function flashAt(element, text, isError = false) {
  element.hidden = false;
  element.textContent = text;
  element.classList.toggle("error", isError);
  clearTimeout(flashTimers.get(element));
  flashTimers.set(
    element,
    setTimeout(() => {
      element.hidden = true;
    }, 4000),
  );
}

function recoveryAt(element, text, label, retry) {
  clearTimeout(flashTimers.get(element));
  element.hidden = false;
  element.classList.add("error");
  const button = el("button", { type: "button", class: "small" }, label);
  button.addEventListener("click", retry);
  element.replaceChildren(el("span", {}, text), button);
  return button;
}

function flash(text, isError = false) {
  flashAt(els.flash, text, isError);
}

function renderNotifications() {
  const supported = "Notification" in window;
  const permission = supported ? Notification.permission : "unsupported";
  const enabled = supported && state.notificationsEnabled && permission === "granted";
  const blocked = permission === "denied";
  els.notificationsToggle.disabled = !supported || blocked;
  els.notificationsToggle.classList.toggle("enabled", enabled);
  els.notificationsToggle.setAttribute("aria-pressed", String(enabled));
  els.notificationsToggle.setAttribute(
    "aria-label",
    !supported
      ? "Revision-ready notifications unavailable"
      : blocked
        ? "Revision-ready notifications blocked in browser settings"
        : enabled
          ? "Disable revision-ready notifications"
          : "Enable revision-ready notifications",
  );
  if (!supported) {
    els.notificationsStatus.hidden = false;
    els.notificationsStatus.textContent =
      "Notifications are unavailable here. Keep Tweakloop open to watch for ready work.";
    els.notificationsToggle.title = "Desktop notifications are unavailable in this browser";
  } else if (blocked) {
    els.notificationsStatus.hidden = false;
    els.notificationsStatus.textContent =
      "Notifications are blocked. Allow them in this site’s browser settings, then reload.";
    els.notificationsToggle.title = "Allow notifications in browser site settings, then reload";
  } else {
    els.notificationsToggle.title = enabled
      ? "Revision-ready notifications enabled while this tab stays open"
      : "Notify me when agent work is ready for review while this tab stays open";
    if (enabled) {
      els.notificationsStatus.hidden = true;
      els.notificationsStatus.textContent = "Revision-ready notifications are on.";
    } else {
      els.notificationsStatus.hidden = els.notificationsStatus.textContent.length === 0;
    }
  }
}

async function toggleNotifications() {
  if (!("Notification" in window)) return;
  if (state.notificationsEnabled && Notification.permission === "granted") {
    state.notificationsEnabled = false;
    localStorage.removeItem("tweakloop-ready-notifications");
    els.notificationsStatus.textContent = "Revision-ready notifications disabled.";
    els.notificationsStatus.hidden = false;
    renderNotifications();
    return;
  }
  const permission = await Notification.requestPermission();
  state.notificationsEnabled = permission === "granted";
  if (state.notificationsEnabled) {
    localStorage.setItem("tweakloop-ready-notifications", "enabled");
    els.notificationsStatus.textContent =
      "Notifications enabled. Tweakloop will tell you when agent work is ready for review.";
    els.notificationsStatus.hidden = false;
  } else {
    localStorage.removeItem("tweakloop-ready-notifications");
    els.notificationsStatus.textContent =
      permission === "denied"
        ? "Notifications are blocked. Allow them in this site’s browser settings, then reload."
        : "Notifications remain disabled.";
    els.notificationsStatus.hidden = false;
  }
  renderNotifications();
}

function notifyWorkReady(envelope) {
  if (
    envelope.eventType !== "work.addressed" ||
    !state.notificationsEnabled ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  ) {
    return;
  }
  const work = (state.snapshot?.work ?? []).find((item) => item.workId === envelope.payload.workId);
  const artifact = work ? artifacts().find((item) => item.artifactId === work.artifactId) : null;
  const taskLabel = work ? taskReference(work).label : (artifact?.name ?? "the task");
  const revision = revisionSeq(envelope.payload.revisionId);
  els.notificationsStatus.hidden = false;
  els.notificationsStatus.textContent = `${taskLabel} is ready for review.`;
  if (document.visibilityState === "visible") return;
  const notification = new Notification(
    revision ? "Tweakloop: review ready" : "Tweakloop: answer ready",
    {
      body: `${envelope.payload.agentId?.replace(/^agent:/, "") ?? "Your agent"} finished “${truncate(taskLabel, 70)}”. ${revision ? `Revision r${revision} is ready to review.` : "The answer is ready to review; no document changed."}`,
      tag: `tweakloop-ready-${envelope.payload.workId}`,
    },
  );
  notification.onclick = () => {
    window.focus();
    refreshSnapshot()
      .then(() => {
        if (work) state.selectedArtifactId = work.artifactId;
        state.pinnedRevisionId = null;
        state.activeTab = "work";
        render();
        const task = work
          ? document.querySelector(`[data-work-id="${CSS.escape(work.workId)}"]`)
          : null;
        task?.scrollIntoView({ block: "center", behavior: "smooth" });
        task?.classList.add("is-updating");
      })
      .catch(() => {});
    notification.close?.();
  };
}

// ---- rendering --------------------------------------------------------------

function render() {
  renderWorkspace();
  renderArtifacts();
  renderViewer();
  renderOutline();
  renderTabs();
  renderDrafts();
  renderFeedback();
  renderWork();
  renderChat();
  renderTimeline();
  renderNotifications();
  renderOnboardingProgress();
  hasRenderedSnapshot = true;
}

function renderWorkspace() {
  const ws = state.snapshot?.workspace;
  if (!ws) return;
  const workspaceName = ws.rootPath?.split("/").filter(Boolean).at(-1) ?? "workspace";
  const documentCount = artifacts().length;
  els.workspace.textContent = `${workspaceName} · ${documentCount} document${documentCount === 1 ? "" : "s"} · local-first`;
  els.workspace.title =
    `workspace ${ws.workspaceId} · project ${ws.projectId} · ` +
    `protocol v${ws.protocolVersion} · ${ws.rootPath}`;
  const hasArtifacts = documentCount > 0;
  els.artifactToolbar.hidden = !hasArtifacts;
  els.workspaceExport.hidden = !hasArtifacts;
  els.documentAdd.hidden = !hasArtifacts;
  els.documentsEmpty.hidden = hasArtifacts;
}

function renderArtifacts() {
  const artifact = selectedArtifact();
  const list = artifacts();
  els.artifactSelect.replaceChildren(
    ...list.map((a) => {
      const revCount = revisionsOf(a.artifactId).length;
      return el(
        "option",
        { "data-testid": "artifact-item", value: a.artifactId },
        `${a.name} · ${a.format} · ${revCount} rev${revCount === 1 ? "" : "s"}`,
      );
    }),
  );
  els.artifactSelect.disabled = list.length === 0;
  if (artifact) els.artifactSelect.value = artifact.artifactId;

  const intents = state.snapshot?.intents ?? [];
  const workItems = state.snapshot?.work ?? [];
  const rows = list.map((item) => {
    const active = item.artifactId === artifact?.artifactId;
    const kind = artifactKind(item);
    const kindLabel = artifactKindLabel(kind);
    const revCount = revisionsOf(item.artifactId).length;
    const openCount = intents.filter(
      (intent) => intent.artifactId === item.artifactId && intent.status !== "addressed",
    ).length;
    const itemWork = workItems.filter((work) => work.artifactId === item.artifactId);
    const readyCount = itemWork.filter(
      (work) => work.status === "addressed" && work.decision === "pending",
    ).length;
    const workingCount = itemWork.filter(
      (work) =>
        work.status === "claimed" && livePresenceForAgent(workAgentId(work))?.state === "working",
    ).length;
    const claimedCount = itemWork.filter((work) => work.status === "claimed").length;
    const queuedCount = itemWork.filter(
      (work) => work.status === "open" || work.decision === "reopened",
    ).length;
    const attention =
      readyCount > 0
        ? { kind: "ready", count: readyCount, label: "ready" }
        : workingCount > 0
          ? { kind: "working", count: workingCount, label: "working" }
          : claimedCount > 0
            ? { kind: "claimed", count: claimedCount, label: "claimed" }
            : queuedCount > 0 || openCount > 0
              ? { kind: "open", count: Math.max(queuedCount, openCount), label: "open" }
              : null;
    const button = el(
      "button",
      {
        type: "button",
        class: `artifact-row ${active ? "active" : ""}`,
        "data-testid": "document-item",
        "aria-current": active ? "page" : "false",
        "aria-label": `${active ? "Current" : "Open"} ${kindLabel} document ${item.name}, ${revCount} revision${revCount === 1 ? "" : "s"}${attention ? `, ${attention.count} ${attention.label}` : ""}`,
      },
      el(
        "span",
        { class: `artifact-glyph artifact-glyph-${kind}`, "aria-hidden": "true" },
        svgIcon(kind, "artifact-icon"),
      ),
      el(
        "span",
        { class: "artifact-copy" },
        el("strong", {}, item.name),
        el(
          "span",
          { class: "artifact-meta meta" },
          el("span", { class: `artifact-format artifact-format-${kind}` }, kindLabel),
          el("span", { "aria-hidden": "true" }, "·"),
          el("span", {}, `${revCount} rev${revCount === 1 ? "" : "s"}`),
        ),
      ),
      attention
        ? el(
            "span",
            {
              class: `document-attention attention-${attention.kind}`,
              title: `${attention.count} ${attention.label} item${attention.count === 1 ? "" : "s"} in this document`,
            },
            attention.kind === "working"
              ? el("span", { class: "task-spinner", "aria-hidden": "true" })
              : null,
            String(attention.count),
          )
        : null,
    );
    button.addEventListener("click", () => selectArtifact(item.artifactId));
    const row = el("li", { class: `artifact-entry ${active ? "active" : ""}` }, button);
    if (active) row.append(els.activeOutline);
    return row;
  });
  els.artifactList.replaceChildren(...rows);
}

function selectArtifact(artifactId) {
  flushAllWhiteboards();
  state.selectedArtifactId = artifactId;
  state.pinnedRevisionId = null;
  state.pendingReveal = null;
  state.pendingTarget = null;
  state.chatContext = null;
  render();
}

function renderViewer() {
  const artifact = selectedArtifact();
  const revision = viewedRevision();
  const revs = artifact ? revisionsOf(artifact.artifactId) : [];
  const head = revs[revs.length - 1];

  els.revisionSelect.replaceChildren(
    ...revs.map((r) =>
      el(
        "option",
        { value: r.revisionId },
        `r${r.seq} · ${r.producer?.id ?? "unknown"}${r === head ? " (head)" : ""}`,
      ),
    ),
  );
  els.revisionSelect.disabled = revs.length === 0;
  if (revision) els.revisionSelect.value = revision.revisionId;

  els.restoreRevision.hidden = !revision || revision.revisionId === head?.revisionId;
  els.modeToggle.disabled = !revision;
  els.modeInteract.disabled = !revision;
  els.viewerFullscreen.disabled = !revision;
  els.modeToggle.classList.toggle("active", state.mode === "annotate");
  els.modeInteract.classList.toggle("active", state.mode !== "annotate");
  els.modeToggle.setAttribute("aria-pressed", String(state.mode === "annotate"));
  els.modeInteract.setAttribute("aria-pressed", String(state.mode !== "annotate"));

  if (!artifact) {
    showViewerStart();
    return;
  }
  els.startSurface.hidden = true;
  if (!revision) {
    showViewerEmpty(
      `No revisions of ${artifact.name} yet — run \`tweak publish ${artifact.sourcePath ?? "<path>"}\`.`,
    );
    return;
  }
  els.viewerEmpty.hidden = true;
  els.viewerFrame.hidden = false;
  const src = `${state.snapshot.workspace.artifactOrigin}/r/${revision.revisionId}/`;
  if (els.viewerFrame.dataset.src !== src) {
    startViewerNavigation(artifact, revision, src);
  }
  if (state.viewerNavigation) {
    els.restoreRevision.disabled = true;
    els.modeToggle.disabled = true;
    els.modeInteract.disabled = true;
    els.viewerFullscreen.disabled = true;
  } else {
    els.restoreRevision.disabled = false;
  }
  els.nodesNote.textContent =
    state.nodes.length > 0
      ? `${state.nodes.length} semantic node${state.nodes.length === 1 ? "" : "s"}`
      : "";
  const boardRecord = activeWhiteboardRecord();
  els.publishWhiteboard.hidden = state.currentWhiteboards.length === 0;
  els.publishWhiteboard.disabled =
    Boolean(state.viewerNavigation) ||
    !boardRecord ||
    boardRecord.inFlight ||
    Boolean(boardRecord.conflict) ||
    Boolean(boardRecord.pendingApplyId) ||
    Boolean(boardRecord.applyError);
}

function showViewerEmpty(text) {
  clearTimeout(state.viewerNavigation?.timer);
  state.viewerNavigation = null;
  state.committedView = null;
  cancelWhiteboardApplies();
  els.viewerFrame.hidden = true;
  els.startSurface.hidden = true;
  els.viewerFrame.removeAttribute("src");
  els.viewerFrame.inert = false;
  els.viewerFrame.removeAttribute("aria-hidden");
  delete els.viewerFrame.dataset.src;
  els.viewerBody.classList.remove("is-loading", "is-failed");
  els.viewerBody.setAttribute("aria-busy", "false");
  els.viewerTransition.hidden = true;
  state.bridgePort = null;
  state.outlineLoading = false;
  state.nodes = [];
  state.currentWhiteboards = [];
  els.restoreRevision.hidden = true;
  els.viewerFullscreen.disabled = true;
  els.publishWhiteboard.hidden = true;
  els.viewerEmpty.hidden = false;
  els.viewerEmpty.textContent = text;
  els.nodesNote.textContent = "";
}

function showViewerStart() {
  showViewerEmpty("");
  els.viewerEmpty.hidden = true;
  els.startSurface.hidden = false;
  els.viewerBody.setAttribute("aria-busy", String(state.onboarding.busy));
  const agentName = safeAgentName();
  const presence = assignedAgentPresence();
  if (agentName && presence) {
    els.startAgentAssurance.dataset.state = "connected";
    els.startAgentAssurance.textContent = `${agentName} is connected. Anything you add becomes durable session context.`;
  } else if (agentName) {
    els.startAgentAssurance.dataset.state = "offline";
    els.startAgentAssurance.textContent = `${agentName} is assigned but offline. Anything you add remains available in this session.`;
  } else {
    els.startAgentAssurance.dataset.state = "unattached";
    els.startAgentAssurance.textContent =
      "No agent is attached yet. You can start now and connect one later.";
  }
}

function startViewerNavigation(artifact, revision, src) {
  if (!artifact || !revision) {
    failViewerNavigation("The requested artifact or revision is no longer available.");
    return;
  }
  clearTimeout(state.viewerNavigation?.timer);
  cancelWhiteboardApplies();
  state.bridgePort?.close?.();
  state.bridgePort = null;
  state.outlineLoading = true;
  state.nodes = [];
  state.whiteboardLoads.clear();
  state.currentWhiteboards = [];
  const navigation = {
    artifactId: artifact.artifactId,
    artifactName: artifact.name,
    revisionId: revision.revisionId,
    revisionSeq: revision.seq,
    src,
    status: "loading",
    previous: state.committedView,
    timer: null,
  };
  state.viewerNavigation = navigation;
  els.viewerBody.classList.add("is-loading");
  els.viewerBody.classList.remove("is-failed");
  els.viewerBody.setAttribute("aria-busy", "true");
  els.viewerFrame.inert = true;
  els.viewerFrame.setAttribute("aria-hidden", "true");
  els.modeToggle.disabled = true;
  els.modeInteract.disabled = true;
  els.viewerFullscreen.disabled = true;
  els.publishWhiteboard.disabled = true;
  els.viewerTransition.hidden = false;
  els.viewerTransition.className = "viewer-transition loading";
  els.viewerTransition.textContent = `Loading ${artifact.name} · r${revision.seq}… Wait while Tweakloop verifies this revision.`;
  els.viewerFrame.dataset.src = src;
  els.viewerFrame.src = `${src}?navigation=${encodeURIComponent(crypto.randomUUID())}`;
  navigation.timer = setTimeout(() => {
    if (state.viewerNavigation === navigation) {
      failViewerNavigation("The requested revision did not become ready in time.");
    }
  }, 12_000);
}

function completeViewerNavigation(revisionId) {
  const navigation = state.viewerNavigation;
  if (!navigation || navigation.revisionId !== revisionId) return false;
  clearTimeout(navigation.timer);
  state.committedView = {
    artifactId: navigation.artifactId,
    revisionId: navigation.revisionId,
    src: navigation.src,
  };
  state.viewerNavigation = null;
  els.viewerBody.classList.remove("is-loading", "is-failed");
  els.viewerBody.setAttribute("aria-busy", "false");
  els.viewerFrame.inert = false;
  els.viewerFrame.removeAttribute("aria-hidden");
  els.viewerTransition.hidden = true;
  return true;
}

function returnToCommittedView(navigation) {
  const previous = navigation.previous;
  if (!previous) return;
  clearTimeout(navigation.timer);
  state.viewerNavigation = null;
  state.pendingReveal = null;
  state.selectedArtifactId = previous.artifactId;
  const revisions = revisionsOf(previous.artifactId);
  const head = revisions[revisions.length - 1];
  state.pinnedRevisionId = previous.revisionId === head?.revisionId ? null : previous.revisionId;
  delete els.viewerFrame.dataset.src;
  render();
}

function failViewerNavigation(message) {
  const navigation = state.viewerNavigation;
  if (!navigation) return;
  clearTimeout(navigation.timer);
  navigation.status = "failed";
  els.viewerBody.classList.remove("is-loading");
  els.viewerBody.classList.add("is-failed");
  els.viewerBody.setAttribute("aria-busy", "false");
  els.viewerFrame.inert = true;
  els.viewerFrame.setAttribute("aria-hidden", "true");
  els.viewerTransition.hidden = false;
  els.viewerTransition.className = "viewer-transition error";
  const retry = el("button", { type: "button", class: "small" }, "Retry");
  retry.addEventListener("click", () =>
    startViewerNavigation(
      artifacts().find((item) => item.artifactId === navigation.artifactId),
      revisionsOf(navigation.artifactId).find((item) => item.revisionId === navigation.revisionId),
      navigation.src,
    ),
  );
  const controls = [retry];
  if (navigation.previous) {
    const back = el("button", { type: "button", class: "ghost small" }, "Return");
    back.addEventListener("click", () => returnToCommittedView(navigation));
    controls.push(back);
  }
  els.viewerTransition.replaceChildren(
    el(
      "span",
      {},
      `${navigation.artifactName} · r${navigation.revisionSeq} could not load. ${message}`,
    ),
    el("span", { class: "viewer-transition-actions" }, ...controls),
  );
  retry.focus();
}

function activateCollaborationTab(name, { persist = false, focus = false } = {}) {
  if (!["work", "feedback", "chat"].includes(name)) return;
  state.activeTab = name;
  if (name !== "chat") state.chatExpanded = false;
  if (persist) localStorage.setItem(COLLABORATION_TAB_STORAGE, name);
  renderTabs();
  if (focus) els.tabs.find((tab) => tab.dataset.tab === name)?.focus();
}

function renderTabs() {
  const visibleArtifactIds = activeArtifactIds();
  const intents = (state.snapshot?.intents ?? []).filter((i) =>
    visibleArtifactIds.has(i.artifactId),
  );
  const work = (state.snapshot?.work ?? []).filter((w) => visibleArtifactIds.has(w.artifactId));
  const resolvedIntentIds = new Set(
    work.filter((item) => item.decision === "accepted").flatMap((item) => item.intentIds),
  );
  const openCount = intents.filter((intent) => !resolvedIntentIds.has(intent.intentId)).length;
  const counts = {
    drafts: state.drafts.length,
    work: work.filter((item) => item.decision !== "accepted").length,
    chat: chatMessages().length,
    timeline: 0,
  };
  els.draftsCount.textContent = String(counts.drafts);
  els.commentsCount.textContent = String(openCount);
  els.tasksCount.textContent = String(counts.work);
  els.chatCount.textContent = String(counts.chat);
  for (const tab of els.tabs) {
    const name = tab.dataset.tab;
    if (name === "feedback") {
      tab.textContent = openCount > 0 ? `Comments (${openCount})` : "Comments";
    } else if (name === "work") {
      tab.textContent = counts.work > 0 ? `Tasks (${counts.work})` : "Tasks";
    } else {
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      tab.textContent = counts[name] > 0 ? `${label} (${counts[name]})` : label;
    }
    const active = state.activeTab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of els.panels) {
    const active = panel.dataset.panel === state.activeTab;
    panel.hidden = !active;
    panel.classList.toggle("focused-section", active);
  }
  els.collaborationStack.hidden = state.activeTab === "chat";
  els.agentRail.classList.toggle("chat-active", state.activeTab === "chat");
  renderAgentSummary();
  renderWorkspaceLayout();
}

function renderAgentSummary() {
  clearTimeout(agentActivityTimer);
  agentActivityTimer = null;
  const visibleArtifactIds = activeArtifactIds();
  const allIntents = state.snapshot?.intents ?? [];
  const allWork = (state.snapshot?.work ?? []).filter(isLegalWorkState);
  const work = allWork.filter((item) => visibleArtifactIds.has(item.artifactId));
  const ready = work.filter((item) => item.status === "addressed" && item.decision === "pending");
  const allOpen = allIntents.filter((intent) => intent.status !== "addressed");
  const allReady = allWork.filter(
    (item) => item.status === "addressed" && item.decision === "pending",
  );
  const allClaimed = allWork.filter((item) => item.status === "claimed");
  const allQueued = allWork.filter(
    (item) => item.status === "open" || item.decision === "reopened",
  );
  const activeWork =
    ready[0] ??
    work.find((item) => item.status === "claimed") ??
    work.find((item) => item.status === "open" || item.decision === "reopened") ??
    allReady[0] ??
    allClaimed[0] ??
    allQueued[0];
  const activeWorkIsElsewhere = Boolean(
    activeWork && !visibleArtifactIds.has(activeWork.artifactId),
  );
  const activeWorkArtifact = activeWork
    ? artifacts().find((item) => item.artifactId === activeWork.artifactId)
    : null;
  const elsewhereSuffix =
    activeWorkIsElsewhere && activeWorkArtifact ? ` in ${activeWorkArtifact.name}` : "";
  const assignedPresence = assignedAgentPresence();
  const assignedAgentId = state.sessionContext.agentId?.replace(/^agent:/, "") ?? null;
  const assignedProfile = resolveAgentProfile(assignedAgentId);
  const agentLabel = assignedAgentId ? assignedProfile.label : null;
  const assignedClaim = assignedAgentId
    ? allClaimed.find(
        (item) => normalizedAgentToken(workAgentId(item)) === normalizedAgentToken(assignedAgentId),
      )
    : null;
  const recentAcknowledgement = recentAcknowledgementForAgent(assignedAgentId);
  if (recentAcknowledgement) {
    const acknowledgedAt = Date.parse(recentAcknowledgement.delivery.acknowledgedAt);
    const expiresIn = acknowledgedAt + PROGRESS_RECENT_WINDOW_MS - Date.now() + 1;
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      agentActivityTimer = setTimeout(renderAgentSummary, Math.min(expiresIn, 2_147_483_647));
    }
  }
  const agentActivityState = state.presenceReconnecting
    ? "reconnecting"
    : assignedPresence
      ? "live"
      : assignedClaim
        ? "claimed-work"
        : recentAcknowledgement
          ? "acknowledged-recently"
          : assignedAgentId
            ? "offline"
            : "unattached";

  els.agentName.textContent = agentLabel ?? "Agent";
  els.agentName.title = assignedAgentId ?? "Agent";
  applyAgentMark(els.agentHeaderMark, assignedProfile);
  applyAgentMark(els.agentSheetMark, assignedProfile);
  els.agentStatus.textContent = state.presenceReconnecting
    ? "Assigned · reconnecting"
    : assignedPresence
      ? assignedPresence.state === "listening"
        ? "Available"
        : assignedPresence.state === "thinking"
          ? "Thinking"
          : "Working"
      : assignedClaim
        ? "Claimed"
        : recentAcknowledgement
          ? "Acknowledged recently"
          : assignedAgentId
            ? "Assigned · offline"
            : "Unattached";
  const agentStatusExplanation = state.presenceReconnecting
    ? `${agentLabel ?? "The agent"} is assigned, but live presence updates were interrupted. Tweakloop is retrying automatically; saved messages remain in the inbox.`
    : assignedPresence
      ? assignedPresence.state === "listening"
        ? `${agentLabel ?? "The agent"} is assigned and currently listening for work.`
        : `${agentLabel ?? "The agent"} is assigned and reports ${assignedPresence.state}.`
      : assignedClaim
        ? `${agentLabel ?? "The agent"} owns claimed work ${assignedClaim.workId}. Live presence is unavailable, so this durable work state does not prove the agent is currently connected.`
        : recentAcknowledgement
          ? `${agentLabel ?? "The agent"} acknowledged a message recently. Live presence is unavailable, so acknowledgement proves receipt but not that the agent is still connected or working.`
          : assignedAgentId
            ? `${agentLabel ?? "The agent"} is assigned but not connected. Saved messages remain in the inbox until the agent reconnects.`
            : "No agent is assigned. Attach an agent to begin live collaboration.";
  els.agentStatus.title = agentStatusExplanation;
  els.agentStatus.setAttribute("aria-label", agentStatusExplanation);
  els.agentStatus.dataset.activityState = agentActivityState;
  els.agentStatus.className = `badge ${
    assignedPresence && !state.presenceReconnecting
      ? "badge-live"
      : assignedClaim
        ? "badge-claimed"
        : recentAcknowledgement
          ? "badge-recent"
          : "badge-wait"
  }`;
  setLiveText(els.taskbarDrafts, String(state.drafts.length));
  setLiveText(els.taskbarOpen, String(allOpen.length));
  setLiveText(els.taskbarAddressed, String(allReady.length));
  const activeWorkPresence = activeWork ? livePresenceForAgent(workAgentId(activeWork)) : null;
  const activeWorkIsWorking =
    activeWork?.status === "claimed" && activeWorkPresence?.state === "working";
  const taskbarText = activeWork
    ? activeWork.status === "addressed" && activeWork.decision === "pending"
      ? `Ready for your review${elsewhereSuffix}`
      : activeWork.status === "claimed"
        ? `${activeWorkPresence?.state === "thinking" ? "Thinking" : activeWorkIsWorking ? "Working" : "Claimed"}${elsewhereSuffix} · ${activeWork.claim?.agentId?.replace(/^agent:/, "") ?? "agent"}`
        : activeWork.decision === "reopened"
          ? `Another pass requested${elsewhereSuffix}`
          : `Next comment is queued${elsewhereSuffix}`
    : allOpen.length > 0
      ? "Comments waiting for work"
      : state.drafts.length > 0
        ? `${state.drafts.length} local comment${state.drafts.length === 1 ? "" : "s"} ready to queue`
        : "Waiting for a comment";
  if (activeWorkIsWorking) {
    const previous = els.taskbarCurrent.textContent;
    els.taskbarCurrent.replaceChildren(
      el("span", { class: "task-spinner", "aria-hidden": "true" }),
      document.createTextNode(taskbarText),
    );
    if (previous !== taskbarText && hasRenderedSnapshot) {
      els.taskbarCurrent.classList.remove("state-pulse");
      void els.taskbarCurrent.offsetWidth;
      els.taskbarCurrent.classList.add("state-pulse");
    }
  } else {
    setLiveText(els.taskbarCurrent, taskbarText);
  }
  els.sheetSummary.textContent = `${agentLabel ?? "No agent attached"} · ${allOpen.length} open · ${allReady.length} ready`;
  els.chatInput.placeholder = agentLabel
    ? `Message ${agentLabel}… Type @ to add context`
    : "Message the agent… Type @ to add context";
}

function renderDrafts() {
  const pending = state.pendingTarget;
  els.draftForm.hidden = pending === null;
  if (pending) {
    els.draftTarget.textContent = targetLabel(pending.target);
    updateDraftFields();
  }

  els.localReviewQueue.hidden = state.drafts.length === 0;
  els.draftsContext.hidden = state.drafts.length === 0;
  if (state.drafts.length > 0) {
    const first = state.drafts[0];
    const artifact = artifacts().find((a) => a.artifactId === first.artifactId);
    els.draftsContext.textContent = `targeting r${revisionSeq(first.revisionId) ?? "?"} of ${artifact?.name ?? first.artifactId}`;
  }

  els.draftList.replaceChildren(
    ...state.drafts.map((draft) => {
      const motion = entityMotion(
        "drafts",
        draft.intentId,
        `${draft.intentType}:${bodyText(draft.body)}`,
      );
      const remove = el(
        "button",
        {
          type: "button",
          class: "draft-remove",
          title: "Discard local draft",
          "aria-label": "Discard local draft",
        },
        "✕",
      );
      remove.addEventListener("click", () => {
        state.drafts = state.drafts.filter((d) => d.intentId !== draft.intentId);
        renderTabs();
        renderDrafts();
      });
      const sendNow = el(
        "button",
        {
          type: "button",
          class: "ghost small draft-send-now",
          "data-testid": "draft-send-now",
          title: "Submit only this comment for durable review",
        },
        "Send now",
      );
      sendNow.addEventListener("click", () => {
        submitDraftBatch([draft], {
          control: sendNow,
          successMessage: "Comment saved for review ✓",
        }).catch(() => flash("daemon unreachable", true));
      });
      return el(
        "li",
        { "data-testid": "draft-item", class: `card local-draft${motion}` },
        el(
          "div",
          { class: "row" },
          chip(draft.intentType),
          el("span", { class: "local-draft-label" }, "Local · not sent"),
          el("span", { class: "draft-actions" }, sendNow, remove),
        ),
        el("p", { class: "target" }, targetLabel(draft.target)),
        el("p", { class: "body" }, truncate(bodyText(draft.body), 160)),
      );
    }),
  );
  els.draftsEmpty.hidden = true;
  els.submitReview.disabled = state.drafts.length === 0;
  els.submitReview.textContent =
    state.drafts.length > 0 ? `Send all comments (${state.drafts.length})` : "Send all comments";
  const hasActiveComments = (state.snapshot?.intents ?? []).some(
    (intent) =>
      activeArtifactIds().has(intent.artifactId) &&
      !(state.snapshot?.work ?? []).some(
        (work) => work.decision === "accepted" && work.intentIds.includes(intent.intentId),
      ),
  );
  els.feedbackEmpty.hidden = hasActiveComments || state.drafts.length > 0;
}

function updateDraftFields() {
  const type = els.draftIntentType.value;
  els.draftTextCaption.textContent =
    type === "replace-text"
      ? "replacement value"
      : type === "add-constraint"
        ? "constraint statement"
        : "text";
  els.draftRationaleField.hidden = type !== "add-constraint";
}

function renderFeedback() {
  const visibleArtifactIds = activeArtifactIds();
  const list = (state.snapshot?.intents ?? []).filter((i) => visibleArtifactIds.has(i.artifactId));
  const resolvedIntentIds = new Set(
    (state.snapshot?.work ?? [])
      .filter((work) => work.decision === "accepted")
      .flatMap((work) => work.intentIds),
  );
  const open = list
    .filter((intent) => !resolvedIntentIds.has(intent.intentId))
    .sort((a, b) => b.createdSeq - a.createdSeq);
  const done = list
    .filter((intent) => resolvedIntentIds.has(intent.intentId))
    .sort((a, b) => b.createdSeq - a.createdSeq);
  els.intentList.replaceChildren(...open.map((intent) => commentCard(intent, false)));
  els.resolvedIntentList.replaceChildren(...done.map((intent) => commentCard(intent, true)));
  els.resolvedCommentsCount.textContent = String(done.length);
  els.resolvedCommentsEmpty.hidden = done.length > 0;
  els.feedbackEmpty.hidden = open.length > 0 || state.drafts.length > 0;
}

const LOCATE_CONTROL_SELECTOR =
  "a, button, input, textarea, select, summary, [role='button'], [role='link'], [contenteditable='true']";

function locateBlockedByInteraction(event, surface) {
  const target = event.target instanceof Element ? event.target : null;
  const nestedControl = target?.closest(LOCATE_CONTROL_SELECTOR);
  if (nestedControl && nestedControl !== surface) return true;
  if (event.type !== "click" || event.detail === 0) return false;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

function wireCardLocate(surface, intent) {
  surface.addEventListener("click", (event) => {
    if (locateBlockedByInteraction(event, surface)) return;
    locateIntentTarget(intent);
  });
  if (surface instanceof HTMLButtonElement) return;
  surface.addEventListener("keydown", (event) => {
    if (event.target !== surface || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    locateIntentTarget(intent);
  });
}

function commentCard(intent, resolved) {
  const ready = intent.status === "addressed" && !resolved;
  const motion = entityMotion(
    "intents",
    intent.intentId,
    `${intent.status}:${resolved}:${intent.revisionId}:${bodyText(intent.body)}`,
  );
  const cardContent = el(
    "div",
    {
      class: "card-locate-surface",
    },
    el(
      "div",
      { class: "row" },
      chip(intent.intentType),
      el(
        "span",
        { class: `badge ${resolved ? "badge-live" : ready ? "badge-warn" : "badge-wait"}` },
        resolved ? "✓ resolved" : ready ? "ready to review" : "open",
      ),
      el("span", { class: "meta" }, `r${revisionSeq(intent.revisionId) ?? "?"}`),
    ),
    el("p", { class: "target" }, targetLabel(intent.target)),
    el("p", { class: "body" }, bodyText(intent.body)),
  );
  const card = el(
    "li",
    {
      "data-testid": "intent-item",
      class: `card locatable-card ${resolved ? "addressed" : ""}${motion}`,
      role: "button",
      tabindex: "0",
      "aria-label": `Open comment in artifact: ${targetLabel(intent.target)}`,
    },
    cardContent,
  );
  wireCardLocate(card, intent);
  const relatedWork = (state.snapshot?.work ?? []).find((item) =>
    item.intentIds.includes(intent.intentId),
  );
  if (!relatedWork || relatedWork.decision === "accepted") {
    const track = el(
      "button",
      {
        type: "button",
        class: "ghost small comment-track",
        "data-testid": resolved ? "comment-reopen" : "comment-track",
      },
      relatedWork ? "Reopen task" : "Track as task",
    );
    track.addEventListener("click", (event) => {
      event.stopPropagation();
      trackIntentAsTask(intent, relatedWork ?? null, track);
    });
    card.append(el("div", { class: "row decision-actions locatable-card-actions" }, track));
  }
  return card;
}

function trackingOperation(intent, existingWork) {
  const prior = state.trackingIntentOperations.get(intent.intentId);
  if (prior) return prior;
  const operationId = crypto.randomUUID();
  const operation = {
    commandId: crypto.randomUUID(),
    idempotencyKey: `work.create-from-intents:${intent.intentId}:${operationId}`,
    workId: existingWork?.workId ?? `work_${crypto.randomUUID()}`,
    decisionId: `decision_${crypto.randomUUID()}`,
  };
  state.trackingIntentOperations.set(intent.intentId, operation);
  return operation;
}

async function trackIntentAsTask(intent, existingWork, button) {
  if (!state.snapshot) return false;
  const operation = trackingOperation(intent, existingWork);
  const envelope = {
    protocol: COMMAND_PROTOCOL,
    commandId: operation.commandId,
    idempotencyKey: operation.idempotencyKey,
    workspaceId: state.snapshot.workspace.workspaceId,
    actor: { kind: "human", id: "browser" },
    type: "work.create-from-intents",
    payload: {
      workId: operation.workId,
      intentIds: [intent.intentId],
      decisionId: operation.decisionId,
      reason: "Track this review comment as durable work",
      assigneeAgentId: state.sessionContext.agentId,
      sessionId: state.sessionContext.sessionId,
    },
  };
  button.disabled = true;
  button.textContent = existingWork ? "Reopening…" : "Tracking…";
  try {
    const response = await fetch("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.status !== "accepted") {
      if (response.status < 500 && response.status !== 408 && response.status !== 429) {
        state.trackingIntentOperations.delete(intent.intentId);
      }
      throw new Error(data.message ?? data.error ?? String(response.status));
    }
    await refreshSnapshot();
    state.trackingIntentOperations.delete(intent.intentId);
    flash(existingWork ? "Task reopened for another pass ✓" : "Comment tracked as a task ✓");
    return true;
  } catch (error) {
    button.disabled = false;
    button.textContent = existingWork ? "Reopen task" : "Track as task";
    flash(`Task tracking failed: ${error?.message ?? "the daemon is unreachable"}`, true);
    return false;
  }
}

/** Ask the bridge to scroll the comment's anchor into view and pulse it. */
function revealTarget(target) {
  state.bridgePort?.postMessage({
    protocol: BRIDGE_PROTOCOL,
    type: "reveal-target",
    payload: {
      semanticId: target?.semanticId ?? null,
      domHint: target?.domHint ?? null,
      textQuote: target?.textQuote ?? null,
      boardAnchor: target?.boardAnchor ?? null,
    },
  });
}

function locateIntentTarget(intent) {
  const target = intent?.target;
  const embeddedArtifactId = target?.boardAnchor?.whiteboardArtifactId;
  if (embeddedArtifactId && activeArtifactIds().has(embeddedArtifactId)) {
    revealTarget(target);
    return;
  }

  const artifact = artifacts().find((item) => item.artifactId === intent?.artifactId);
  const revisions = artifact ? revisionsOf(artifact.artifactId) : [];
  const revision = revisions.find((item) => item.revisionId === intent?.revisionId);
  if (!artifact || !revision) {
    state.pendingReveal = null;
    flashAt(
      els.viewerFlash,
      "This card's exact artifact revision is no longer available; Tweakloop did not open a neighboring revision.",
      true,
    );
    return;
  }

  if (
    !state.viewerNavigation &&
    state.committedView?.artifactId === artifact.artifactId &&
    state.committedView.revisionId === revision.revisionId
  ) {
    revealTarget(target);
    return;
  }

  const head = revisions[revisions.length - 1];
  state.pendingReveal = {
    artifactId: artifact.artifactId,
    revisionId: revision.revisionId,
    target,
  };
  state.selectedArtifactId = artifact.artifactId;
  state.pinnedRevisionId = revision.revisionId === head?.revisionId ? null : revision.revisionId;
  render();
}

function workAgentId(work) {
  return work.claim?.agentId ?? work.assigneeAgentId ?? work.progress?.at(-1)?.agentId ?? null;
}

function progressTargetLabel(progress, intentById) {
  const targets = (progress?.addressedIntentIds ?? [])
    .map((intentId) => intentById.get(intentId)?.target)
    .filter(Boolean)
    .map(targetLabel);
  if (targets.length === 1) return targets[0];
  if (targets.length > 1) return `${targets.length} addressed targets`;
  if (progress?.revisionId) {
    const seq = revisionSeq(progress.revisionId);
    return seq === null ? `Revision ${progress.revisionId}` : `Revision r${seq}`;
  }
  return "Target unavailable";
}

function workStatusBadge(work, legal) {
  const agentId = workAgentId(work);
  const agent = agentId ? resolveAgentProfile(agentId).label : "agent unavailable";
  const activeClaim = legal && work.status === "claimed";
  const label = !legal
    ? "Work · unavailable"
    : work.status === "open"
      ? "Work · open"
      : work.status === "addressed"
        ? "Work · addressed"
        : `Work · claimed · ${agent}`;
  const badge = el(
    "span",
    {
      class: `badge work-status ${activeClaim ? "badge-claimed" : work.status === "addressed" ? "badge-warn" : "badge-wait"}`,
      "data-testid": "work-status",
      "aria-label": legal
        ? `Work status: ${work.status}${work.status === "claimed" ? ` by ${agent}` : ""}`
        : `Work status unavailable: ${work.status}/${work.decision} is not a legal pair`,
    },
    label,
  );
  return { badge, activeClaim };
}

function workDecisionBadge(work) {
  const label =
    work.decision === "accepted"
      ? "Decision · accepted"
      : work.decision === "reopened"
        ? "Decision · reopened"
        : "Decision · pending";
  return el(
    "span",
    {
      class: `badge work-decision ${work.decision === "accepted" ? "badge-live" : work.decision === "reopened" ? "badge-warn" : "badge-wait"}`,
      "data-testid": "work-decision",
      "aria-label": `Human decision: ${work.decision}`,
    },
    label,
  );
}

function workPresenceBadge(work) {
  const agentId = workAgentId(work);
  const presence = livePresenceForAgent(agentId);
  const agent = agentId ? resolveAgentProfile(agentId).label : null;
  const label = presence
    ? `Presence · ${presence.state === "listening" ? "available" : presence.state}`
    : agent
      ? "Presence · unavailable"
      : "Presence · no agent";
  return {
    state: presence ? "live" : "unavailable",
    badge: el(
      "span",
      {
        class: `badge work-presence ${presence ? "badge-live" : "badge-wait"}`,
        "data-testid": "work-presence",
        "aria-label": presence
          ? `Live presence for ${agent}: ${presence.state}`
          : agent
            ? `Live presence for ${agent} is unavailable or expired`
            : "No agent is assigned, so live presence is unavailable",
      },
      label,
    ),
  };
}

function workProgressPanel(work, intentById) {
  const progress = Array.isArray(work.progress) ? work.progress : [];
  const latest = progress.at(-1);
  if (!latest) {
    return {
      state: "none",
      panel: el(
        "p",
        {
          class: "work-progress empty-progress",
          "data-testid": "work-progress",
          "aria-label": "No durable progress has been recorded",
        },
        "No durable progress recorded",
      ),
    };
  }
  const agent = resolveAgentProfile(latest.agentId).label;
  const target = progressTargetLabel(latest, intentById);
  const seq = Number.isSafeInteger(latest.seq) && latest.seq > 0 ? latest.seq : null;
  const recordedAt =
    typeof latest.recordedAt === "string" && Number.isFinite(Date.parse(latest.recordedAt))
      ? latest.recordedAt
      : null;
  const ageState = recordedAt ? progressAgeState(recordedAt) : "unknown";
  const timing =
    seq !== null && recordedAt !== null
      ? `event #${seq} · ${recordedAt}`
      : `${seq === null ? "event sequence unavailable" : `event #${seq}`} · ${recordedAt ?? "recorded time unavailable"}`;
  return {
    state: ageState,
    panel: el(
      "section",
      {
        class: `work-progress is-${ageState}`,
        "data-testid": "work-progress",
        "data-progress-age": ageState,
        "data-progress-window-ms": String(PROGRESS_RECENT_WINDOW_MS),
        "aria-label": `Latest durable progress by ${agent} for ${target}. ${timing}. Progress age: ${ageState}; recent means no more than five minutes old.`,
      },
      el(
        "span",
        { class: "work-progress-heading" },
        el("span", { class: "work-progress-label" }, "Latest durable progress"),
        el(
          "span",
          {
            class: `badge work-progress-age is-${ageState}`,
            "data-testid": "work-progress-age",
            "aria-label": `Progress age: ${ageState}; recent means no more than five minutes old`,
          },
          ageState === "recent"
            ? "Recent · ≤5m"
            : ageState === "old"
              ? "Old · >5m"
              : "Age unavailable",
        ),
      ),
      el("p", { class: "work-progress-summary" }, latest.summary),
      el("p", { class: "work-progress-meta" }, `By ${agent} · ${target} · ${timing}`),
    ),
  };
}

function renderWork() {
  const visibleArtifactIds = activeArtifactIds();
  const workItems = (state.snapshot?.work ?? [])
    .filter((w) => visibleArtifactIds.has(w.artifactId))
    .sort((a, b) => b.createdSeq - a.createdSeq);
  const intentById = new Map((state.snapshot?.intents ?? []).map((i) => [i.intentId, i]));

  const legalWorkItems = workItems.filter(isLegalWorkState);
  const openTasks = legalWorkItems.filter((work) => work.status !== "addressed").length;
  const readyTasks = legalWorkItems.filter(
    (work) => work.status === "addressed" && work.decision === "pending",
  ).length;
  const acceptedTasks = legalWorkItems.filter((work) => work.decision === "accepted").length;
  const invalidTasks = workItems.length - legalWorkItems.length;
  els.tasksSummary.hidden = workItems.length === 0;
  els.tasksSummary.textContent = `${openTasks} active · ${readyTasks} ready · ${acceptedTasks} accepted${invalidTasks > 0 ? ` · ${invalidTasks} invalid` : ""}`;

  els.workList.replaceChildren(
    ...workItems.map((work) => {
      const legal = isLegalWorkState(work);
      const { badge: statusBadge, activeClaim } = workStatusBadge(work, legal);
      const decisionBadge = workDecisionBadge(work);
      const presence = workPresenceBadge(work);
      const activelyWorking =
        activeClaim && livePresenceForAgent(workAgentId(work))?.state === "working";
      const progress = workProgressPanel(work, intentById);
      const motion = entityMotion(
        "work",
        work.workId,
        `${work.status}:${work.decision}:${work.claim?.agentId ?? ""}:${work.result?.revisionId ?? ""}:${JSON.stringify(work.progress ?? [])}:${presence.state}:${work.intentIds.join(",")}`,
      );
      const group = el(
        "li",
        {
          "data-testid": "work-item",
          "data-work-id": work.workId,
          "data-work-status": work.status,
          "data-decision-status": work.decision,
          "data-progress-state": progress.state,
          "data-presence-state": presence.state,
          "data-invalid-state": String(!legal),
          class: `card task-group ${activelyWorking ? "is-working" : activeClaim ? "is-claimed" : ""}${!legal ? " has-invalid-state" : ""}${motion}`,
        },
        el(
          "div",
          { class: "row work-state-axes" },
          statusBadge,
          decisionBadge,
          presence.badge,
          el("span", { class: "meta" }, `base r${revisionSeq(work.baseRevisionId) ?? "?"}`),
        ),
      );
      if (!legal) {
        group.append(
          el(
            "p",
            { class: "work-state-error", role: "status" },
            `State unavailable: ${work.status}/${work.decision} is not a legal work and decision pair.`,
          ),
        );
      }
      if (work.result?.summary) group.append(clampable(work.result.summary, "body"));
      group.append(progress.panel);

      const tasks = el("ul", { class: "task-list" });
      for (const intentId of work.intentIds) {
        const intent = intentById.get(intentId);
        if (!intent) continue;
        const done = intent.status === "addressed";
        const anchored = intent.target?.semanticId || intent.target?.textQuote?.exact;
        const label = anchored ? targetLabel(intent.target) : bodyText(intent.body);
        const row = el(
          "button",
          {
            type: "button",
            "data-testid": "task-item",
            class: "task-locate",
            "aria-label": `Open task in artifact: ${label}`,
          },
          activelyWorking && !done
            ? el("span", { class: "task-spinner", "aria-hidden": "true" })
            : el("span", { class: "task-glyph" }, done ? "✓" : "○"),
          chip(intent.intentType),
          el("span", { class: "task-label", title: label }, truncate(label, 60)),
        );
        wireCardLocate(row, intent);
        tasks.append(el("li", { class: `task-item ${done ? "done" : ""}` }, row));
      }
      group.append(tasks);

      const actions = [];
      if (work.result?.revisionId) {
        const seq = revisionSeq(work.result.revisionId);
        const view = el("button", { type: "button", class: "ghost small" }, `view r${seq ?? "?"}`);
        view.addEventListener("click", () => {
          state.selectedArtifactId = work.artifactId;
          state.pinnedRevisionId = work.result.revisionId;
          render();
        });
        actions.push(view);
      } else if (work.status === "addressed") {
        group.append(
          el("p", { class: "meta no-revision-result" }, "Response only · no artifact change"),
        );
      }
      if (legal && work.status === "addressed" && work.decision === "pending") {
        const accept = el(
          "button",
          {
            type: "button",
            class: "small decision-accept",
            "data-testid": "decision-accept",
          },
          "Accept",
        );
        accept.addEventListener("click", () => submitDecision(work, "accept", accept));
        const reopen = el(
          "button",
          {
            type: "button",
            class: "ghost small decision-reopen",
            "data-testid": "decision-reopen",
          },
          "Another pass",
        );
        reopen.addEventListener("click", () => openDecisionDialog(work, reopen));
        actions.push(accept, reopen);
      } else if (legal && work.decision === "accepted") {
        const reopen = el(
          "button",
          {
            type: "button",
            class: "ghost small decision-reopen",
            "data-testid": "decision-reopen",
          },
          "Reopen",
        );
        reopen.addEventListener("click", () => openDecisionDialog(work, reopen));
        actions.push(reopen);
      }
      if (actions.length > 0) {
        group.append(el("div", { class: "row decision-actions" }, ...actions));
      }
      return group;
    }),
  );
  els.workEmpty.hidden = workItems.length > 0;
}

function openDecisionDialog(work, invoker) {
  state.decisionRequest = { work, invoker };
  els.decisionDialogTitle.textContent =
    work.decision === "accepted" ? "Reopen this task" : "Request another pass";
  els.decisionDialogContext.textContent =
    work.decision === "accepted"
      ? "Tell the agent what changed since you accepted this work, or retry the original task unchanged."
      : "Tell the agent what still needs work, or retry the original task unchanged.";
  els.decisionReason.value = "";
  els.decisionSubmit.disabled = true;
  els.decisionDialog.showModal();
  requestAnimationFrame(() => els.decisionReason.focus());
}

function closeDecisionDialog() {
  if (els.decisionDialog.open) els.decisionDialog.close();
}

async function submitDecision(work, action, button, reason = null) {
  if (!state.snapshot) return false;
  const decisionId = crypto.randomUUID();
  const envelope = {
    protocol: COMMAND_PROTOCOL,
    commandId: crypto.randomUUID(),
    idempotencyKey: `decision.${action}:${decisionId}`,
    workspaceId: state.snapshot.workspace.workspaceId,
    actor: { kind: "human", id: "browser" },
    type: `decision.${action}`,
    payload: {
      decisionId,
      workId: work.workId,
      reason: action === "accept" ? null : reason,
    },
  };
  button.disabled = true;
  try {
    const res = await fetch("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === "accepted") {
      flash(
        action === "accept"
          ? "Accepted — this task is complete ✓"
          : "Reopened — another pass requested",
      );
      await refreshSnapshot();
      if (action === "accept" && work.result?.revisionId) {
        state.pendingReveal = null;
        state.selectedArtifactId = work.artifactId;
        const revisions = revisionsOf(work.artifactId);
        const head = revisions[revisions.length - 1];
        state.pinnedRevisionId =
          work.result.revisionId === head?.revisionId ? null : work.result.revisionId;
        render();
      }
      return true;
    } else {
      flash(`error: ${data.message ?? data.error ?? res.status}`, true);
    }
  } catch {
    flash("daemon unreachable", true);
  }
  button.disabled = false;
  return false;
}

function referenceKey(reference) {
  if (reference.kind === "comment") return `comment:${reference.intentId}`;
  if (reference.kind === "task") return `task:${reference.workId}`;
  if (reference.kind === "file") return `file:${reference.hash}`;
  if (reference.kind === "selection") {
    return `selection:${reference.artifactId}:${reference.revisionId}:${reference.semanticId ?? ""}:${reference.textQuote?.exact ?? ""}:${reference.boardAnchor?.elementId ?? ""}`;
  }
  return `${reference.kind}:${reference.artifactId}:${reference.revisionId ?? ""}`;
}

function referenceKindLabel(kind) {
  if (kind === "whiteboard") return "board";
  return kind;
}

function committedReferences(message) {
  if (Array.isArray(message.references) && message.references.length > 0) {
    return message.references;
  }
  return (message.mentions ?? []).map((artifactId) => ({
    kind:
      artifactKind(artifacts().find((artifact) => artifact.artifactId === artifactId)) ===
      "whiteboard"
        ? "whiteboard"
        : "document",
    label: artifactName(artifactId),
    artifactId,
  }));
}

function renderCommittedReferences(message) {
  const attachmentHashes = new Set(
    (message.attachments ?? []).map((attachment) => attachment.hash),
  );
  const references = committedReferences(message).filter(
    (reference) => reference.kind !== "file" || !attachmentHashes.has(reference.hash),
  );
  if (references.length === 0) return null;
  return el(
    "div",
    { class: "chat-message-references", "aria-label": "Attached context" },
    ...references.map((reference) =>
      el(
        "span",
        { class: `context-chip context-kind-${reference.kind}` },
        el("span", { class: "context-chip-kind" }, referenceKindLabel(reference.kind)),
        el("span", { class: "context-chip-label" }, reference.label ?? "Context"),
      ),
    ),
  );
}

function attachmentUrl(hash) {
  return `/api/v1/chat/attachments/${encodeURIComponent(hash)}`;
}

function renderCommittedAttachments(message) {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return null;
  return el(
    "div",
    { class: "chat-message-attachments", "aria-label": "Message attachments" },
    ...attachments.map((attachment) => {
      const href = attachmentUrl(attachment.hash);
      if (attachment.mediaType?.startsWith("image/")) {
        return el(
          "a",
          {
            class: "chat-image-card",
            href,
            download: attachment.fileName,
            title: `Download ${attachment.fileName}`,
          },
          el("img", { src: href, alt: attachment.fileName, loading: "lazy" }),
          el("span", {}, attachment.fileName),
        );
      }
      return el(
        "a",
        {
          class: "chat-file-card",
          href,
          download: attachment.fileName,
          title: `Download ${attachment.fileName}`,
        },
        el("span", { class: "chat-file-icon", "aria-hidden": "true" }, "↧"),
        el(
          "span",
          { class: "chat-file-copy" },
          el("strong", {}, attachment.fileName),
          el(
            "small",
            {},
            `${attachment.mediaType || "file"} · ${formatBytes(attachment.byteLength)}`,
          ),
        ),
      );
    }),
  );
}

function formatBytes(byteLength) {
  if (!Number.isFinite(byteLength)) return "unknown size";
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}

function chatContent(message) {
  if (message.content?.type) return message.content;
  return { type: "text", text: message.text ?? "" };
}

function questionAnswerAttemptSignature(messageId) {
  const attempt = state.questionAnswerAttempts.get(messageId);
  return attempt ? `${attempt.status}:${attempt.optionKey}` : "";
}

function reconcileQuestionAnswerAttempts() {
  for (const [questionId, attempt] of state.questionAnswerAttempts) {
    const question = questionByMessageId(questionId);
    const questionState = question?.questionState;
    const submittedPriorAnswerId =
      attempt.envelope.payload.content.supersedesAnswerMessageId ?? null;
    const projectedPriorAnswerId =
      questionState?.status === "answered" ? questionState.answerMessageId : null;
    if (
      !questionState ||
      questionState.answerMessageId === attempt.envelope.payload.messageId ||
      (attempt.status === "failed" && submittedPriorAnswerId !== projectedPriorAnswerId)
    ) {
      state.questionAnswerAttempts.delete(questionId);
    }
  }
}

function questionByMessageId(messageId) {
  return (state.snapshot?.chat ?? []).find((message) => message.messageId === messageId) ?? null;
}

function questionOptionLabel(questionMessage, optionKey) {
  const content = chatContent(questionMessage ?? {});
  if (content.type !== "choice-question") return optionKey;
  return content.options.find((option) => option.key === optionKey)?.label ?? optionKey;
}

function questionActionability(message) {
  const content = chatContent(message);
  const options =
    content.type === "choice-question" && Array.isArray(content.options) ? content.options : [];
  const optionKeys = options.map((option) => option.key);
  const optionLabels = options.map((option) => option.label);
  const validOptions =
    content.type === "choice-question" &&
    typeof content.prompt === "string" &&
    content.prompt.trim().length > 0 &&
    Array.isArray(content.options) &&
    options.length >= 2 &&
    options.length <= 8 &&
    options.every(
      (option) =>
        typeof option.key === "string" &&
        option.key.trim().length > 0 &&
        typeof option.label === "string" &&
        option.label.trim().length > 0,
    ) &&
    new Set(optionKeys).size === options.length &&
    new Set(optionLabels).size === options.length;
  if (!validOptions) return { actionable: false, reason: "This question is unavailable." };
  if (!String(message.author).startsWith("agent:")) {
    return { actionable: false, reason: "Only agent-authored questions can be answered here." };
  }
  if (!message.sessionId || message.sessionId !== state.sessionContext.sessionId) {
    return { actionable: false, reason: "This question belongs to another session." };
  }
  if (!["pending", "answered"].includes(message.questionState?.status)) {
    return { actionable: false, reason: "This question has no actionable state." };
  }
  return { actionable: true, reason: null };
}

function renderChoiceQuestion(message) {
  const content = chatContent(message);
  const questionOptions = Array.isArray(content.options) ? content.options : [];
  const questionState = message.questionState;
  const attempt = state.questionAnswerAttempts.get(message.messageId) ?? null;
  const actionability = questionActionability(message);
  const statusId = `question_status_${message.messageId}`;
  const answered = questionState?.status === "answered";
  const pendingLocally = attempt?.status === "submitting" || attempt?.status === "accepted";
  const canAnswer = actionability.actionable && !pendingLocally;
  let status = actionability.reason;
  if (attempt?.status === "submitting") status = "Saving your answer…";
  else if (attempt?.status === "accepted") {
    status = "Answer saved in this conversation. Waiting for refreshed question state.";
  } else if (attempt?.status === "failed") {
    status = "Answer was not saved. Retry the same option.";
  } else if (answered) {
    status = `Answered: ${questionState.optionLabel}. Choose another option to change it.`;
  } else if (actionability.actionable) status = "Pending — choose one option.";

  const options = el(
    "div",
    { class: "chat-question-options" },
    ...questionOptions.map((option) => {
      const selected = answered && questionState.optionKey === option.key;
      const retryingAnother = attempt?.status === "failed" && attempt.optionKey !== option.key;
      const disabled = !canAnswer || retryingAnother || selected;
      const button = el(
        "button",
        {
          type: "button",
          class: `chat-question-option${selected ? " is-selected" : ""}`,
          "data-testid": "question-option",
          "data-option-key": option.key,
          "aria-pressed": String(selected),
          ...(disabled ? { disabled: "" } : {}),
        },
        el("span", { class: "chat-question-option-key", "aria-hidden": "true" }, option.key),
        el("span", { class: "chat-question-option-label" }, option.label),
        selected
          ? el("span", { class: "chat-question-selected", "aria-hidden": "true" }, "✓")
          : null,
      );
      button.addEventListener("click", () => answerChoiceQuestion(message, option));
      return button;
    }),
  );
  return el(
    "fieldset",
    {
      class: `chat-question-card is-${answered ? "answered" : "pending"}`,
      "data-testid": "question-card",
      "data-question-id": message.messageId,
      "data-question-state": answered ? "answered" : "pending",
      "aria-describedby": statusId,
    },
    el(
      "legend",
      { class: "chat-question-prompt" },
      typeof content.prompt === "string" && content.prompt.trim()
        ? content.prompt
        : "Unavailable question",
    ),
    options,
    el(
      "p",
      {
        id: statusId,
        class: "chat-question-status",
        "data-testid": "question-status",
        tabindex: "-1",
        role: "status",
        "aria-live": "polite",
      },
      status,
    ),
  );
}

function renderChoiceAnswer(message) {
  const content = chatContent(message);
  const question = questionByMessageId(content.questionMessageId);
  const label = questionOptionLabel(question, content.optionKey);
  const superseded = message.answerState?.status === "superseded";
  if (superseded) {
    return el(
      "details",
      {
        class: "chat-choice-answer is-superseded",
        "data-testid": "choice-answer",
        "data-answer-state": "superseded",
      },
      el("summary", { class: "chat-choice-answer-label" }, `Previous answer: ${label}`),
      el("span", { class: "chat-choice-answer-state" }, "Superseded by a later answer"),
    );
  }
  return el(
    "div",
    {
      class: "chat-choice-answer",
      "data-testid": "choice-answer",
      "data-answer-state": "current",
    },
    el("span", { class: "chat-choice-answer-label" }, `Selected: ${label}`),
    el("span", { class: "chat-choice-answer-state" }, "Current answer"),
  );
}

function renderChatContent(message, human) {
  const content = chatContent(message);
  if (content.type === "choice-question") return renderChoiceQuestion(message);
  if (content.type === "choice-answer") return renderChoiceAnswer(message);
  if (!content.text) return null;
  return human ? el("p", { class: "body" }, content.text) : clampable(content.text, "body", 6);
}

async function answerChoiceQuestion(question, option) {
  if (!state.snapshot || !questionActionability(question).actionable) return false;
  const existing = state.questionAnswerAttempts.get(question.messageId);
  if (existing?.status === "submitting" || existing?.status === "accepted") return false;
  if (existing?.status === "failed" && existing.optionKey !== option.key) return false;

  const messageId = existing?.envelope.payload.messageId ?? `message_${crypto.randomUUID()}`;
  const envelope = existing?.envelope ?? {
    protocol: COMMAND_PROTOCOL,
    commandId: crypto.randomUUID(),
    idempotencyKey: `chat.answer:${question.messageId}:${messageId}`,
    workspaceId: state.snapshot.workspace.workspaceId,
    actor: { kind: "human", id: "browser" },
    type: "chat.send",
    payload: {
      messageId,
      sessionId: question.sessionId,
      content: {
        type: "choice-answer",
        questionMessageId: question.messageId,
        optionKey: option.key,
        supersedesAnswerMessageId:
          question.questionState.status === "answered"
            ? question.questionState.answerMessageId
            : null,
      },
    },
  };
  state.questionAnswerAttempts.set(question.messageId, {
    status: "submitting",
    optionKey: option.key,
    envelope,
  });
  renderChat();
  try {
    const response = await fetch("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const data = await response.json().catch(() => ({}));
    const accepted =
      response.ok &&
      data.status === "accepted" &&
      data.response?.messageId === envelope.payload.messageId;
    if (!accepted) {
      throw new Error(data.message ?? data.error ?? String(response.status));
    }
    state.questionAnswerAttempts.set(question.messageId, {
      status: "accepted",
      optionKey: option.key,
      envelope,
    });
    renderChat();
    flashAt(els.chatFlash, "Answer saved in this conversation.");
    await refreshSnapshot();
    return true;
  } catch (error) {
    state.questionAnswerAttempts.set(question.messageId, {
      status: "failed",
      optionKey: option.key,
      envelope,
    });
    const refreshed = await refreshSnapshot().then(
      () => true,
      () => false,
    );
    renderChat();
    flashAt(
      els.chatFlash,
      refreshed
        ? `Answer not saved: ${error?.message ?? "the request failed"}. The latest answer is shown; choose again if you still want to replace it.`
        : `Answer not saved: ${error?.message ?? "the daemon is unreachable"}. Reconnect to Tweakloop, then choose again.`,
      true,
    );
    return false;
  }
}

function chatStructureSignature(message) {
  const structure = { ...message };
  delete structure.delivery;
  return JSON.stringify({
    ...structure,
    shellQuestionAttempt: questionAnswerAttemptSignature(message.messageId),
  });
}

function chatDeliverySignature(message) {
  return isHumanAuthor(message.author) ? JSON.stringify(message.delivery) : "agent-reply";
}

function deliveryPauseReason(reason) {
  return reason === "retry-budget-exhausted"
    ? "Retry budget exhausted"
    : "Delivery needs attention";
}

function describeDelivery(slot, label, detail) {
  slot.setAttribute("aria-label", label);
  slot.setAttribute("aria-description", detail);
  slot.dataset.receiptDetail = detail;
  slot.title = detail;
  slot.tabIndex = 0;
}

function updateChatDelivery(slot, message) {
  const signature = chatDeliverySignature(message);
  if (slot.dataset.deliverySignature === signature) return;
  slot.dataset.deliverySignature = signature;
  slot.className = "chat-delivery";
  slot.removeAttribute("aria-label");
  slot.removeAttribute("aria-description");
  delete slot.dataset.receiptDetail;
  slot.removeAttribute("title");
  slot.removeAttribute("tabindex");
  if (!isHumanAuthor(message.author)) {
    slot.dataset.deliveryStatus = "agent-reply";
    slot.replaceChildren("Agent reply");
    return;
  }

  const delivery = message.delivery;
  if (delivery === null || delivery === undefined) {
    slot.dataset.deliveryStatus = "saved";
    slot.classList.add("is-saved");
    describeDelivery(
      slot,
      "Saved in Tweakloop",
      `Saved in Tweakloop at ${message.recordedAt || "an unavailable time"}`,
    );
    slot.replaceChildren("Saved");
    return;
  }
  if (delivery.status === "offered") {
    slot.dataset.deliveryStatus = "offered";
    slot.classList.add("is-offered");
    describeDelivery(
      slot,
      `Offered to agent runner, attempt ${delivery.attemptNumber}`,
      `Offered to agent runner at ${delivery.offeredAt || "an unavailable time"}; attempt ${delivery.attemptNumber}`,
    );
    slot.replaceChildren("Offered to agent runner");
    return;
  }
  if (delivery.status === "acknowledged") {
    const acknowledgedAgent = delivery.agentId
      ? resolveAgentProfile(delivery.agentId).label
      : "agent";
    slot.dataset.deliveryStatus = "acknowledged";
    slot.classList.add("is-acknowledged");
    describeDelivery(
      slot,
      `Acknowledged by ${acknowledgedAgent}`,
      `Acknowledged by ${acknowledgedAgent} at ${delivery.acknowledgedAt || "an unavailable time"}; attempt ${delivery.attemptNumber}`,
    );
    slot.replaceChildren(
      `Acknowledged by ${acknowledgedAgent}`,
      el("span", { class: "chat-delivery-checks", "aria-hidden": "true" }, "✓✓"),
    );
    return;
  }

  slot.dataset.deliveryStatus = "paused";
  slot.classList.add("is-paused");
  describeDelivery(
    slot,
    `Delivery paused after ${delivery.attemptNumber} attempts`,
    `${deliveryPauseReason(delivery.pauseReason)}. Delivery is paused and requires an explicit retry.`,
  );
  const retry = el(
    "button",
    {
      type: "button",
      class: "chat-delivery-retry",
      "data-testid": "chat-delivery-retry",
      "aria-label": `Retry delivery of your message: ${message.text || "message with context"}`,
    },
    "Retry",
  );
  retry.addEventListener("click", () => resumeChatDelivery(message, retry));
  slot.replaceChildren(
    el("span", { class: "chat-delivery-state" }, "Delivery paused after 5 attempts"),
    el("span", { class: "chat-delivery-cause" }, deliveryPauseReason(delivery.pauseReason)),
    retry,
  );
}

function renderChatMessage(message) {
  const human = isHumanAuthor(message.author);
  const profile = human ? null : resolveAgentProfile(message.author);
  const speaker = human ? "You" : profile.label;
  const content = chatContent(message);
  const motion = entityMotion(
    "chat",
    message.messageId,
    `${message.createdSeq}:${JSON.stringify(content)}`,
  );
  const timestamp = el(
    "time",
    { class: "chat-time", datetime: message.recordedAt, title: message.recordedAt },
    relativeTime(message.recordedAt),
  );
  const delivery = el("span", {
    class: "chat-delivery",
    "data-testid": "chat-delivery",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  });
  updateChatDelivery(delivery, message);
  const avatar = el("span", { class: "chat-avatar", "aria-hidden": "true" });
  if (human) avatar.append(svgIcon("human", "chat-avatar-icon"));
  else applyAgentMark(avatar, profile);
  const bubble = el(
    "div",
    { class: "chat-bubble" },
    el(
      "div",
      { class: "chat-message-head" },
      el("strong", { class: "chat-author", title: message.author }, speaker),
      timestamp,
    ),
    renderCommittedReferences(message),
    message.context ? el("p", { class: "chat-quote" }, targetLabel(message.context)) : null,
    renderCommittedAttachments(message),
    renderChatContent(message, human),
    el(
      "div",
      { class: "chat-message-foot" },
      human ? chatTaskAction(message) : null,
      delivery,
      message.sessionId
        ? el("span", { class: "chat-session", title: `Session ${message.sessionId}` }, "Session")
        : null,
    ),
  );
  const item = el(
    "li",
    {
      "data-testid": "chat-item",
      class: `chat-msg ${human ? "human" : "agent"}${motion}`,
      "aria-label": `${
        content.type === "choice-question"
          ? human
            ? "Your question"
            : `${speaker}'s question`
          : content.type === "choice-answer"
            ? "Your answer"
            : human
              ? "Your message"
              : `${speaker}'s reply`
      }, ${relativeTime(message.recordedAt)}`,
    },
    avatar,
    bubble,
  );
  item.dataset.messageId = message.messageId;
  item.dataset.structureSignature = chatStructureSignature(message);
  return item;
}

function reconcileChatMessages(messages) {
  const existingById = new Map(
    [...els.chatList.children].map((item) => [item.dataset.messageId, item]),
  );
  const retained = new Set();
  messages.forEach((message, index) => {
    const signature = chatStructureSignature(message);
    let item = existingById.get(message.messageId);
    if (!item || item.dataset.structureSignature !== signature) {
      const replacement = renderChatMessage(message);
      if (item) item.replaceWith(replacement);
      item = replacement;
    } else {
      updateChatDelivery(item.querySelector(".chat-delivery"), message);
    }
    const currentAtIndex = els.chatList.children[index];
    if (currentAtIndex !== item) els.chatList.insertBefore(item, currentAtIndex ?? null);
    retained.add(item);
  });
  for (const item of [...els.chatList.children]) {
    if (!retained.has(item)) item.remove();
  }
}

function renderChat() {
  const messages = chatMessages();
  const nearBottom =
    els.chatList.scrollHeight - els.chatList.scrollTop - els.chatList.clientHeight < 48;
  const focusedQuestion = document.activeElement?.closest?.("[data-question-id]");
  const focusedQuestionId = focusedQuestion?.dataset.questionId ?? null;
  const focusedOptionKey = document.activeElement?.dataset?.optionKey ?? null;
  reconcileChatMessages(messages);
  if (focusedQuestionId) {
    requestAnimationFrame(() => {
      const card = els.chatList.querySelector(
        `[data-question-id="${CSS.escape(focusedQuestionId)}"]`,
      );
      const option = focusedOptionKey
        ? card?.querySelector(`[data-option-key="${CSS.escape(focusedOptionKey)}"]`)
        : null;
      const target =
        option && !option.disabled ? option : card?.querySelector(".chat-question-status");
      target?.focus({ preventScroll: true });
    });
  }
  els.chatEmpty.hidden = messages.length > 0;
  if (nearBottom) els.chatList.scrollTop = els.chatList.scrollHeight;
  renderChatContext();
  renderChatMentions();
  renderPendingAttachments();
  renderPresence();
  updateChatSendAvailability();
}

async function resumeChatDelivery(message, button) {
  if (!state.snapshot || message.delivery?.status !== "paused") return false;
  const resumedAt = new Date().toISOString();
  const generation =
    message.delivery.attemptId ?? message.delivery.pausedAt ?? message.delivery.attemptNumber;
  const envelope = {
    protocol: COMMAND_PROTOCOL,
    commandId: crypto.randomUUID(),
    idempotencyKey: `chat.delivery-resume:${message.messageId}:${generation}`,
    workspaceId: state.snapshot.workspace.workspaceId,
    actor: { kind: "human", id: "browser" },
    type: "chat.delivery-resume",
    payload: { messageId: message.messageId, resumedAt },
  };
  button.disabled = true;
  button.textContent = "Retrying…";
  try {
    const response = await fetch("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.status !== "accepted") {
      throw new Error(data.message ?? data.error ?? String(response.status));
    }
    await refreshSnapshot();
    return true;
  } catch (error) {
    button.disabled = false;
    button.textContent = "Retry";
    flashAt(
      els.chatFlash,
      `Delivery retry failed: ${error?.message ?? "the daemon is unreachable"}`,
      true,
    );
    return false;
  }
}

function chatTaskAction(message) {
  if (message.workId || message.intentId) {
    const view = el(
      "button",
      {
        type: "button",
        class: "chat-task-action tracked",
        "data-testid": "chat-promote",
        title: "Open the task created from this message",
      },
      "✓ Tracked as task",
    );
    view.addEventListener("click", () => {
      state.activeTab = "work";
      localStorage.setItem(COLLABORATION_TAB_STORAGE, "work");
      renderTabs();
      els.workList.querySelector("button, [tabindex]")?.focus();
    });
    return view;
  }
  const promoting = state.promotingMessageIds.has(message.messageId);
  const unavailable = message.artifactId === null;
  const track = el(
    "button",
    {
      type: "button",
      class: "chat-task-action",
      "data-testid": "chat-promote",
      ...(promoting || unavailable ? { disabled: "" } : {}),
      title: unavailable
        ? "Attach this conversation to a document or board before creating a task"
        : "Create one comment and task from this exact message",
    },
    promoting ? "Adding task…" : "Track as task",
  );
  track.addEventListener("click", () => promoteChatMessage(message, track));
  return track;
}

function chatIntentTarget(message) {
  return {
    ...(message.context?.semanticId === undefined
      ? {}
      : { semanticId: message.context.semanticId }),
    ...(message.context?.domHint === undefined ? {} : { domHint: message.context.domHint }),
    ...(message.context?.textQuote === undefined ? {} : { textQuote: message.context.textQuote }),
    ...(message.context?.boardAnchor === undefined
      ? {}
      : { boardAnchor: message.context.boardAnchor }),
  };
}

async function promoteChatMessage(message, button) {
  if (!state.snapshot || !message.artifactId) return false;
  const head = revisionsOf(message.artifactId).at(-1);
  if (!head) {
    flashAt(els.chatFlash, "This document has no revision to attach the task to.", true);
    return false;
  }
  const contextualRevisionId =
    message.context?.revisionId ?? message.context?.boardAnchor?.baseRevisionId ?? null;
  if (contextualRevisionId && contextualRevisionId !== head.revisionId) {
    flashAt(
      els.chatFlash,
      "This message refers to an older revision. Send a fresh message from the current revision before tracking it.",
      true,
    );
    return false;
  }
  const batchId = `batch_${crypto.randomUUID()}`;
  const intentId = `intent_${crypto.randomUUID()}`;
  const workId = `work_${crypto.randomUUID()}`;
  const envelope = {
    protocol: COMMAND_PROTOCOL,
    commandId: crypto.randomUUID(),
    idempotencyKey: `chat.promote:${message.messageId}`,
    workspaceId: state.snapshot.workspace.workspaceId,
    actor: { kind: "human", id: "browser" },
    type: "review.submit-batch",
    payload: {
      batchId,
      workId,
      artifactId: message.artifactId,
      revisionId: head.revisionId,
      sourceMessageId: message.messageId,
      assigneeAgentId: message.recipientAgentId,
      sessionId: message.sessionId,
      intents: [
        {
          intentId,
          intentType: "comment",
          target: chatIntentTarget(message),
          body: { text: message.text, sourceMessageId: message.messageId },
        },
      ],
    },
  };
  state.promotingMessageIds.add(message.messageId);
  button.disabled = true;
  button.textContent = "Adding task…";
  try {
    const res = await fetch("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== "accepted") {
      flashAt(els.chatFlash, data.message ?? "The message could not be tracked as a task.", true);
      return false;
    }
    await refreshSnapshot();
    flashAt(els.chatFlash, "Task added. Open Tasks to follow the agent's progress.", false);
    return true;
  } catch {
    flashAt(els.chatFlash, "The daemon is unreachable. Nothing was added; try again.", true);
    return false;
  } finally {
    state.promotingMessageIds.delete(message.messageId);
    renderChat();
  }
}

function renderPresence() {
  const rows = [];
  for (const agent of state.presence) {
    if (agent.state === "listening") {
      rows.push(el("p", { class: "presence-line" }, `● ${agent.agentId} is available`));
    } else {
      rows.push(
        el(
          "p",
          { class: "presence-line active" },
          `✦ ${agent.agentId} is ${agent.state}`,
          el(
            "span",
            { class: "presence-dots" },
            el("span", {}, "."),
            el("span", {}, "."),
            el("span", {}, "."),
          ),
        ),
      );
    }
  }
  if (rows.length === 0) {
    if (state.presenceReconnecting) {
      rows.push(
        el(
          "p",
          { class: "presence-line", title: "Reconnecting to the live agent presence stream" },
          "Reconnecting to agent presence…",
        ),
      );
    }
    const all = state.snapshot?.chat ?? [];
    const newest = all[all.length - 1];
    if (!state.presenceReconnecting && newest && isHumanAuthor(newest.author)) {
      const offlineMessage =
        "Saved. No agent is connected; this conversation remains in the inbox.";
      rows.push(el("p", { class: "presence-line", title: offlineMessage }, offlineMessage));
    }
  }
  els.chatPresence.hidden = rows.length === 0;
  els.chatPresence.replaceChildren(...rows);
  renderAgentSummary();
  renderArtifacts();
  renderWork();
}

function startPresencePolling() {
  const markUnavailable = () => {
    state.presenceFailures += 1;
    state.presenceReconnecting = state.presenceFailures < 3;
    if (state.presenceFailures >= 3) {
      state.presence = [];
      state.presenceKey = "";
    }
    renderPresence();
  };
  const tick = async () => {
    try {
      const res = await fetch("/api/v1/presence");
      if (!res.ok) {
        markUnavailable();
        return;
      }
      const data = await res.json();
      const agents = data.agents ?? [];
      const key = JSON.stringify(agents);
      const recovered = state.presenceFailures > 0 || state.presenceReconnecting;
      state.presenceFailures = 0;
      state.presenceReconnecting = false;
      if (key !== state.presenceKey) {
        state.presenceKey = key;
        state.presence = agents;
        renderPresence();
      } else if (recovered) {
        renderPresence();
      }
    } catch {
      markUnavailable();
    }
  };
  tick();
  setInterval(tick, 2500);
}

function renderChatMentions() {
  els.chatMentions.hidden = state.chatReferences.length === 0;
  els.chatMentions.replaceChildren(
    ...state.chatReferences.map((reference) => {
      const remove = el(
        "button",
        {
          type: "button",
          class: "draft-remove",
          title: `Remove ${referenceKindLabel(reference.kind)} context`,
          "aria-label": `Remove ${referenceKindLabel(reference.kind)} ${reference.label}`,
        },
        "✕",
      );
      remove.addEventListener("click", () => {
        const key = referenceKey(reference);
        state.chatReferences = state.chatReferences.filter((item) => referenceKey(item) !== key);
        renderChatMentions();
      });
      return el(
        "span",
        { class: `context-chip context-kind-${reference.kind} mention-chip` },
        el("span", { class: "context-chip-kind" }, referenceKindLabel(reference.kind)),
        el("span", { class: "context-chip-label", title: reference.label }, reference.label),
        remove,
      );
    }),
  );
  updateChatSendAvailability();
}

function currentComments() {
  const selected = selectedArtifact()?.artifactId;
  return [...(state.snapshot?.intents ?? [])].sort(
    (left, right) => Number(right.artifactId === selected) - Number(left.artifactId === selected),
  );
}

function currentWorkItems() {
  const selected = selectedArtifact()?.artifactId;
  return [...(state.snapshot?.work ?? [])].sort(
    (left, right) => Number(right.artifactId === selected) - Number(left.artifactId === selected),
  );
}

function headRevisionId(artifactId) {
  const revisions = revisionsOf(artifactId);
  return revisions[revisions.length - 1]?.revisionId;
}

function commentReference(intent) {
  return {
    kind: "comment",
    label: targetLabel(intent.target) || "Comment",
    artifactId: intent.artifactId,
    revisionId: intent.revisionId,
    intentId: intent.intentId,
  };
}

function taskReference(work) {
  const intentById = new Map(
    (state.snapshot?.intents ?? []).map((intent) => [intent.intentId, intent]),
  );
  const firstIntent = intentById.get(work.intentIds?.[0]);
  return {
    kind: "task",
    label: firstIntent
      ? targetLabel(firstIntent.target) || bodyText(firstIntent.body)
      : "Agent task",
    artifactId: work.artifactId,
    workId: work.workId,
  };
}

function selectionReference() {
  if (!state.chatContext) return null;
  const artifact = selectedArtifact();
  if (!artifact) return null;
  const context = state.chatContext;
  return {
    kind: "selection",
    label: targetLabel(context) || "Current selection",
    artifactId: context.boardAnchor?.whiteboardArtifactId ?? artifact.artifactId,
    revisionId: context.revisionId,
    ...(context.textQuote ? { textQuote: context.textQuote } : {}),
    ...(context.semanticId ? { semanticId: context.semanticId } : {}),
    ...(context.boardAnchor ? { boardAnchor: context.boardAnchor } : {}),
  };
}

function addChatReference(reference) {
  if (!reference) return;
  const key = referenceKey(reference);
  if (!state.chatReferences.some((item) => referenceKey(item) === key)) {
    state.chatReferences.push(reference);
  }
  renderChatMentions();
}

function updateChatSendAvailability() {
  const blockedAttachment = state.pendingAttachments.some(
    (attachment) => attachment.status !== "ready",
  );
  const hasPayload =
    els.chatInput.value.trim().length > 0 ||
    state.chatReferences.length > 0 ||
    Boolean(state.chatContext) ||
    state.pendingAttachments.some((attachment) => attachment.status === "ready");
  els.chatSend.disabled = state.chatSending || blockedAttachment || !hasPayload;
  els.chatComposerHint.dataset.compact = String(!hasPayload || blockedAttachment);
  els.chatSendRequirement.textContent = state.chatSending
    ? "Sending message"
    : blockedAttachment
      ? "Resolve attachment uploads before sending"
      : hasPayload
        ? "Enter to send"
        : "Write a message or add context to enable Send.";
  els.chatSend.title = state.chatSending
    ? "Sending message"
    : blockedAttachment
      ? "Wait for uploads or remove failed attachments"
      : hasPayload
        ? "Send message"
        : "Write a message or add context before sending";
}

function resizeChatInput() {
  els.chatInput.style.height = "";
  if (!els.chatInput.value) return;
  els.chatInput.style.height = "auto";
  els.chatInput.style.height = `${Math.min(els.chatInput.scrollHeight, 112)}px`;
}

function queueAttachments(files) {
  for (const original of files) {
    const file =
      original.name || !original.type.startsWith("image/")
        ? original
        : new File([original], `pasted-image-${Date.now()}.png`, { type: original.type });
    const record = {
      localId: crypto.randomUUID(),
      file,
      fileName: file.name,
      mediaType: file.type || "application/octet-stream",
      byteLength: file.size,
      status: file.size > 25 * 1024 * 1024 ? "error" : "uploading",
      progress: 0,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      descriptor: null,
      error: file.size > 25 * 1024 * 1024 ? "File exceeds the 25 MB attachment limit" : null,
      xhr: null,
    };
    state.pendingAttachments.push(record);
    if (record.status === "uploading") uploadAttachment(record);
  }
  renderPendingAttachments();
}

function uploadAttachment(record) {
  record.xhr?.abort();
  record.status = "uploading";
  record.progress = 0;
  record.error = null;
  record.descriptor = null;
  const request = new XMLHttpRequest();
  record.xhr = request;
  request.open("POST", "/api/v1/chat/attachments");
  request.setRequestHeader("Content-Type", record.mediaType);
  request.setRequestHeader("X-Tweakloop-Filename", encodeURIComponent(record.fileName));
  request.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    record.progress = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
    renderPendingAttachments();
  });
  request.addEventListener("load", () => {
    let body = {};
    try {
      body = JSON.parse(request.responseText || "{}");
    } catch {
      body = {};
    }
    const descriptor = body.attachment ?? body;
    if (
      request.status >= 200 &&
      request.status < 300 &&
      typeof descriptor.hash === "string" &&
      typeof descriptor.fileName === "string" &&
      typeof descriptor.mediaType === "string" &&
      Number.isFinite(descriptor.byteLength)
    ) {
      record.status = "ready";
      record.progress = 100;
      record.descriptor = {
        hash: descriptor.hash,
        fileName: descriptor.fileName,
        mediaType: descriptor.mediaType,
        byteLength: descriptor.byteLength,
      };
      record.error = null;
    } else {
      record.status = "error";
      record.error = body.message ?? body.error ?? `Upload failed (${request.status})`;
    }
    record.xhr = null;
    renderPendingAttachments();
  });
  request.addEventListener("error", () => {
    record.status = "error";
    record.error = "Upload failed — check the daemon connection";
    record.xhr = null;
    renderPendingAttachments();
  });
  request.addEventListener("abort", () => {
    record.xhr = null;
  });
  request.send(record.file);
  renderPendingAttachments();
}

function removePendingAttachment(localId) {
  const record = state.pendingAttachments.find((attachment) => attachment.localId === localId);
  if (!record) return;
  record.xhr?.abort();
  if (record.previewUrl) URL.revokeObjectURL(record.previewUrl);
  state.pendingAttachments = state.pendingAttachments.filter(
    (attachment) => attachment.localId !== localId,
  );
  renderPendingAttachments();
}

function clearPendingAttachments() {
  for (const record of state.pendingAttachments) {
    record.xhr?.abort();
    if (record.previewUrl) URL.revokeObjectURL(record.previewUrl);
  }
  state.pendingAttachments = [];
  renderPendingAttachments();
}

function renderPendingAttachments() {
  els.chatAttachments.hidden = state.pendingAttachments.length === 0;
  els.chatAttachments.replaceChildren(
    ...state.pendingAttachments.map((attachment) => {
      const remove = el(
        "button",
        {
          type: "button",
          class: "attachment-remove",
          title: `Remove ${attachment.fileName}`,
          "aria-label": `Remove attachment ${attachment.fileName}`,
        },
        "×",
      );
      remove.addEventListener("click", () => removePendingAttachment(attachment.localId));
      const preview = attachment.previewUrl
        ? el("img", { class: "pending-attachment-preview", src: attachment.previewUrl, alt: "" })
        : el("span", { class: "pending-file-icon", "aria-hidden": "true" }, "↥");
      const status =
        attachment.status === "ready"
          ? `${formatBytes(attachment.byteLength)} · ready`
          : attachment.status === "error"
            ? attachment.error
            : `Uploading ${attachment.progress}%`;
      const actions = [remove];
      if (attachment.status === "error" && attachment.byteLength <= 25 * 1024 * 1024) {
        const retry = el(
          "button",
          {
            type: "button",
            class: "attachment-retry",
            "aria-label": `Retry ${attachment.fileName}`,
          },
          "Retry",
        );
        retry.addEventListener("click", () => uploadAttachment(attachment));
        actions.unshift(retry);
      }
      const card = el(
        "article",
        {
          class: `pending-attachment attachment-${attachment.status}`,
          "data-testid": "pending-attachment",
        },
        preview,
        el(
          "span",
          { class: "pending-attachment-copy" },
          el("strong", { title: attachment.fileName }, attachment.fileName),
          el("small", {}, status),
        ),
        el("span", { class: "pending-attachment-actions" }, ...actions),
      );
      if (attachment.status === "uploading") {
        const fill = el("span", { class: "attachment-progress-fill" });
        fill.style.width = `${attachment.progress}%`;
        card.append(el("span", { class: "attachment-progress", "aria-hidden": "true" }, fill));
      }
      return card;
    }),
  );
  updateChatSendAvailability();
}

// ---- @-mention popover ------------------------------------------------------

function mentionSession() {
  const caret = els.chatInput.selectionStart ?? els.chatInput.value.length;
  const before = els.chatInput.value.slice(0, caret);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return { query: match[1], start: caret - match[1].length - 1, caret };
}

function updateMentionPopover() {
  const session = mentionSession();
  if (!session) {
    closeMentionPopover();
    return;
  }
  const query = session.query.toLowerCase();
  const palette = contextPaletteOptions();
  const category = {
    task: "Tasks",
    tasks: "Tasks",
    comment: "Comments",
    comments: "Comments",
    document: "Documents",
    documents: "Documents",
    doc: "Documents",
    whiteboard: "Whiteboards",
    whiteboards: "Whiteboards",
    board: "Whiteboards",
    boards: "Whiteboards",
    selection: "Current selection",
  };
  const scoped = query.match(/^([a-z]+)(?::(.*))?$/);
  const scopedGroup = scoped ? category[scoped[1]] : null;
  const search = scopedGroup ? (scoped[2] ?? "") : query;
  const options = palette.filter(
    (option) =>
      (!scopedGroup || option.group === scopedGroup) &&
      `${option.group} ${option.label} ${option.meta ?? ""}`.toLowerCase().includes(search),
  );
  if (options.length === 0) {
    closeMentionPopover();
    return;
  }
  state.mention = {
    session,
    options,
    index: Math.min(state.mention?.index ?? 0, options.length - 1),
  };
  renderMentionPopover();
}

function contextPaletteOptions() {
  const options = [];
  const selection = selectionReference();
  if (selection) {
    options.push({
      group: "Current selection",
      label: selection.label,
      meta: selection.boardAnchor ? "board selection" : "text selection",
      reference: selection,
    });
  }

  const comments = currentComments().map(commentReference);
  if (comments.length > 0) {
    options.push({
      group: "Comments",
      label: `All workspace comments (${comments.length})`,
      meta: "add separate typed references",
      references: comments,
      multi: true,
    });
    options.push(
      ...comments.map((reference) => ({
        group: "Comments",
        label: `${reference.label} · ${artifacts().find((item) => item.artifactId === reference.artifactId)?.name ?? "document"}`,
        meta: "Comment · @comment",
        reference,
        multi: true,
      })),
    );
  }

  options.push(
    ...currentWorkItems().map((work) => {
      const reference = taskReference(work);
      const documentName =
        artifacts().find((item) => item.artifactId === work.artifactId)?.name ?? "document";
      return {
        group: "Tasks",
        label: `${reference.label} · ${documentName}`,
        meta: `Task · ${work.status === "claimed" ? "being worked" : work.status} · @task`,
        reference,
      };
    }),
  );

  const whiteboards = [];
  for (const artifact of artifacts()) {
    const kind = artifactKind(artifact);
    const revisionId = headRevisionId(artifact.artifactId);
    if (kind === "whiteboard") {
      whiteboards.push({
        kind: "whiteboard",
        label: artifact.name,
        artifactId: artifact.artifactId,
        ...(revisionId ? { revisionId } : {}),
      });
      continue;
    }
    options.push({
      group: "Documents",
      label: artifact.name,
      meta: artifactKindLabel(kind),
      reference: {
        kind: "document",
        label: artifact.name,
        artifactId: artifact.artifactId,
        ...(revisionId ? { revisionId } : {}),
      },
    });
  }
  if (whiteboards.length > 1) {
    options.push({
      group: "Whiteboards",
      label: `All whiteboards (${whiteboards.length})`,
      meta: "add each board",
      references: whiteboards,
      multi: true,
    });
  }
  options.push(
    ...whiteboards.map((reference) => ({
      group: "Whiteboards",
      label: reference.label,
      meta: "@whiteboard",
      reference,
      multi: true,
    })),
  );
  return options;
}

function paletteOptionSelected(option) {
  const references = option.references ?? (option.reference ? [option.reference] : []);
  return (
    references.length > 0 &&
    references.every((reference) =>
      reference.kind === "selection"
        ? Boolean(state.chatContext)
        : state.chatReferences.some((item) => referenceKey(item) === referenceKey(reference)),
    )
  );
}

function renderMentionPopover() {
  const mention = state.mention;
  if (!mention) return;
  els.chatMentionList.hidden = false;
  els.chatInput.setAttribute("aria-expanded", "true");
  const rows = [
    el(
      "div",
      { class: "mention-help", role: "presentation" },
      el("span", {}, "↑↓ choose"),
      el("span", {}, "Enter to attach"),
      el("span", {}, "Tab moves on · Esc closes"),
    ),
  ];
  let previousGroup = null;
  for (const [index, option] of mention.options.entries()) {
    if (option.group !== previousGroup) {
      rows.push(el("div", { class: "mention-group", role: "presentation" }, option.group));
      previousGroup = option.group;
    }
    const optionId = `chat-context-option-${index}`;
    const selected = paletteOptionSelected(option);
    const item = el(
      "div",
      {
        id: optionId,
        role: "option",
        "aria-selected": String(selected),
        "data-testid":
          option.reference?.kind === "task" ? "chat-mention-task" : "chat-mention-item",
        "data-active": String(index === mention.index),
        class: `mention-item ${index === mention.index ? "active" : ""}`,
        title: `${option.group}: ${option.label}. Press Enter to attach this context.`,
        "aria-label": `${option.group}: ${option.label}. ${option.meta ?? ""}. Press Enter to attach.`,
      },
      el(
        "span",
        { class: "mention-item-copy" },
        el("strong", {}, option.label),
        el("small", {}, option.meta ?? option.group),
      ),
      selected
        ? el("span", { class: "mention-check", "aria-hidden": "true" }, "✓")
        : index === mention.index
          ? el(
              "span",
              { class: "mention-key", "aria-hidden": "true" },
              el("kbd", {}, "↵"),
              " attach",
            )
          : null,
    );
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      acceptMention(option);
    });
    rows.push(item);
  }
  els.chatMentionList.replaceChildren(...rows);
  els.chatInput.setAttribute("aria-activedescendant", `chat-context-option-${mention.index}`);
}

function acceptMention(option) {
  const session = state.mention?.session;
  if (!option || !session) return;
  const value = els.chatInput.value;
  els.chatInput.value = `${value.slice(0, session.start)}${value.slice(session.caret)}`;
  els.chatInput.setSelectionRange(session.start, session.start);
  const references = option.references ?? (option.reference ? [option.reference] : []);
  for (const reference of references) {
    if (reference.kind !== "selection") addChatReference(reference);
  }
  if (option.multi) {
    state.mention.session = { query: "", start: session.start, caret: session.start };
    renderMentionPopover();
  } else {
    closeMentionPopover();
  }
  renderChatMentions();
  els.chatInput.focus();
}

function moveMention(delta) {
  const mention = state.mention;
  if (!mention) return;
  mention.index = (mention.index + delta + mention.options.length) % mention.options.length;
  renderMentionPopover();
  els.chatMentionList.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
}

function closeMentionPopover() {
  state.mention = null;
  els.chatMentionList.hidden = true;
  els.chatInput.setAttribute("aria-expanded", "false");
  els.chatInput.removeAttribute("aria-activedescendant");
}

function renderChatContext() {
  const context = state.chatContext;
  els.chatContext.hidden = !context;
  if (!context) {
    els.chatContext.replaceChildren();
    updateChatSendAvailability();
    return;
  }
  const clear = el(
    "button",
    {
      type: "button",
      class: "draft-remove",
      title: "Remove selection context",
      "aria-label": "Remove selection context",
    },
    "✕",
  );
  clear.addEventListener("click", () => {
    state.chatContext = null;
    renderChatContext();
  });
  els.chatContext.replaceChildren(
    el("span", { class: "context-chip-kind" }, "selection"),
    el("span", { class: "context-chip-label" }, targetLabel(context)),
    clear,
  );
  updateChatSendAvailability();
}

function renderTimeline() {
  const entries = [...(state.snapshot?.timeline ?? [])].sort((a, b) => b.seq - a.seq);
  els.timeline.replaceChildren(
    ...entries.map((entry) => {
      const category = timelineCategory(entry.eventType);
      return el(
        "li",
        { class: "timeline-row" },
        el(
          "div",
          { class: "row" },
          el("span", { class: `chip chip-${category}` }, category),
          el("span", { class: "meta", title: entry.recordedAt }, relativeTime(entry.recordedAt)),
          el("span", { class: "meta" }, `#${entry.seq}`),
        ),
        clampable(entry.summary ?? entry.eventType, "timeline-summary"),
      );
    }),
  );
  els.timelineEmpty.hidden = entries.length > 0;
}

// ---- bridge -----------------------------------------------------------------

function connectBridge() {
  const frameWindow = els.viewerFrame.contentWindow;
  const origin = state.snapshot?.workspace?.artifactOrigin;
  if (!frameWindow || !origin) return;
  const channel = new MessageChannel();
  channel.port1.onmessage = (message) => handleBridgeMessage(message.data);
  state.bridgePort = channel.port1;
  frameWindow.postMessage({ protocol: BRIDGE_PROTOCOL, type: "connect" }, origin, [channel.port2]);
}

function handleBridgeMessage(data) {
  if (!data || data.protocol !== BRIDGE_PROTOCOL) return;
  if (data.type === "ready") {
    if (!completeViewerNavigation(data.revisionId)) return;
    state.outlineLoading = false;
    state.nodes = data.payload?.nodes ?? [];
    state.currentWhiteboards = data.payload?.whiteboards ?? [];
    sendWhiteboardLoads(state.currentWhiteboards);
    sendMode();
    renderViewer();
    renderOutline();
    if (state.focusViewerOnReady) {
      state.focusViewerOnReady = false;
      requestAnimationFrame(() => els.viewerFrame.focus());
    }
    const pendingReveal = state.pendingReveal;
    if (
      pendingReveal?.artifactId === state.committedView?.artifactId &&
      pendingReveal.revisionId === state.committedView.revisionId
    ) {
      state.pendingReveal = null;
      requestAnimationFrame(() => revealTarget(pendingReveal.target));
    }
    return;
  }
  if (data.revisionId !== state.committedView?.revisionId || state.viewerNavigation) return;
  if (data.type === "nodes-updated") {
    state.nodes = data.payload?.nodes ?? [];
    state.currentWhiteboards = data.payload?.whiteboards ?? [];
    sendWhiteboardLoads(state.currentWhiteboards);
    render();
    return;
  }
  if (data.type === "target-revealed") {
    flashAt(
      els.viewerFlash,
      `Located ${data.payload?.semanticId ?? "the requested target"} in the artifact.`,
    );
    return;
  }
  if (data.type === "whiteboard-load-error" || data.type === "whiteboard-error") {
    flash(`whiteboard: ${data.payload?.error ?? "could not load"}`, true);
    return;
  }
  if (data.type === "whiteboard-object-applied") {
    confirmWhiteboardObjectApplied(data.payload ?? {});
    return;
  }
  if (data.type === "whiteboard-loaded") {
    const artifactId = data.payload?.boardAnchor?.whiteboardArtifactId;
    const record = state.whiteboardDrafts.get(artifactId);
    if (record && !record.pendingOperation) record.initialized = true;
    return;
  }
  if (data.type === "whiteboard-object-error") {
    rejectWhiteboardObjectApplied(data.payload ?? {});
    return;
  }
  if (data.type === "whiteboard-change") {
    queueWhiteboardChange(data.payload ?? {});
    return;
  }
  if (data.type === "target-selected") {
    const payload = data.payload ?? {};
    setChatContext(payload);
    openDraftForm(payload);
    return;
  }
  if (data.type === "selection-comment") {
    handleSelectionComment(data.payload ?? {});
  }
}

function sendWhiteboardLoads(whiteboards) {
  const origin = state.snapshot?.workspace?.artifactOrigin;
  if (!origin) return;
  for (const board of whiteboards) {
    if (!board.artifactId || !board.revisionId) continue;
    const key = `${board.status}:${board.semanticId}:${board.artifactId}:${board.revisionId}`;
    if (state.whiteboardLoads.has(key)) continue;
    const revision = (state.snapshot?.revisions ?? []).find(
      (candidate) =>
        candidate.revisionId === board.revisionId &&
        candidate.artifactId === board.artifactId &&
        candidate.format === "whiteboard",
    );
    if (!revision || !/^[0-9a-f]{64}$/.test(revision.entryHash)) {
      flash(`whiteboard reference ${board.semanticId} is missing its pinned revision`, true);
      continue;
    }
    state.whiteboardLoads.add(key);
    initializeWhiteboard(board, revision, origin, board.status === "waiting").catch(() => {
      flash(`whiteboard ${board.semanticId} could not load`, true);
    });
  }
}

async function initializeWhiteboard(board, revision, origin, loadReference) {
  const initializationKey = `${board.artifactId}:${board.revisionId}`;
  const existingInitialization = state.whiteboardInitializations.get(initializationKey);
  if (existingInitialization) return existingInitialization;

  const initialization = (async () => {
    let draft = null;
    const response = await fetch(
      `/api/v1/whiteboards/${encodeURIComponent(board.artifactId)}/draft`,
    );
    if (response.ok) {
      const candidate = await response.json();
      if (candidate.baseRevisionId === board.revisionId) draft = candidate;
    } else if (response.status !== 404) {
      throw new Error(`whiteboard draft lookup failed (${response.status})`);
    }

    const previous = state.whiteboardDrafts.get(board.artifactId);
    let record = previous;
    if (!record || record.baseRevisionId !== board.revisionId) {
      if (previous) clearTimeout(previous.timer);
      const previousStream = state.whiteboardStreams.get(board.artifactId);
      previousStream?.close();
      state.whiteboardStreams.delete(board.artifactId);
      const retained = loadWhiteboardPendingOperation(board.artifactId);
      const retainedForRevision =
        retained.operation?.baseRevisionId === board.revisionId ? retained.operation : null;
      record = {
        artifactId: board.artifactId,
        semanticId: board.semanticId,
        baseRevisionId: board.revisionId,
        draftId: retainedForRevision?.draftId ?? draft?.draftId ?? `draft_${crypto.randomUUID()}`,
        version: draft?.draftVersion ?? 0,
        sceneHash: draft?.sceneHash ?? revision.entryHash,
        pendingOperation: retainedForRevision,
        pendingScene: null,
        deferredRemoteUpdate: null,
        initialized: false,
        inFlight: false,
        timer: null,
        conflict: null,
        pendingApplyId: null,
        applyError:
          retained.error ??
          (retained.operation && !retainedForRevision
            ? "A queued edit belongs to another whiteboard revision. Saving is paused until that edit is recovered."
            : null),
      };
      state.whiteboardDrafts.set(board.artifactId, record);
      subscribeWhiteboardDraft(record);
    }

    if (loadReference) {
      state.bridgePort?.postMessage({
        protocol: BRIDGE_PROTOCOL,
        type: "whiteboard.load",
        payload: {
          requestId: crypto.randomUUID(),
          whiteboardArtifactId: board.artifactId,
          baseRevisionId: board.revisionId,
          sceneHash: record.sceneHash,
          sceneUrl: `${origin}/objects/sha256/${record.sceneHash}`,
          ...(draft ? { draftId: record.draftId, draftVersion: record.version } : {}),
          mode: draft ? "live-draft" : "pinned",
        },
      });
    } else if (draft) {
      applyWhiteboardObject(record, "Live whiteboard draft restored ✓");
    } else {
      record.initialized = true;
    }

    if (record.applyError) {
      flashAt(els.viewerFlash, record.applyError, true);
    } else if (record.pendingOperation) {
      clearTimeout(record.timer);
      record.timer = setTimeout(() => flushWhiteboardDraft(record), 0);
      flashAt(els.viewerFlash, "Recovering the exact queued whiteboard edit…");
    }

    renderViewer();
    return record;
  })();

  state.whiteboardInitializations.set(initializationKey, initialization);
  try {
    return await initialization;
  } finally {
    state.whiteboardInitializations.delete(initializationKey);
  }
}

function queueWhiteboardChange(payload) {
  const boardAnchor = payload.boardAnchor;
  const scene = payload.scene;
  const artifactId = boardAnchor?.whiteboardArtifactId;
  if (!artifactId || !scene) {
    flashAt(
      els.viewerFlash,
      "Legacy board imported — publish it as a whiteboard document to save live edits.",
      true,
    );
    return;
  }
  const record = state.whiteboardDrafts.get(artifactId);
  if (!record) {
    const board = state.currentWhiteboards.find((candidate) => candidate.artifactId === artifactId);
    const revision = (state.snapshot?.revisions ?? []).find(
      (candidate) =>
        candidate.revisionId === board?.revisionId && candidate.artifactId === artifactId,
    );
    const origin = state.snapshot?.workspace?.artifactOrigin;
    if (!board || !revision || !origin) {
      flashAt(els.viewerFlash, "Whiteboard live sync is unavailable for this revision.", true);
      return;
    }
    flashAt(
      els.viewerFlash,
      "Preparing whiteboard live sync — wait for the latest draft, then repeat this edit.",
      true,
    );
    initializeWhiteboard(board, revision, origin, board.status === "waiting").catch(() => {
      flashAt(
        els.viewerFlash,
        "Whiteboard live sync could not start — this edit was not submitted.",
        true,
      );
    });
    return;
  }
  if (!record.initialized) {
    flashAt(
      els.viewerFlash,
      "Loading the latest whiteboard draft — wait for it to finish, then repeat this edit.",
      true,
    );
    return;
  }
  record.applyError = null;
  record.pendingScene = scene;
  clearTimeout(record.timer);
  record.timer = setTimeout(() => flushWhiteboardDraft(record), 350);
  flashAt(els.viewerFlash, "Saving whiteboard…");
}

async function flushWhiteboardDraft(record) {
  if (record.inFlight) return;
  if (!record.pendingOperation) {
    if (!record.pendingScene || record.conflict) return;
    try {
      record.pendingOperation = retainWhiteboardOperation(
        record,
        record.pendingScene,
        record.version,
      );
      record.pendingScene = null;
    } catch (error) {
      record.applyError =
        error instanceof Error ? error.message : "whiteboard retry custody is unavailable";
      flashAt(
        els.viewerFlash,
        `Whiteboard save paused: ${record.applyError}. Your edit remains on this canvas.`,
        true,
      );
      return;
    }
  }
  const operation = record.pendingOperation;
  const scene = JSON.parse(operation.body);
  record.inFlight = true;
  try {
    const response = await putWhiteboardOperation(operation);
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.status === "accepted") {
      const needsRecoveredApply = !record.initialized;
      releaseWhiteboardOperation(operation);
      record.pendingOperation = null;
      if (result.draftVersion >= record.version) {
        record.version = result.draftVersion;
        record.sceneHash = result.sceneHash;
        record.draftId = result.draftId;
      }
      if (operation.conflictId) record.conflict = null;
      record.applyError = null;
      const successMessage = operation.conflictId
        ? "Conflict resolved — your whiteboard is saved ✓"
        : "Whiteboard saved ✓";
      if (needsRecoveredApply) applyWhiteboardObject(record, successMessage);
      else flashAt(els.viewerFlash, successMessage);
    } else if (response.status === 409 && result.status === "conflict") {
      releaseWhiteboardOperation(operation);
      record.pendingOperation = null;
      record.conflict = { receipt: result, scene };
      showWhiteboardConflict(record);
    } else {
      record.applyError = result.error ?? `HTTP ${response.status}`;
      flashAt(
        els.viewerFlash,
        `Whiteboard save outcome is unresolved: ${record.applyError}. The exact request is retained for retry.`,
        true,
      );
    }
  } catch {
    if (record.deferredRemoteUpdate) {
      flashAt(els.viewerFlash, "A remote whiteboard update arrived — reconciling…");
    } else {
      flashAt(
        els.viewerFlash,
        "Whiteboard is offline — the exact edit and operation identity are retained for retry.",
        true,
      );
    }
  } finally {
    record.inFlight = false;
    const caughtUp = applyDeferredWhiteboardUpdate(record);
    if (!caughtUp && (record.pendingOperation || (record.pendingScene && !record.conflict))) {
      record.timer = setTimeout(() => flushWhiteboardDraft(record), 350);
    }
  }
}

function putWhiteboardOperation(operation) {
  const suffix = operation.conflictId
    ? `/conflicts/${encodeURIComponent(operation.conflictId)}/resolve`
    : "/draft";
  return fetch(`/api/v1/whiteboards/${encodeURIComponent(operation.artifactId)}${suffix}`, {
    method: operation.conflictId ? "POST" : "PUT",
    headers: {
      "content-type": "application/vnd.excalidraw+json",
      "x-tweakloop-draft-id": operation.draftId,
      "x-tweakloop-base-revision": operation.baseRevisionId,
      "x-tweakloop-expected-version": String(operation.expectedVersion),
      "x-tweakloop-client-id": operation.clientId,
      "x-tweakloop-client-sequence": String(operation.clientSequence),
    },
    body: operation.body,
  });
}

function whiteboardRemoteUpdateMessage(update) {
  if (update.updatedBy?.kind === "agent") return "Whiteboard updated by the agent ✓";
  if (update.updatedBy?.kind === "human") return "Whiteboard updated in another browser ✓";
  return "Whiteboard updated remotely ✓";
}

function applyDeferredWhiteboardUpdate(record) {
  const update = record.deferredRemoteUpdate;
  if (
    !update ||
    update.draftVersion <= record.version ||
    record.inFlight ||
    record.pendingOperation ||
    record.pendingScene ||
    record.conflict
  ) {
    return false;
  }
  record.deferredRemoteUpdate = null;
  record.version = update.draftVersion;
  record.draftId = update.draftId;
  record.sceneHash = update.sceneHash;
  applyWhiteboardObject(record, whiteboardRemoteUpdateMessage(update));
  return true;
}

function subscribeWhiteboardDraft(record) {
  if (state.whiteboardStreams.has(record.artifactId)) return;
  const stream = new EventSource(
    `/api/v1/whiteboards/${encodeURIComponent(record.artifactId)}/draft-events?after=${record.version}`,
  );
  stream.addEventListener("whiteboard-draft", (event) => {
    const update = JSON.parse(event.data);
    if (update.draftVersion <= record.version) return;
    if (record.inFlight || record.pendingOperation || record.pendingScene || record.conflict) {
      if (
        !record.deferredRemoteUpdate ||
        update.draftVersion > record.deferredRemoteUpdate.draftVersion
      ) {
        record.deferredRemoteUpdate = update;
      }
      flashAt(els.viewerFlash, "A remote whiteboard update arrived — reconciling…");
      return;
    }
    record.version = update.draftVersion;
    record.draftId = update.draftId;
    record.sceneHash = update.sceneHash;
    applyWhiteboardObject(record, whiteboardRemoteUpdateMessage(update));
  });
  stream.addEventListener("error", () => {
    flashAt(els.viewerFlash, "Whiteboard live sync is reconnecting…", true);
  });
  state.whiteboardStreams.set(record.artifactId, stream);
}

function applyWhiteboardObject(record, successMessage = "Whiteboard update applied ✓") {
  const origin = state.snapshot?.workspace?.artifactOrigin;
  if (!origin || !state.bridgePort) {
    showWhiteboardApplyRecovery(
      record,
      "Whiteboard update is waiting for the canvas to reconnect.",
      successMessage,
    );
    return null;
  }

  if (record.pendingApplyId) {
    const previous = state.whiteboardPendingApplies.get(record.pendingApplyId);
    if (previous) clearTimeout(previous.timer);
    state.whiteboardPendingApplies.delete(record.pendingApplyId);
  }

  const requestId = crypto.randomUUID();
  const expected = {
    requestId,
    artifactId: record.artifactId,
    baseRevisionId: record.baseRevisionId,
    sceneHash: record.sceneHash,
    draftId: record.draftId,
    draftVersion: record.version,
    successMessage,
    timer: null,
  };
  expected.timer = setTimeout(() => {
    const pending = state.whiteboardPendingApplies.get(requestId);
    if (pending !== expected) return;
    state.whiteboardPendingApplies.delete(requestId);
    if (record.pendingApplyId === requestId) record.pendingApplyId = null;
    showWhiteboardApplyRecovery(
      record,
      "Whiteboard update could not be confirmed — the canvas may be stale.",
      successMessage,
    );
  }, 10_000);
  state.whiteboardPendingApplies.set(requestId, expected);
  record.pendingApplyId = requestId;
  record.applyError = null;

  state.bridgePort?.postMessage({
    protocol: BRIDGE_PROTOCOL,
    type: "apply-whiteboard-object",
    payload: {
      requestId,
      whiteboardArtifactId: record.artifactId,
      baseRevisionId: record.baseRevisionId,
      sceneHash: record.sceneHash,
      sceneUrl: `${origin}/objects/sha256/${record.sceneHash}`,
      draftId: record.draftId,
      draftVersion: record.version,
    },
  });
  flashAt(els.viewerFlash, "Applying whiteboard update to the canvas…");
  renderViewer();
  return requestId;
}

function showWhiteboardApplyRecovery(
  record,
  message,
  successMessage = "Whiteboard update applied ✓",
) {
  record.applyError = message;
  recoveryAt(els.viewerFlash, message, "Retry apply", () =>
    applyWhiteboardObject(record, successMessage),
  );
  renderViewer();
}

function whiteboardApplyReceiptMatches(expected, payload) {
  return (
    payload.requestId === expected.requestId &&
    payload.whiteboardArtifactId === expected.artifactId &&
    payload.baseRevisionId === expected.baseRevisionId &&
    payload.sceneHash === expected.sceneHash &&
    payload.draftId === expected.draftId &&
    payload.draftVersion === expected.draftVersion
  );
}

function settleWhiteboardApply(expected, record) {
  clearTimeout(expected.timer);
  state.whiteboardPendingApplies.delete(expected.requestId);
  if (record?.pendingApplyId === expected.requestId) record.pendingApplyId = null;
}

function confirmWhiteboardObjectApplied(payload) {
  const expected = state.whiteboardPendingApplies.get(payload.requestId);
  if (!expected) return;
  const record = state.whiteboardDrafts.get(expected.artifactId);
  if (!record || !whiteboardApplyReceiptMatches(expected, payload)) {
    settleWhiteboardApply(expected, record);
    if (record) {
      showWhiteboardApplyRecovery(
        record,
        "Whiteboard update was not confirmed — the canvas receipt did not match.",
        expected.successMessage,
      );
    }
    return;
  }
  if (!Number.isInteger(payload.elementCount) || payload.elementCount < 0) {
    settleWhiteboardApply(expected, record);
    showWhiteboardApplyRecovery(
      record,
      "Whiteboard update returned an invalid canvas receipt.",
      expected.successMessage,
    );
    return;
  }
  settleWhiteboardApply(expected, record);
  record.applyError = null;
  if (!record.pendingOperation) record.initialized = true;
  flashAt(els.viewerFlash, expected.successMessage);
  renderViewer();
}

function rejectWhiteboardObjectApplied(payload) {
  const expected = state.whiteboardPendingApplies.get(payload.requestId);
  if (!expected) return;
  const record = state.whiteboardDrafts.get(expected.artifactId);
  if (!record || !whiteboardApplyReceiptMatches(expected, payload)) {
    settleWhiteboardApply(expected, record);
    if (record) {
      showWhiteboardApplyRecovery(
        record,
        "Whiteboard update failed with a mismatched canvas receipt.",
        expected.successMessage,
      );
    }
    return;
  }
  settleWhiteboardApply(expected, record);
  showWhiteboardApplyRecovery(
    record,
    `Whiteboard update was not applied: ${payload.error ?? "canvas rejected the object"}`,
    expected.successMessage,
  );
}

function cancelWhiteboardApplies() {
  for (const pending of state.whiteboardPendingApplies.values()) clearTimeout(pending.timer);
  state.whiteboardPendingApplies.clear();
  for (const record of state.whiteboardDrafts.values()) record.pendingApplyId = null;
}

function showWhiteboardConflict(record, errorMessage = null) {
  const conflict = record.conflict;
  if (!conflict) return;
  clearTimeout(flashTimers.get(els.viewerFlash));
  const latest = el("button", { type: "button", class: "ghost small" }, "Use latest");
  const mine = el("button", { type: "button", class: "small" }, "Keep mine");
  latest.addEventListener("click", () => {
    record.version = conflict.receipt.currentDraftVersion;
    record.sceneHash = conflict.receipt.currentSceneHash;
    record.conflict = null;
    applyWhiteboardObject(record, "Latest whiteboard version applied ✓");
  });
  mine.addEventListener("click", () => {
    mine.disabled = true;
    try {
      record.pendingOperation = retainWhiteboardOperation(
        record,
        conflict.scene,
        conflict.receipt.currentDraftVersion,
        conflict.receipt.conflictId,
      );
      clearTimeout(record.timer);
      record.timer = setTimeout(() => flushWhiteboardDraft(record), 0);
      flashAt(els.viewerFlash, "Resolving the whiteboard conflict…");
    } catch (error) {
      showWhiteboardConflict(
        record,
        `Keep mine is paused: ${error instanceof Error ? error.message : "retry custody is unavailable"}. Your conflicting scene is retained.`,
      );
    }
  });
  els.viewerFlash.classList.add("error");
  els.viewerFlash.hidden = false;
  els.viewerFlash.replaceChildren(
    el(
      "span",
      {},
      errorMessage ?? "This whiteboard changed in two places. Choose which version to keep.",
    ),
    latest,
    mine,
  );
}

function flushAllWhiteboards() {
  for (const record of state.whiteboardDrafts.values()) {
    clearTimeout(record.timer);
    flushWhiteboardDraft(record);
  }
}

function activeWhiteboardRecord() {
  for (const board of state.currentWhiteboards) {
    const record = state.whiteboardDrafts.get(board.artifactId);
    if (record) return record;
  }
  return null;
}

async function publishActiveWhiteboard() {
  const record = activeWhiteboardRecord();
  if (!record || record.conflict || !state.snapshot) return;
  clearTimeout(record.timer);
  if (record.pendingScene) await flushWhiteboardDraft(record);
  for (let attempt = 0; record.inFlight && attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (record.inFlight || record.pendingScene || record.conflict) {
    flashAt(
      els.viewerFlash,
      "Finish saving or resolve the whiteboard conflict before publishing.",
      true,
    );
    return;
  }
  if (!record.publishAttempt) {
    const revisionId = `rev_${crypto.randomUUID()}`;
    record.publishAttempt = {
      revisionId,
      envelope: {
        protocol: COMMAND_PROTOCOL,
        commandId: crypto.randomUUID(),
        idempotencyKey: `whiteboard.publish-draft:${revisionId}`,
        workspaceId: state.snapshot.workspace.workspaceId,
        actor: { kind: "human", id: "browser" },
        type: "whiteboard.publish-draft",
        payload: {
          artifactId: record.artifactId,
          draftId: record.draftId,
          expectedDraftVersion: record.version,
          expectedHeadRevisionId: record.baseRevisionId,
          revisionId,
        },
      },
    };
  }
  const attempt = record.publishAttempt;
  els.publishWhiteboard.disabled = true;
  try {
    const response = await fetch("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(attempt.envelope),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.status === "accepted") {
      const publishedRevisionId = result.response?.revisionId ?? attempt.revisionId;
      record.baseRevisionId = publishedRevisionId;
      record.draftId = `draft_${crypto.randomUUID()}`;
      record.version = 0;
      record.publishAttempt = null;
      flashAt(els.viewerFlash, "Board revision published ✓");
      await refreshSnapshot();
    } else {
      record.publishAttempt = null;
      recoveryAt(
        els.viewerFlash,
        `Publish failed: ${result.message ?? result.error ?? response.status}`,
        "Retry publish",
        () => publishActiveWhiteboard(),
      );
    }
  } catch {
    recoveryAt(
      els.viewerFlash,
      "Publish could not reach the daemon. The same idempotent publication is ready to retry.",
      "Retry publish",
      () => publishActiveWhiteboard(),
    );
  } finally {
    els.publishWhiteboard.disabled = false;
  }
}

/** In-document selection popover actions settle only after the durable command receipt. */
async function handleSelectionComment(payload, sourcePort = state.bridgePort) {
  const target = normalizeTarget(payload.target ?? {});
  const text = (payload.text ?? "").trim();
  const settle = (accepted, error = null) => {
    if (!payload.requestId) return;
    sourcePort?.postMessage({
      protocol: BRIDGE_PROTOCOL,
      type: "selection-comment-result",
      payload: { requestId: payload.requestId, accepted, error },
    });
  };
  if (!text) {
    settle(false, "Write a comment before sending.");
    return false;
  }
  try {
    let accepted = false;
    if (payload.deliver === "chat") {
      accepted = await sendSelectionChat(text, target);
    } else if (payload.deliver === "review") {
      openDraftForm(target);
      els.draftText.value = text;
      accepted = await submitPendingComment();
    }
    settle(Boolean(accepted), accepted ? null : "The daemon did not accept this comment.");
    return Boolean(accepted);
  } catch {
    const message = "The daemon is unreachable. Your comment is still available to retry.";
    flashAt(payload.deliver === "chat" ? els.chatFlash : els.flash, message, true);
    settle(false, message);
    return false;
  }
}

async function sendSelectionChat(text, target) {
  const artifact = selectedArtifact();
  const revision = viewedRevision();
  if (!artifact || !revision || !state.snapshot) return false;
  const messageId = crypto.randomUUID();
  const artifactId = target.boardAnchor?.whiteboardArtifactId ?? artifact.artifactId;
  const revisionId = target.boardAnchor?.baseRevisionId ?? revision.revisionId;
  const reference = {
    kind: "selection",
    label: targetLabel(target),
    artifactId,
    revisionId,
    ...(target.textQuote ? { textQuote: target.textQuote } : {}),
    ...(target.semanticId ? { semanticId: target.semanticId } : {}),
    ...(target.boardAnchor ? { boardAnchor: target.boardAnchor } : {}),
  };
  const envelope = {
    protocol: COMMAND_PROTOCOL,
    commandId: crypto.randomUUID(),
    idempotencyKey: `chat.send:${messageId}`,
    workspaceId: state.snapshot.workspace.workspaceId,
    actor: { kind: "human", id: "browser" },
    type: "chat.send",
    payload: {
      messageId,
      artifactId,
      text,
      references: [reference],
      ...(state.sessionContext.sessionId ? { sessionId: state.sessionContext.sessionId } : {}),
      ...(state.sessionContext.agentId ? { recipientAgentId: state.sessionContext.agentId } : {}),
      context: {
        revisionId,
        ...target,
      },
    },
  };
  const res = await fetch("/api/v1/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const data = await res.json().catch(() => ({}));
  state.activeTab = "chat";
  renderTabs();
  if (res.ok && data.status === "accepted") {
    await refreshSnapshot();
    els.chatList.scrollTop = els.chatList.scrollHeight;
    return true;
  } else {
    flashAt(els.chatFlash, `error: ${data.message ?? data.error ?? res.status}`, true);
    return false;
  }
}

function sendMode() {
  state.bridgePort?.postMessage({
    protocol: BRIDGE_PROTOCOL,
    type: "set-mode",
    payload: { mode: state.mode },
  });
}

// ---- drafts and review submission ------------------------------------------

function setChatContext(payload) {
  const revision = viewedRevision();
  if (!revision) return;
  const target = normalizeTarget(payload);
  state.chatContext = {
    revisionId: target.boardAnchor?.baseRevisionId ?? revision.revisionId,
    ...target,
  };
  renderChatContext();
}

function openDraftForm(payload) {
  const artifact = selectedArtifact();
  const revision = viewedRevision();
  if (!artifact || !revision) return;
  if (state.drafts.length > 0) {
    const context = state.drafts[0];
    if (context.artifactId !== artifact.artifactId || context.revisionId !== revision.revisionId) {
      state.activeTab = "feedback";
      renderTabs();
      flash("submit or discard the current drafts first — they target another revision", true);
      return;
    }
  }
  const target = normalizeTarget(payload);
  const whiteboardRecord = target.boardAnchor?.whiteboardArtifactId
    ? state.whiteboardDrafts.get(target.boardAnchor.whiteboardArtifactId)
    : null;
  if (whiteboardRecord) flushWhiteboardDraft(whiteboardRecord);
  state.pendingTargetInvoker =
    document.activeElement instanceof HTMLElement ? document.activeElement : els.viewerFrame;
  state.pendingTarget = {
    target,
    artifactId: target.boardAnchor?.whiteboardArtifactId ?? artifact.artifactId,
    revisionId: target.boardAnchor?.baseRevisionId ?? revision.revisionId,
  };
  state.activeTab = "feedback";
  renderTabs();
  renderDrafts();
  els.draftText.value = "";
  els.draftRationale.value = "";
  els.draftText.focus();
}

function restoreDraftInvoker() {
  const invoker = state.pendingTargetInvoker;
  state.pendingTargetInvoker = null;
  if (invoker?.isConnected) queueMicrotask(() => invoker.focus());
}

function closeDraftForm() {
  if (!state.pendingTarget) return;
  state.pendingTarget = null;
  renderDrafts();
  restoreDraftInvoker();
}

function addDraft() {
  const pending = state.pendingTarget;
  if (!pending) return;
  const type = els.draftIntentType.value;
  const text = els.draftText.value.trim();
  if (!text) {
    flash("write something first", true);
    return;
  }
  let body;
  if (type === "replace-text") {
    body = { value: text };
  } else if (type === "add-constraint") {
    body = { statement: text };
    const rationale = els.draftRationale.value.trim();
    if (rationale) body.rationale = rationale;
  } else {
    body = { text };
  }
  state.drafts.push({
    intentId: crypto.randomUUID(),
    intentType: type,
    target: pending.target,
    body,
    artifactId: pending.artifactId,
    revisionId: pending.revisionId,
  });
  state.pendingTarget = null;
  restoreDraftInvoker();
  renderTabs();
  renderDrafts();
  return true;
}

async function submitPendingComment() {
  const pending = state.pendingTarget;
  if (!pending) return false;
  const type = els.draftIntentType.value;
  const text = els.draftText.value.trim();
  if (!text) {
    flash("write something first", true);
    els.draftText.focus();
    return false;
  }
  let body;
  if (type === "replace-text") body = { value: text };
  else if (type === "add-constraint") {
    body = { statement: text };
    const rationale = els.draftRationale.value.trim();
    if (rationale) body.rationale = rationale;
  } else body = { text };
  const draft = {
    intentId: crypto.randomUUID(),
    intentType: type,
    target: pending.target,
    body,
    artifactId: pending.artifactId,
    revisionId: pending.revisionId,
  };
  els.draftSend.disabled = true;
  const accepted = await submitDraftBatch([draft], {
    control: els.draftSend,
    successMessage: "Comment saved for review ✓",
  });
  if (accepted) {
    state.pendingTarget = null;
    restoreDraftInvoker();
    els.draftText.value = "";
    state.activeTab = "feedback";
  }
  els.draftSend.disabled = false;
  render();
  return accepted;
}

async function submitDraftBatch(
  draftsToSubmit,
  { control = els.submitReview, successMessage = null } = {},
) {
  if (draftsToSubmit.length === 0) return false;
  const first = draftsToSubmit[0];
  const batchId = crypto.randomUUID();
  const commentsOnly = draftsToSubmit.every((draft) => draft.intentType === "comment");
  const envelope = {
    protocol: COMMAND_PROTOCOL,
    commandId: crypto.randomUUID(),
    idempotencyKey: `${commentsOnly ? "review.submit-comments" : "review.submit-batch"}:${batchId}`,
    workspaceId: state.snapshot.workspace.workspaceId,
    actor: { kind: "human", id: "browser" },
    type: commentsOnly ? "review.submit-comments" : "review.submit-batch",
    payload: {
      batchId,
      ...(commentsOnly ? {} : { workId: crypto.randomUUID() }),
      artifactId: first.artifactId,
      revisionId: first.revisionId,
      intents: draftsToSubmit.map(({ intentId, intentType, target, body }) => ({
        intentId,
        intentType,
        target,
        body,
      })),
    },
  };
  control.disabled = true;
  els.submitReview.disabled = true;
  try {
    const res = await fetch("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === "accepted") {
      const submittedIds = new Set(draftsToSubmit.map((draft) => draft.intentId));
      state.drafts = state.drafts.filter((draft) => !submittedIds.has(draft.intentId));
      flash(
        successMessage ??
          (commentsOnly ? "Comments saved for review ✓" : "Review submitted and tracked ✓"),
      );
      await refreshSnapshot();
      return true;
    } else {
      flash(`error: ${data.message ?? data.error ?? res.status}`, true);
    }
  } catch {
    flash("daemon unreachable", true);
  }
  control.disabled = false;
  renderTabs();
  renderDrafts();
  return false;
}

async function submitReview() {
  const draftsToSubmit = [...state.drafts];
  const accepted = await submitDraftBatch(draftsToSubmit);
  if (accepted) {
    state.pendingTarget = null;
    renderTabs();
    renderDrafts();
  }
}

// ---- chat -------------------------------------------------------------------

async function sendChat() {
  const rawText = els.chatInput.value.trim();
  if (!state.snapshot) return;
  const incomplete = state.pendingAttachments.filter((attachment) => attachment.status !== "ready");
  if (incomplete.length > 0) {
    const failed = incomplete.some((attachment) => attachment.status === "error");
    flashAt(
      els.chatFlash,
      failed
        ? "Remove or retry failed attachments before sending. Nothing was sent."
        : "Wait for attachments to finish uploading. Nothing was sent.",
      true,
    );
    return;
  }
  const attachments = state.pendingAttachments.map((attachment) => attachment.descriptor);
  const references = [...state.chatReferences];
  const selection = selectionReference();
  if (
    selection &&
    !references.some((reference) => referenceKey(reference) === referenceKey(selection))
  ) {
    references.push(selection);
  }
  for (const attachment of attachments) {
    const fileReference = { kind: "file", label: attachment.fileName, hash: attachment.hash };
    if (!references.some((reference) => referenceKey(reference) === referenceKey(fileReference))) {
      references.push(fileReference);
    }
  }
  if (!rawText && references.length === 0 && attachments.length === 0) {
    flashAt(
      els.chatFlash,
      "Write a message or add context before sending. Nothing was sent.",
      true,
    );
    els.chatInput.focus();
    return false;
  }
  const messageId = crypto.randomUUID();
  const payload = {
    messageId,
    artifactId:
      state.chatContext?.boardAnchor?.whiteboardArtifactId ??
      selectedArtifact()?.artifactId ??
      null,
    text: rawText,
  };
  if (state.chatContext) payload.context = state.chatContext;
  if (references.length > 0) payload.references = references;
  if (attachments.length > 0) payload.attachments = attachments;
  const legacyMentions = references
    .filter((reference) => reference.kind === "document" || reference.kind === "whiteboard")
    .map((reference) => reference.artifactId);
  if (legacyMentions.length > 0) payload.mentions = [...new Set(legacyMentions)];
  if (state.sessionContext.sessionId) payload.sessionId = state.sessionContext.sessionId;
  if (state.sessionContext.agentId) payload.recipientAgentId = state.sessionContext.agentId;
  const envelope = {
    protocol: COMMAND_PROTOCOL,
    commandId: crypto.randomUUID(),
    idempotencyKey: `chat.send:${messageId}`,
    workspaceId: state.snapshot.workspace.workspaceId,
    actor: { kind: "human", id: "browser" },
    type: "chat.send",
    payload,
  };
  state.chatSending = true;
  updateChatSendAvailability();
  try {
    const res = await fetch("/api/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === "accepted") {
      els.chatInput.value = "";
      resizeChatInput();
      state.chatContext = null;
      state.chatReferences = [];
      clearPendingAttachments();
      closeMentionPopover();
      await refreshSnapshot();
    } else {
      flashAt(els.chatFlash, `error: ${data.message ?? data.error ?? res.status}`, true);
    }
  } catch {
    flashAt(els.chatFlash, "daemon unreachable", true);
  }
  state.chatSending = false;
  updateChatSendAvailability();
}

// ---- verified workspace export ---------------------------------------------

function setWorkspaceExportProgress(message, busy = false) {
  els.workspaceExport.disabled = busy;
  els.workspaceExport.querySelector("span").textContent = busy ? message : "Save workspace";
  els.workspaceExportStatus.textContent = message;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchVerifiedBytes(url, expectedHash, label) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error(`${label} has an invalid SHA-256 hash`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} could not be fetched (${response.status})`);
  const bytes = await response.arrayBuffer();
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== expectedHash) throw new Error(`${label} failed SHA-256 verification`);
  return bytes;
}

function safeExportSegment(value, fallback) {
  const normalized = String(value ?? "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, "-")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/^\.+$/, "")
    .trim();
  return normalized || fallback;
}

function portableExportPath(path) {
  const segments = String(path).replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Unsafe export path: ${path}`);
  }
  return segments.join("/");
}

function exportedArtifactPath(snapshot, artifact, head) {
  const sourcePath = artifact.sourcePath;
  const fallbackName = safeExportSegment(
    String(head.entryPath).split(/[\\/]/).pop(),
    `${safeExportSegment(artifact.name, "artifact")}.${head.format}`,
  );
  if (!sourcePath) {
    return `.tweakloop/artifacts/${safeExportSegment(artifact.artifactId, "artifact")}/${fallbackName}`;
  }
  const normalizedRoot = String(snapshot.workspace.rootPath)
    .replaceAll("\\", "/")
    .replace(/\/$/, "");
  const normalizedSource = String(sourcePath).replaceAll("\\", "/");
  if (normalizedSource.startsWith(`${normalizedRoot}/`)) {
    return portableExportPath(normalizedSource.slice(normalizedRoot.length + 1));
  }
  return `external/${safeExportSegment(artifact.artifactId, "artifact")}/${safeExportSegment(
    normalizedSource.split("/").pop(),
    fallbackName,
  )}`;
}

function collectExportAttachments(events) {
  const descriptors = new Map();
  for (const event of events) {
    if (event.eventType !== "chat.message") continue;
    for (const attachment of event.payload?.attachments ?? []) {
      const prior = descriptors.get(attachment.hash);
      const serialized = JSON.stringify(attachment);
      if (prior && JSON.stringify(prior) !== serialized) {
        throw new Error(`Attachment ${attachment.hash} has conflicting descriptors`);
      }
      descriptors.set(attachment.hash, attachment);
    }
  }
  return [...descriptors.values()].sort((left, right) => left.hash.localeCompare(right.hash));
}

async function writeExportFile(rootHandle, path, bytes) {
  const segments = portableExportPath(path).split("/");
  const fileName = segments.pop();
  let directory = rootHandle;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }
  const file = await directory.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function createFreshExportDirectory(parentHandle) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const name = `tweakloop-export-${stamp}-${suffix}`;
    try {
      await parentHandle.getDirectoryHandle(name);
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
      return { name, handle: await parentHandle.getDirectoryHandle(name, { create: true }) };
    }
  }
  throw new Error("Could not allocate a fresh export directory");
}

async function exportWorkspaceFromBrowser() {
  if (typeof window.showDirectoryPicker !== "function") {
    const hint = "Folder access is unavailable here. Run: tweak workspace export <directory>";
    setWorkspaceExportProgress(hint);
    flashAt(els.viewerFlash, hint, true);
    return;
  }
  let parentHandle;
  try {
    parentHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (error) {
    if (error.name === "AbortError") {
      setWorkspaceExportProgress("Workspace save canceled");
      return;
    }
    throw error;
  }

  const snapshot = structuredClone(state.snapshot);
  if (!snapshot) throw new Error("Workspace snapshot is not ready");
  const capturedSeq = snapshot.lastSeq;
  if (!Number.isSafeInteger(capturedSeq) || capturedSeq < 0) {
    throw new Error("Workspace snapshot has an invalid sequence");
  }
  setWorkspaceExportProgress("Verifying…", true);
  const eventsResponse = await fetch("/api/v1/events?after=0");
  if (!eventsResponse.ok)
    throw new Error(`Event history could not be fetched (${eventsResponse.status})`);
  const listedEvents = await eventsResponse.json();
  const events = listedEvents
    .filter((event) => event.seq <= capturedSeq)
    .sort((left, right) => left.seq - right.seq);
  if (events.length !== capturedSeq)
    throw new Error(`Event history is incomplete at seq ${capturedSeq}`);
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1 || event.seq > capturedSeq) {
      throw new Error(`Event history diverges at seq ${index + 1}`);
    }
    if (event.workspaceId !== snapshot.workspace.workspaceId) {
      throw new Error(`Event ${event.seq} belongs to another workspace`);
    }
  }

  const revisions = [...snapshot.revisions].sort(
    (left, right) => left.seq - right.seq || left.revisionId.localeCompare(right.revisionId),
  );
  const objects = new Map();
  const manifestRevisions = [];
  for (const [index, revision] of revisions.entries()) {
    if (revision.seq > capturedSeq)
      throw new Error(`Revision ${revision.revisionId} is newer than the capture`);
    setWorkspaceExportProgress(`Verifying ${index + 1}/${revisions.length}`, true);
    const bytes = await fetchVerifiedBytes(
      `/api/v1/revisions/${encodeURIComponent(revision.revisionId)}/source`,
      revision.entryHash,
      `Revision ${revision.revisionId}`,
    );
    if (!objects.has(revision.entryHash)) objects.set(revision.entryHash, bytes);
    manifestRevisions.push({
      revisionId: revision.revisionId,
      artifactId: revision.artifactId,
      parentId: revision.parentId,
      seq: revision.seq,
      format: revision.format,
      entryPath: revision.entryPath,
      entryHash: revision.entryHash,
      objectPath: `.tweakloop/objects/sha256/${revision.entryHash}`,
    });
  }

  const revisionsByArtifact = new Map();
  for (const revision of revisions) {
    const history = revisionsByArtifact.get(revision.artifactId) ?? [];
    history.push(revision);
    revisionsByArtifact.set(revision.artifactId, history);
  }
  const artifactsForManifest = [];
  const headFiles = new Map();
  for (const artifact of [...snapshot.artifacts].sort((a, b) =>
    a.artifactId.localeCompare(b.artifactId),
  )) {
    const history = revisionsByArtifact.get(artifact.artifactId) ?? [];
    const head = history[history.length - 1];
    if (!head) throw new Error(`Artifact ${artifact.artifactId} has no head revision`);
    const exportedPath = exportedArtifactPath(snapshot, artifact, head);
    const collisionKey = exportedPath.normalize("NFC").toLowerCase();
    if (headFiles.has(collisionKey))
      throw new Error(`Artifact export path collides: ${exportedPath}`);
    headFiles.set(collisionKey, { path: exportedPath, bytes: objects.get(head.entryHash) });
    artifactsForManifest.push({
      artifactId: artifact.artifactId,
      format: head.format,
      headRevisionId: head.revisionId,
      headSeq: head.seq,
      entryHash: head.entryHash,
      exportedPath,
    });
  }

  const attachmentDescriptors = collectExportAttachments(events);
  const attachmentsForManifest = [];
  for (const [index, descriptor] of attachmentDescriptors.entries()) {
    setWorkspaceExportProgress(`Attachments ${index + 1}/${attachmentDescriptors.length}`, true);
    const bytes = await fetchVerifiedBytes(
      attachmentUrl(descriptor.hash),
      descriptor.hash,
      `Attachment ${descriptor.fileName}`,
    );
    if (bytes.byteLength !== descriptor.byteLength) {
      throw new Error(`Attachment size does not match: ${descriptor.fileName}`);
    }
    if (!objects.has(descriptor.hash)) objects.set(descriptor.hash, bytes);
    attachmentsForManifest.push({
      descriptor,
      objectPath: `.tweakloop/objects/sha256/${descriptor.hash}`,
    });
  }

  const manifest = {
    protocol: "tweakloop.workspace-export/v1",
    source: {
      workspaceId: snapshot.workspace.workspaceId,
      projectId: snapshot.workspace.projectId,
      rootPath: snapshot.workspace.rootPath,
    },
    capturedSeq,
    artifacts: artifactsForManifest,
    revisions: manifestRevisions,
    attachments: attachmentsForManifest,
    events,
  };
  const destination = await createFreshExportDirectory(parentHandle);
  try {
    setWorkspaceExportProgress(`Writing ${destination.name}…`, true);
    for (const { path, bytes } of [...headFiles.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      await writeExportFile(destination.handle, path, bytes);
    }
    for (const [hash, bytes] of [...objects].sort(([left], [right]) => left.localeCompare(right))) {
      await writeExportFile(destination.handle, `.tweakloop/objects/sha256/${hash}`, bytes);
    }
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeExportFile(destination.handle, ".tweakloop/export-manifest.json", manifestBytes);
  } catch (error) {
    throw new Error(
      `Save did not complete in ${destination.name}: ${error?.message ?? "unknown write error"}`,
    );
  }
  setWorkspaceExportProgress(`Saved ${destination.name}`);
  flashAt(els.viewerFlash, `Saved verified workspace as ${destination.name} ✓`);
}

// ---- restore ----------------------------------------------------------------

async function restoreViewedRevision() {
  const revision = viewedRevision();
  if (!revision) return;
  els.restoreRevision.disabled = true;
  try {
    const res = await fetch("/api/v1/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revisionId: revision.revisionId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      state.pinnedRevisionId = null;
      flashAt(
        els.viewerFlash,
        `restored as r${data.seq} — source file not modified; run \`tweak restore\` or let the agent sync`,
      );
      await refreshSnapshot();
    } else {
      flashAt(els.viewerFlash, `error: ${data.message ?? data.error ?? res.status}`, true);
    }
  } catch {
    flashAt(els.viewerFlash, "daemon unreachable", true);
  }
  els.restoreRevision.disabled = false;
}

// ---- workspace onboarding --------------------------------------------------

function onboardingRequestId(kind) {
  return `${kind}_${crypto.randomUUID()}`;
}

function supportedArtifactFile(file) {
  return /\.(html?|md|markdown|excalidraw)$/i.test(file.name);
}

async function responseData(response) {
  return response.json().catch(() => ({}));
}

function responseMessage(response, data) {
  return data.message ?? data.error ?? `Request failed (${response.status})`;
}

function normalizedArtifactReceipt(data) {
  const receipt = data.receipt ?? data.artifact ?? data;
  return {
    artifactId: receipt.artifactId ?? data.artifactId ?? null,
    revisionId:
      receipt.revisionId ??
      receipt.currentRevisionId ??
      data.revisionId ??
      data.currentRevisionId ??
      null,
    sessionId: receipt.sessionId ?? data.sessionId ?? state.sessionContext.sessionId,
    name: receipt.name ?? data.name ?? null,
  };
}

function sessionDeliveryStatus(artifactId) {
  const attached = currentSessionArtifacts().some((item) => item.artifactId === artifactId);
  if (!attached) return { state: "delayed", status: "Saved · handoff delayed" };
  if (assignedAgentPresence()) return { state: "added", status: "Added · session ready" };
  if (safeAgentName()) return { state: "added", status: "Added · available offline" };
  return { state: "added", status: "Added" };
}

function deliveryAnnouncement(count) {
  const noun = `${count} document${count === 1 ? "" : "s"}`;
  const agentName = safeAgentName();
  if (agentName && assignedAgentPresence()) {
    return `${noun} added. ${agentName} is connected and the content is available in this session.`;
  }
  if (agentName) {
    return `${noun} added. The content will be available to ${agentName} when the agent reconnects.`;
  }
  return `${noun} added. No agent is attached yet.`;
}

async function finalizeOnboardingArtifacts(results, focusCanvas = false) {
  const first = results.find((result) => result.artifactId);
  if (first) state.selectedArtifactId = first.artifactId;
  const focusViewer = () => els.viewerFrame.focus();
  state.focusViewerOnReady = Boolean(first && focusCanvas);
  await refreshSnapshot();
  for (const result of results) {
    if (!result.artifactId) continue;
    Object.assign(result, sessionDeliveryStatus(result.artifactId));
  }
  renderOnboardingProgress();
  if (first) {
    if (!focusCanvas) requestAnimationFrame(focusViewer);
  }
}

async function importArtifactResult(result) {
  result.state = "adding";
  result.status = "Adding";
  renderOnboardingProgress();
  const headers = {
    "content-type": result.file.type || "application/octet-stream",
    "x-tweakloop-session": state.sessionContext.sessionId,
    "x-tweakloop-filename": result.file.name,
    "x-tweakloop-request-id": result.requestId,
  };
  try {
    const response = await fetch("/api/v1/session-artifacts", {
      method: "POST",
      headers,
      body: result.file,
    });
    const data = await responseData(response);
    if (!response.ok) throw new Error(responseMessage(response, data));
    const receipt = normalizedArtifactReceipt(data);
    if (!receipt.artifactId || !receipt.revisionId) {
      throw new Error("The daemon returned an incomplete artifact receipt.");
    }
    result.artifactId = receipt.artifactId;
    result.revisionId = receipt.revisionId;
    result.state = "added";
    result.status = "Added";
  } catch (error) {
    result.state = "error";
    result.status = error?.message ?? "Needs attention";
  }
  renderOnboardingProgress();
}

async function importSelectedFiles(files, existingResults = null) {
  if (!state.sessionContext.sessionId) {
    setOnboardingRecovery(
      "This shell is not attached to a durable session. Reopen it from the session link.",
    );
    return;
  }
  const results =
    existingResults ??
    files.map((file, index) => ({
      name: file.name,
      file,
      requestId: `${onboardingRequestId("import")}_${index}`,
      state: supportedArtifactFile(file) ? "queued" : "error",
      status: supportedArtifactFile(file) ? "Waiting" : "Unsupported format",
      artifactId: null,
      revisionId: null,
    }));
  if (existingResults) {
    for (const result of results) {
      if (!result.artifactId && result.file && supportedArtifactFile(result.file)) {
        result.state = "queued";
        result.status = "Waiting";
      }
    }
  }
  state.onboarding.title = `Adding ${results.length} document${results.length === 1 ? "" : "s"}…`;
  state.onboarding.results = results;
  state.onboarding.recovery = null;
  setOnboardingBusy(true);
  announceOnboarding(state.onboarding.title);
  for (const result of results.filter((item) => item.state !== "error" && !item.artifactId)) {
    await importArtifactResult(result);
  }
  const successes = results.filter((result) => result.artifactId);
  if (successes.length > 0) await finalizeOnboardingArtifacts(results);
  const failures = results.filter((result) => result.state === "error");
  state.onboarding.title =
    failures.length === 0
      ? `${successes.length} document${successes.length === 1 ? "" : "s"} added`
      : `${successes.length} added; ${failures.length} need${failures.length === 1 ? "s" : ""} attention`;
  setOnboardingBusy(false);
  if (failures.length > 0) {
    setOnboardingRecovery(
      "Successful documents are saved. Retry only the files that need attention.",
      () => importSelectedFiles([], results),
    );
  } else {
    state.onboarding.recovery = null;
    state.onboarding.retry = null;
    renderOnboardingProgress();
  }
  announceOnboarding(deliveryAnnouncement(successes.length));
}

async function createWhiteboard(existingResult = null) {
  if (!state.sessionContext.sessionId) {
    setOnboardingRecovery(
      "This shell is not attached to a durable session. Reopen it from the session link.",
    );
    return;
  }
  const result = existingResult ?? {
    name: "Untitled whiteboard",
    requestId: onboardingRequestId("whiteboard"),
    state: "adding",
    status: "Creating",
    artifactId: null,
    revisionId: null,
  };
  state.onboarding.title = "Creating whiteboard…";
  state.onboarding.results = [result];
  state.onboarding.recovery = null;
  setOnboardingBusy(true);
  announceOnboarding("Creating whiteboard…");
  try {
    const response = await fetch("/api/v1/session-whiteboards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionContext.sessionId,
        requestId: result.requestId,
        name: result.name,
      }),
    });
    const data = await responseData(response);
    if (!response.ok) throw new Error(responseMessage(response, data));
    const receipt = normalizedArtifactReceipt(data);
    if (!receipt.artifactId || !receipt.revisionId) {
      throw new Error("The daemon returned an incomplete whiteboard receipt.");
    }
    result.artifactId = receipt.artifactId;
    result.revisionId = receipt.revisionId;
    result.state = "added";
    result.status = "Saved";
    await finalizeOnboardingArtifacts([result], true);
    state.onboarding.title = "Whiteboard ready";
    state.onboarding.recovery = null;
    state.onboarding.retry = null;
    announceOnboarding(deliveryAnnouncement(1).replace("document", "whiteboard"));
  } catch (error) {
    result.state = "error";
    result.status = "Needs attention";
    state.onboarding.title = "Whiteboard isn't saved yet";
    setOnboardingRecovery(
      error?.message ??
        "The whiteboard could not be created. Your request identity is preserved for retry.",
      () => createWhiteboard(result),
    );
  } finally {
    setOnboardingBusy(false);
  }
}

function portableWorkspacePath(file) {
  const parts = String(file.webkitRelativePath || file.name)
    .split("/")
    .filter(Boolean);
  return portableExportPath(parts.length > 1 ? parts.slice(1).join("/") : parts[0]);
}

function requiredRestorePaths(data) {
  const items = data.requiredPaths ?? data.requiredFiles ?? data.files ?? [];
  return items.map((item) => (typeof item === "string" ? item : item.path));
}

function base64ArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function parsedJsonBytes(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} is not exact UTF-8 JSON.`);
  }
}

async function locallyValidateSelectedWorkspaceBundle(fileByPath) {
  const envelopeFile = fileByPath.get(".tweakloop/workspace-bundle.json");
  const manifestFile = fileByPath.get(".tweakloop/export-manifest.json");
  if (!envelopeFile || !manifestFile) {
    throw new Error(
      "This folder is not a bound Tweakloop workspace export. Re-export it with the current CLI.",
    );
  }
  const envelopeBytes = await envelopeFile.arrayBuffer();
  const manifestBytes = await manifestFile.arrayBuffer();
  const envelope = parsedJsonBytes(envelopeBytes, "The workspace bundle envelope");
  const manifest = parsedJsonBytes(manifestBytes, "The collaboration manifest");
  if (envelope.protocol !== "tweakloop.workspace-bundle/v2") {
    throw new Error("This workspace bundle requires migration. Re-export it with the current CLI.");
  }
  if (
    envelope.collaboration?.manifestPath !== ".tweakloop/export-manifest.json" ||
    (await sha256Hex(manifestBytes)) !== envelope.collaboration?.manifestHash
  ) {
    throw new Error("The selected collaboration manifest does not match its bound envelope.");
  }
  if (
    manifest.protocol !== "tweakloop.workspace-export/v1" ||
    manifest.source?.workspaceId !== envelope.source?.workspaceId ||
    manifest.source?.projectId !== envelope.source?.projectId ||
    manifest.capturedSeq !== envelope.source?.capturedSeq ||
    envelope.capture?.collaboration?.capturedSeq !== manifest.capturedSeq ||
    envelope.capture?.collaboration?.observedEndSeq !== manifest.capturedSeq ||
    envelope.capture?.collaboration?.consistency !== "event-seq-exact"
  ) {
    throw new Error("The selected workspace identity does not match its collaboration history.");
  }
  const identity = {
    protocol: envelope.protocol,
    source: envelope.source,
    collaboration: envelope.collaboration,
    workspaceFiles: envelope.workspaceFiles,
    capture: envelope.capture,
    inventory: envelope.inventory,
  };
  const expectedBundleId = `bundle_${await sha256Hex(
    new TextEncoder().encode(
      `tweakloop.workspace-bundle/v2\0bundle-id\0${JSON.stringify(identity)}`,
    ),
  )}`;
  if (envelope.bundleId !== expectedBundleId) {
    throw new Error("The selected workspace bundle identity is invalid.");
  }
  const workspaceManifestPath = "workspace-files/.tweakloop/workspace-files-manifest.json";
  const workspaceManifestFile = fileByPath.get(workspaceManifestPath);
  let workspaceFilesManifestBase64 = null;
  if (envelope.workspaceFiles === null) {
    if (workspaceManifestFile || envelope.capture?.workspaceFiles !== null) {
      throw new Error("The selected workspace contains an unbound workspace-file component.");
    }
  } else {
    if (
      envelope.workspaceFiles?.manifestPath !== workspaceManifestPath ||
      !workspaceManifestFile ||
      envelope.capture?.workspaceFiles === null
    ) {
      throw new Error("The selected workspace-file component is incomplete.");
    }
    const workspaceManifestBytes = await workspaceManifestFile.arrayBuffer();
    if ((await sha256Hex(workspaceManifestBytes)) !== envelope.workspaceFiles.manifestHash) {
      throw new Error("The selected workspace-file manifest does not match its bound envelope.");
    }
    workspaceFilesManifestBase64 = base64ArrayBuffer(workspaceManifestBytes);
  }
  return {
    bundleId: envelope.bundleId,
    collaborationManifestHash: envelope.collaboration.manifestHash,
    request: {
      protocol: "tweakloop.workspace-restore-request/v3",
      bundleEnvelopeBase64: base64ArrayBuffer(envelopeBytes),
      collaborationManifestBase64: base64ArrayBuffer(manifestBytes),
      workspaceFilesManifestBase64,
    },
  };
}

async function restoreWorkspace(files) {
  const fileByPath = new Map();
  for (const file of files) {
    const path = portableWorkspacePath(file);
    if (fileByPath.has(path)) {
      setOnboardingRecovery(`This workspace contains a duplicate portable path: ${path}`);
      return;
    }
    fileByPath.set(path, file);
  }
  if (!fileByPath.has(".tweakloop/export-manifest.json")) {
    setOnboardingRecovery(
      "This folder isn't a saved Tweakloop workspace. Choose the folder containing .tweakloop/export-manifest.json.",
      () => els.workspaceDirectoryInput.click(),
    );
    return;
  }
  state.onboarding.title = "Checking workspace…";
  state.onboarding.results = [
    { name: "Saved workspace", state: "adding", status: "Checking history" },
  ];
  state.onboarding.recovery = null;
  setOnboardingBusy(true);
  announceOnboarding("Checking workspace…");
  try {
    const bound = await locallyValidateSelectedWorkspaceBundle(fileByPath);
    const staged = await fetch("/api/v1/workspace-restores", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bound.request),
    });
    const stagedData = await responseData(staged);
    if (!staged.ok) throw new Error(responseMessage(staged, stagedData));
    const restoreId = stagedData.bundleId;
    if (
      restoreId !== bound.bundleId ||
      stagedData.manifestHash !== bound.collaborationManifestHash
    ) {
      throw new Error("The daemon restore identity differs from the selected bound workspace.");
    }
    const requiredPaths = requiredRestorePaths(stagedData);
    state.onboarding.title = "Restoring documents…";
    state.onboarding.results[0].status = `Uploading ${requiredPaths.length} verified files`;
    renderOnboardingProgress();
    for (const path of requiredPaths) {
      const file = fileByPath.get(path);
      if (!file) throw new Error(`This workspace is incomplete: ${path} is missing.`);
      const uploaded = await fetch(
        `/api/v1/workspace-restores/${encodeURIComponent(restoreId)}/files?path=${encodeURIComponent(path)}`,
        { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file },
      );
      const uploadedData = await responseData(uploaded);
      if (!uploaded.ok) throw new Error(responseMessage(uploaded, uploadedData));
    }
    state.onboarding.title = "Verifying history…";
    state.onboarding.results[0].status = "Rebuilding workspace";
    renderOnboardingProgress();
    const committed = await fetch(
      `/api/v1/workspace-restores/${encodeURIComponent(restoreId)}/commit`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const committedData = await responseData(committed);
    if (!committed.ok) throw new Error(responseMessage(committed, committedData));
    if (!committedData.url) throw new Error("The restored workspace did not return a shell link.");
    state.onboarding.results[0].state = "added";
    state.onboarding.results[0].status = "Workspace ready";
    state.onboarding.title = "Workspace ready";
    announceOnboarding("Workspace ready. Opening its isolated local session.");
    renderOnboardingProgress();
    window.location.assign(committedData.url);
  } catch (error) {
    state.onboarding.results[0].state = "error";
    state.onboarding.results[0].status = "Needs attention";
    state.onboarding.title = "Workspace not opened";
    setOnboardingRecovery(
      `${error?.message ?? "Workspace restore failed"} Your current workspace is unchanged.`,
      () => restoreWorkspace(files),
    );
  } finally {
    setOnboardingBusy(false);
  }
}

// ---- data flow --------------------------------------------------------------

async function refreshSnapshot() {
  const res = await fetch("/api/v1/snapshot");
  if (!res.ok) return;
  state.snapshot = await res.json();
  reconcileQuestionAnswerAttempts();
  state.lastSeq = Math.max(state.lastSeq, state.snapshot.lastSeq ?? 0);
  render();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshSnapshot().catch(() => {});
  }, 150);
}

function follow() {
  const source = new EventSource(`/api/v1/events?after=${state.lastSeq}`);
  source.onopen = () =>
    setConnection("live", "synced", "Workspace updates are synchronized with Tweakloop.");
  source.onerror = () =>
    setConnection(
      "down",
      "reconnecting…",
      "The live update connection was interrupted. Tweakloop is retrying automatically; if this persists, restart the daemon and reopen the workspace.",
    );
  source.onmessage = (message) => {
    const envelope = JSON.parse(message.data);
    if (envelope.seq <= state.lastSeq) return;
    notifyWorkReady(envelope);
    state.lastSeq = envelope.seq;
    scheduleRefresh();
  };
}

// ---- theme ------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeToggle.textContent = theme === "dark" ? "☀" : "☾";
  els.themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  const nextTheme = theme === "dark" ? "light" : "dark";
  els.themeToggle.setAttribute("aria-label", `Switch to ${nextTheme} theme`);
  els.themeToggle.title = `Switch to ${nextTheme} theme`;
}

// ---- wiring -----------------------------------------------------------------

applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

els.themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("tweakloop-theme", next);
  applyTheme(next);
});

els.notificationsToggle.addEventListener("click", () => {
  toggleNotifications().catch(() => {
    els.notificationsStatus.textContent = "Notifications could not be enabled.";
  });
});

els.workspaceExport.addEventListener("click", () => {
  exportWorkspaceFromBrowser().catch((error) => {
    const message = `Workspace save failed: ${error?.message ?? "unknown error"}. If a tweakloop-export-* folder was created, treat it as incomplete unless it contains .tweakloop/export-manifest.json; delete that folder and retry.`;
    setWorkspaceExportProgress(message);
    flashAt(els.viewerFlash, message, true);
  });
});

function openArtifactPicker(invoker) {
  state.onboarding.invoker = invoker;
  els.documentAdd.open = false;
  els.artifactFileInput.value = "";
  els.artifactFileInput.click();
}

function openWorkspacePicker(invoker) {
  state.onboarding.invoker = invoker;
  els.workspaceDirectoryInput.value = "";
  els.workspaceDirectoryInput.click();
}

els.startOpenFiles.addEventListener("click", () => openArtifactPicker(els.startOpenFiles));
els.documentOpenFiles.addEventListener("click", () => openArtifactPicker(els.documentOpenFiles));
els.startOpenWorkspace.addEventListener("click", () => openWorkspacePicker(els.startOpenWorkspace));
els.startNewWhiteboard.addEventListener("click", () => {
  createWhiteboard().catch(() => {});
});
els.documentNewWhiteboard.addEventListener("click", () => {
  els.documentAdd.open = false;
  createWhiteboard().catch(() => {});
});
els.artifactFileInput.addEventListener("change", () => {
  const files = [...els.artifactFileInput.files];
  if (files.length === 0) return;
  importSelectedFiles(files).catch(() => {});
});
els.artifactFileInput.addEventListener("cancel", () => state.onboarding.invoker?.focus());
els.workspaceDirectoryInput.addEventListener("change", () => {
  const files = [...els.workspaceDirectoryInput.files];
  if (files.length === 0) return;
  restoreWorkspace(files).catch(() => {});
});
els.workspaceDirectoryInput.addEventListener("cancel", () => state.onboarding.invoker?.focus());
els.onboardingDismiss.addEventListener("click", () => {
  clearOnboardingProgress();
  (selectedArtifact() ? els.viewerFrame : els.startOpenFiles).focus();
});

els.artifactSelect.addEventListener("change", () => {
  selectArtifact(els.artifactSelect.value);
});

els.viewerFrame.addEventListener("load", () => {
  if (els.viewerFrame.hidden || !els.viewerFrame.dataset.src) return;
  connectBridge();
});
els.viewerFrame.addEventListener("error", () => {
  if (state.viewerNavigation) failViewerNavigation("The artifact response failed.");
});

function setMode(mode) {
  state.mode = mode;
  sendMode();
  renderViewer();
}

els.modeToggle.addEventListener("click", () => {
  setMode(state.mode === "annotate" ? "interact" : "annotate");
});
els.modeInteract.addEventListener("click", () => setMode("interact"));

const railMedia = matchMedia("(max-width: 1200px)");
const sheetMedia = matchMedia("(max-width: 1000px)");

function storedOutlineCollapsed() {
  return localStorage.getItem("tweakloop-outline") === "collapsed";
}

function storedAgentCollapsed() {
  return localStorage.getItem("tweakloop-agent-rail") === "collapsed";
}

function renderWorkspaceLayout() {
  const narrow = sheetMedia.matches;
  const agentCollapsed = !narrow && state.agentCollapsed;
  const chatExpanded = !narrow && state.activeTab === "chat" && state.chatExpanded;
  els.workspaceShell.classList.toggle("agent-collapsed", agentCollapsed);
  els.workspaceShell.classList.toggle("canvas-wide", state.canvasWide);
  els.workspaceShell.classList.toggle("chat-expanded", chatExpanded);
  els.agentRail.classList.toggle("collapsed", agentCollapsed);
  els.agentCollapse.setAttribute("aria-expanded", String(!agentCollapsed));
  els.agentCollapse.setAttribute(
    "aria-label",
    agentCollapsed ? "Expand collaboration" : "Collapse collaboration",
  );
  els.agentCollapse.title = agentCollapsed ? "Expand collaboration" : "Collapse collaboration";
  els.agentCollapse.textContent = agentCollapsed ? "«" : "»";
  const chatExpansionAvailable = !narrow && state.activeTab === "chat";
  els.chatExpand.hidden = !chatExpansionAvailable;
  els.chatExpand.disabled = !chatExpansionAvailable;
  els.chatExpand.setAttribute("aria-pressed", String(chatExpanded));
  els.chatExpand.setAttribute("aria-label", chatExpanded ? "Restore Chat width" : "Expand Chat");
  els.chatExpand.title = chatExpanded ? "Restore Chat width" : "Expand Chat";
  els.viewerExpand.classList.toggle("is-active", state.canvasWide);
  els.viewerExpand.setAttribute("aria-pressed", String(state.canvasWide));
  els.viewerExpand.setAttribute(
    "aria-label",
    state.canvasWide ? "Restore workspace rails" : "Expand canvas",
  );
  els.viewerExpand.title = state.canvasWide ? "Restore workspace rails" : "Expand canvas";
}

function renderOutline() {
  els.outlineRail.classList.toggle("collapsed", state.outlineCollapsed);
  els.outlineCollapse.textContent = state.outlineCollapsed ? "»" : "«";
  els.outlineCollapse.title = state.outlineCollapsed ? "Expand documents" : "Collapse documents";
  els.outlineCollapse.setAttribute(
    "aria-label",
    state.outlineCollapsed ? "Expand documents" : "Collapse documents",
  );
  els.outlineCollapse.setAttribute("aria-expanded", String(!state.outlineCollapsed));
  renderWorkspaceLayout();
  if (state.outlineCollapsed) return;
  const outlineNodes = state.nodes.filter(
    (node) => Number.isInteger(node.outlineLevel) || node.kind === "whiteboard",
  );
  els.outlineList.replaceChildren(
    ...outlineNodes.map((node) => {
      const button = el(
        "button",
        {
          type: "button",
          class: "outline-item",
          title: node.semanticId ?? "",
          "data-outline-level": String(node.outlineLevel ?? 1),
        },
        el("span", { class: "outline-label" }, node.label || node.semanticId || "(unnamed)"),
        node.kind === "whiteboard" ? el("span", { class: "outline-kind" }, "whiteboard") : null,
      );
      button.addEventListener("click", () => revealTarget({ semanticId: node.semanticId }));
      return el("li", { "data-testid": "outline-item" }, button);
    }),
  );
  els.outlineEmpty.textContent = state.outlineLoading
    ? "Loading this document’s outline…"
    : "This document has no outline yet.";
  els.outlineEmpty.hidden = outlineNodes.length > 0;
}

function outlineCollapsedForViewport() {
  if (sheetMedia.matches) return false;
  return railMedia.matches ? true : storedOutlineCollapsed();
}

state.outlineCollapsed = outlineCollapsedForViewport();
state.agentCollapsed = storedAgentCollapsed();
function syncResponsiveOutline() {
  state.outlineCollapsed = outlineCollapsedForViewport();
  renderOutline();
}
railMedia.addEventListener("change", syncResponsiveOutline);
sheetMedia.addEventListener("change", syncResponsiveOutline);

els.outlineCollapse.addEventListener("click", () => {
  state.outlineCollapsed = !state.outlineCollapsed;
  localStorage.setItem("tweakloop-outline", state.outlineCollapsed ? "collapsed" : "open");
  renderOutline();
});

els.agentCollapse.addEventListener("click", () => {
  state.agentCollapsed = !state.agentCollapsed;
  localStorage.setItem("tweakloop-agent-rail", state.agentCollapsed ? "collapsed" : "open");
  renderWorkspaceLayout();
});

els.chatExpand.addEventListener("click", () => {
  state.activeTab = "chat";
  state.chatExpanded = !state.chatExpanded;
  renderTabs();
  renderWorkspaceLayout();
});

els.viewerExpand.addEventListener("click", () => {
  state.canvasWide = !state.canvasWide;
  renderWorkspaceLayout();
});

els.viewerFullscreen.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await els.viewerFrame.requestFullscreen();
    }
  } catch {
    state.canvasWide = true;
    renderWorkspaceLayout();
    flashAt(
      els.viewerFlash,
      "Browser fullscreen is unavailable, so Tweakloop expanded the canvas instead.",
    );
  }
});

document.addEventListener("fullscreenchange", () => {
  const active = document.fullscreenElement === els.viewerFrame;
  els.viewerFullscreen.classList.toggle("is-active", active);
  els.viewerFullscreen.setAttribute(
    "aria-label",
    active ? "Exit artifact fullscreen" : "Enter artifact fullscreen",
  );
  els.viewerFullscreen.title = active ? "Exit artifact fullscreen" : "Enter artifact fullscreen";
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.chatExpanded) {
    state.chatExpanded = false;
    renderWorkspaceLayout();
    els.chatExpand.focus();
    return;
  }
  if (event.key === "Escape" && state.canvasWide && !document.fullscreenElement) {
    state.canvasWide = false;
    renderWorkspaceLayout();
    els.viewerExpand.focus();
  }
});
els.publishWhiteboard.addEventListener("click", () => {
  publishActiveWhiteboard().catch(() =>
    recoveryAt(els.viewerFlash, "Whiteboard publish failed.", "Retry publish", () =>
      publishActiveWhiteboard(),
    ),
  );
});

els.restoreRevision.addEventListener("click", () => {
  restoreViewedRevision().catch(() => {});
});

els.revisionSelect.addEventListener("change", () => {
  flushAllWhiteboards();
  state.pendingReveal = null;
  const artifact = selectedArtifact();
  if (!artifact) return;
  const revs = revisionsOf(artifact.artifactId);
  const head = revs[revs.length - 1];
  state.pinnedRevisionId =
    els.revisionSelect.value === head?.revisionId ? null : els.revisionSelect.value;
  render();
});

for (const tab of els.tabs) {
  tab.addEventListener("click", () => {
    activateCollaborationTab(tab.dataset.tab, { persist: true, focus: true });
  });
  tab.addEventListener("keydown", (event) => {
    const current = els.tabs.indexOf(tab);
    let next = null;
    if (event.key === "ArrowRight") next = (current + 1) % els.tabs.length;
    if (event.key === "ArrowLeft") next = (current - 1 + els.tabs.length) % els.tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = els.tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    activateCollaborationTab(els.tabs[next].dataset.tab, { persist: true, focus: true });
  });
}

for (const heading of document.querySelectorAll("[data-focus-section]")) {
  heading.addEventListener("click", () => {
    state.activeTab = heading.dataset.focusSection;
    renderTabs();
    heading.closest(".collab-section")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

els.draftIntentType.addEventListener("change", updateDraftFields);
els.draftAdd.addEventListener("click", addDraft);
els.draftSend.addEventListener("click", () => {
  submitPendingComment().catch(() => flash("daemon unreachable", true));
});
els.draftText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    submitPendingComment().catch(() => flash("daemon unreachable", true));
  }
});
els.draftForm.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeDraftForm();
});
els.draftCancel.addEventListener("click", closeDraftForm);
els.submitReview.addEventListener("click", () => {
  submitReview().catch(() => flash("daemon unreachable", true));
});

els.chatSend.addEventListener("click", () => {
  sendChat().catch(() => flashAt(els.chatFlash, "daemon unreachable", true));
});
els.chatAttach.addEventListener("click", () => els.chatFileInput.click());
els.chatFileInput.addEventListener("change", () => {
  queueAttachments([...els.chatFileInput.files]);
  els.chatFileInput.value = "";
});
els.chatInput.addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
    file.type.startsWith("image/"),
  );
  if (images.length === 0) return;
  event.preventDefault();
  queueAttachments(images);
  flashAt(els.chatFlash, `${images.length} pasted image${images.length === 1 ? "" : "s"} added`);
});
els.chatInput.addEventListener("keydown", (event) => {
  if (state.mention) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveMention(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveMention(-1);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      acceptMention(state.mention.options[state.mention.index]);
      return;
    }
    if (event.key === "Tab") {
      closeMentionPopover();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionPopover();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChat().catch(() => flashAt(els.chatFlash, "daemon unreachable", true));
  }
});
els.chatInput.addEventListener("input", updateMentionPopover);
els.chatInput.addEventListener("input", resizeChatInput);
els.chatInput.addEventListener("input", updateChatSendAvailability);
els.chatInput.addEventListener("blur", () => closeMentionPopover());

els.decisionReason.addEventListener("input", () => {
  els.decisionSubmit.disabled = els.decisionReason.value.trim().length === 0;
});
els.decisionCancel.addEventListener("click", closeDecisionDialog);
els.decisionDialog.addEventListener("close", () => {
  const invoker = state.decisionRequest?.invoker;
  state.decisionRequest = null;
  invoker?.focus();
});
els.decisionRetry.addEventListener("click", async () => {
  const request = state.decisionRequest;
  if (!request) return;
  const completed = await submitDecision(
    request.work,
    "reopen",
    els.decisionRetry,
    "Retry the original task exactly; no additional guidance was supplied.",
  );
  if (completed) closeDecisionDialog();
});
els.decisionSubmit.addEventListener("click", async () => {
  const request = state.decisionRequest;
  const reason = els.decisionReason.value.trim();
  if (!request || !reason) return;
  const completed = await submitDecision(request.work, "reopen", els.decisionSubmit, reason);
  if (completed) closeDecisionDialog();
});

function renderSheet() {
  const narrow = sheetMedia.matches;
  els.agentRail.classList.toggle("sheet-open", narrow && state.railOpen);
  els.sheetToggle.setAttribute("aria-expanded", String(narrow && state.railOpen));
  els.agentRailContent.inert = narrow && !state.railOpen;
  renderWorkspaceLayout();
}

els.sheetToggle.addEventListener("click", () => {
  state.railOpen = !state.railOpen;
  renderSheet();
  if (state.railOpen) els.agentRailContent.querySelector("button, input")?.focus();
});

sheetMedia.addEventListener("change", renderSheet);
renderSheet();
window.addEventListener("pagehide", () => {
  flushAllWhiteboards();
  clearPendingAttachments();
});

// ---- boot -------------------------------------------------------------------

async function boot() {
  try {
    const [snapshotRes, contextRes] = await Promise.all([
      fetch("/api/v1/snapshot"),
      fetch("/api/v1/session-context"),
    ]);
    if (!snapshotRes.ok) {
      if (snapshotRes.status === 401 || snapshotRes.status === 403) {
        throw new Error("bootstrap-required");
      }
      throw new Error(`snapshot-http:${snapshotRes.status}`);
    }
    try {
      state.snapshot = await snapshotRes.json();
    } catch {
      throw new Error("snapshot-invalid");
    }
    if (contextRes.ok) {
      try {
        state.sessionContext = await contextRes.json();
      } catch {
        throw new Error("context-invalid");
      }
    }
    if (
      state.sessionContext.artifactId &&
      artifacts().some((artifact) => artifact.artifactId === state.sessionContext.artifactId)
    ) {
      state.selectedArtifactId = state.sessionContext.artifactId;
    }
    state.lastSeq = state.snapshot.lastSeq ?? 0;
    render();
    follow();
    startPresencePolling();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unreachable";
    const bootstrapRequired = reason === "bootstrap-required";
    const invalidWorkspace = reason === "snapshot-invalid" || reason === "context-invalid";
    const connectionLabel = bootstrapRequired
      ? "authorization required"
      : invalidWorkspace
        ? "invalid workspace data"
        : "daemon unavailable";
    const recovery = bootstrapRequired
      ? "This shell requires a fresh bootstrap link. Run `tweak open <path>` to continue."
      : invalidWorkspace
        ? "Tweakloop returned workspace data the shell could not read. Restart the daemon, then run `tweak open <path>` again. Nothing was changed by this page."
        : "The Tweakloop daemon could not provide this workspace. Start or restart the daemon, then run `tweak open <path>` again.";
    setConnection("down", connectionLabel, recovery);
    els.viewerEmpty.hidden = false;
    els.viewerEmpty.textContent = recovery;
  }
}

boot();
