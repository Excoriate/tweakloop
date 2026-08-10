/**
 * Tweakloop artifact bridge v1.
 *
 * Injected into immutable revision projections on the isolated artifact
 * origin. It has no credentials and no mutation capability: its only
 * channel is a MessagePort transferred by the trusted shell after an
 * exact-origin handshake.
 *
 * Interact mode never interferes with the artifact's own behavior;
 * Annotate mode captures element clicks as typed-intent targets. In
 * BOTH modes, selecting text raises a Google-Docs-style comment popover
 * at the selection — the comment is delivered to the shell, which sends
 * it to the live agent chat or stores it as a review draft.
 */
(() => {
  const config = window.__TWEAKLOOP__;
  if (!config) return;

  const PROTOCOL = "tweakloop.bridge/v1";
  const CONTEXT_CHARS = 32;
  const BOARD_READY_EVENT = "tweakloop:whiteboard-ready";
  const BOARD_SELECTION_EVENT = "tweakloop:whiteboard-selection";
  const BOARD_CHANGE_EVENT = "tweakloop:whiteboard-change";
  const BOARD_ERROR_EVENT = "tweakloop:whiteboard-error";
  const MODE_EVENT = "tweakloop:set-mode";
  let port = null;
  let mode = "interact";
  let highlighted = null;
  let previousOutline = "";
  let pendingComment = null;

  // Persistent marks for commented selections, via the CSS Custom
  // Highlight API — the revision's DOM is never mutated.
  const supportsMarks = typeof Highlight !== "undefined" && "highlights" in CSS;
  const marks = supportsMarks ? new Highlight() : null;
  if (supportsMarks) {
    CSS.highlights.set("tweakloop-mark", marks);
    const style = document.createElement("style");
    style.textContent =
      "::highlight(tweakloop-mark) { background: rgba(250, 204, 21, 0.45); color: inherit; }";
    document.head.appendChild(style);
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== config.shellOrigin) return;
    const data = event.data;
    if (!data || data.protocol !== PROTOCOL || data.type !== "connect") return;
    const transferred = event.ports?.[0];
    if (!transferred) return;
    port = transferred;
    port.onmessage = (message) => handle(message.data);
    send("ready", { nodes: discoverNodes(), whiteboards: discoverWhiteboards() });
  });

  function send(type, payload) {
    if (!port) return;
    port.postMessage({ protocol: PROTOCOL, type, revisionId: config.revisionId, payload });
  }

  function handle(message) {
    if (!message || message.protocol !== PROTOCOL) return;
    if (message.type === "selection-comment-result") {
      const result = message.payload || {};
      if (!pendingComment || result.requestId !== pendingComment.requestId) return;
      const submitted = pendingComment;
      pendingComment = null;
      for (const button of buttons) button.disabled = false;
      if (result.accepted) {
        if (marks && submitted.range) marks.add(submitted.range);
        closePopover({ force: true });
      } else {
        popoverStatus.hidden = false;
        popoverStatus.textContent =
          result.error || "The comment was not saved. Check the shell and retry.";
        textEl.focus();
      }
      return;
    }
    if (message.type === "set-mode") {
      mode = message.payload && message.payload.mode === "annotate" ? "annotate" : "interact";
      clearHighlight();
      if (mode === "interact" && marks) marks.clear();
      window.dispatchEvent(new CustomEvent(MODE_EVENT, { detail: { mode } }));
    }
    if (message.type === "reveal-target") {
      revealTarget(message.payload || {});
    }
    if (message.type === "apply-whiteboard-scene") {
      applyWhiteboardScene(message.payload || {});
    }
    if (message.type === "apply-whiteboard-object") {
      applyWhiteboardObject(message.payload || {});
    }
    if (message.type === "whiteboard.load") {
      loadWhiteboardScene(message.payload || {});
    }
  }

  function whiteboardRegistry() {
    return window.__TWEAKLOOP_WHITEBOARDS__ instanceof Map
      ? window.__TWEAKLOOP_WHITEBOARDS__
      : null;
  }

  function whiteboardFor(target) {
    const boardId = target?.boardAnchor?.semanticId || target?.semanticId || target?.boardId;
    if (boardId) return whiteboardRegistry()?.get(boardId) || null;
    const artifactId =
      target?.whiteboardArtifactId ||
      target?.boardAnchor?.whiteboardArtifactId ||
      target?.artifactId;
    if (!artifactId) return null;
    return (
      Array.from(whiteboardRegistry()?.values() || []).find(
        (candidate) => candidate.artifactId === artifactId,
      ) || null
    );
  }

  async function fetchWhiteboardObject(payload) {
    if (
      typeof payload.whiteboardArtifactId !== "string" ||
      !payload.whiteboardArtifactId ||
      typeof payload.baseRevisionId !== "string" ||
      !payload.baseRevisionId ||
      !/^[0-9a-f]{64}$/.test(payload.sceneHash || "")
    ) {
      throw new Error("Whiteboard object metadata is incomplete");
    }
    const sceneUrl = new URL(payload.sceneUrl, window.location.href);
    if (
      sceneUrl.origin !== window.location.origin ||
      !/^\/objects\/sha256\/[0-9a-f]{64}$/.test(sceneUrl.pathname) ||
      sceneUrl.pathname.slice(-64) !== payload.sceneHash
    ) {
      throw new Error(
        "Whiteboard scene URL must match an immutable object on this artifact origin",
      );
    }
    const response = await fetch(sceneUrl, {
      method: "GET",
      credentials: "omit",
      cache: "force-cache",
      headers: { Accept: "application/vnd.excalidraw+json, application/json" },
    });
    if (!response.ok) throw new Error(`Whiteboard scene fetch failed (${response.status})`);
    return response.json();
  }

  async function loadWhiteboardScene(payload) {
    const board = whiteboardFor(payload);
    if (!board || typeof board.loadScene !== "function") {
      send("whiteboard-load-error", {
        requestId: payload.requestId || null,
        error: "Pinned whiteboard host is missing or already loaded",
      });
      return;
    }
    try {
      const scene = await fetchWhiteboardObject(payload);
      const result = await board.loadScene(scene, payload);
      send("whiteboard-loaded", { requestId: payload.requestId || null, ...result });
    } catch (error) {
      send("whiteboard-load-error", {
        requestId: payload.requestId || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function whiteboardObjectIdentity(payload) {
    const identity = {
      requestId: payload.requestId || null,
      whiteboardArtifactId: payload.whiteboardArtifactId || null,
      baseRevisionId: payload.baseRevisionId || null,
      sceneHash: payload.sceneHash || null,
    };
    if (typeof payload.draftId === "string" && payload.draftId) {
      identity.draftId = payload.draftId;
    }
    if (Number.isInteger(payload.draftVersion)) {
      identity.draftVersion = payload.draftVersion;
    }
    return identity;
  }

  async function applyWhiteboardObject(payload) {
    const identity = whiteboardObjectIdentity(payload);
    const board = whiteboardFor(payload);
    if (!board || typeof board.applyScene !== "function") {
      send("whiteboard-object-error", {
        ...identity,
        error: "Whiteboard is not mounted or the artifact anchor is stale",
      });
      return;
    }
    try {
      const scene = await fetchWhiteboardObject(payload);
      const boardContext = {
        whiteboardArtifactId: payload.whiteboardArtifactId,
        baseRevisionId: payload.baseRevisionId,
        sceneHash: payload.sceneHash,
      };
      if (typeof payload.draftId === "string" && payload.draftId) {
        boardContext.draftId = payload.draftId;
      }
      if (Number.isInteger(payload.draftVersion)) {
        boardContext.draftVersion = payload.draftVersion;
      }
      const result = await board.applyScene(scene, boardContext);
      send("whiteboard-object-applied", { ...identity, ...result });
    } catch (error) {
      send("whiteboard-object-error", {
        ...identity,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function applyWhiteboardScene(payload) {
    const board = whiteboardFor(payload);
    if (!board || typeof board.applyScene !== "function") {
      send("whiteboard-scene-error", {
        requestId: payload.requestId || null,
        boardAnchor: payload.boardAnchor || null,
        error: "Whiteboard is not mounted or the board anchor is stale",
      });
      return;
    }
    try {
      const result = await board.applyScene(payload.scene);
      send("whiteboard-scene-applied", {
        requestId: payload.requestId || null,
        ...result,
      });
    } catch (error) {
      send("whiteboard-scene-error", {
        requestId: payload.requestId || null,
        boardAnchor: payload.boardAnchor || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Scroll a comment's anchor into view and pulse it (Docs-style). */
  function revealTarget(target) {
    if (target.boardAnchor?.elementAnchor) {
      const board = whiteboardFor(target);
      if (board?.revealElement(target.boardAnchor.elementAnchor)) {
        send("target-revealed", {
          semanticId: target.boardAnchor.semanticId || target.semanticId || null,
        });
        return;
      }
    }
    let element = null;
    if (target.semanticId) {
      element = document.querySelector(`[data-tweak-id="${CSS.escape(target.semanticId)}"]`);
    }
    if (!element && target.domHint) {
      try {
        element = document.querySelector(target.domHint);
      } catch {
        // stale or malformed hint — nothing to reveal
      }
    }
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    const previous = element.style.outline;
    element.style.outline = "3px solid #7c3aed";
    setTimeout(() => {
      element.style.outline = previous;
    }, 1600);
    send("target-revealed", {
      semanticId: element.getAttribute("data-tweak-id") || target.semanticId || null,
    });
  }

  function discoverNodes() {
    const documentNodes = Array.from(document.querySelectorAll("[data-tweak-id]")).map(
      (element) => {
        const labelledHeading = (element.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .find((candidate) => candidate?.matches?.("h1,h2,h3,h4,h5,h6"));
        const heading = element.matches("h1,h2,h3,h4,h5,h6")
          ? element
          : labelledHeading ||
            (element.getAttribute("data-tweak-kind") === "document-title"
              ? element.querySelector("h1")
              : null);
        return {
          semanticId: element.getAttribute("data-tweak-id"),
          kind: element.getAttribute("data-tweak-kind"),
          source: element.getAttribute("data-tweak-source"),
          label: labelFor(element),
          outlineLevel: heading ? Number(heading.tagName.slice(1)) : null,
        };
      },
    );
    const canvasNodes = [];
    for (const board of whiteboardRegistry()?.values() || []) {
      if (typeof board.getNodes === "function") canvasNodes.push(...board.getNodes());
    }
    return [...documentNodes, ...canvasNodes];
  }

  function discoverWhiteboards() {
    return Array.from(whiteboardRegistry()?.values() || []).map((board) => ({
      semanticId: board.boardId,
      artifactId: board.artifactId || null,
      revisionId: board.revisionId || null,
      status: typeof board.loadScene === "function" ? "waiting" : "ready",
    }));
  }

  window.addEventListener(BOARD_READY_EVENT, () => {
    window.dispatchEvent(new CustomEvent(MODE_EVENT, { detail: { mode } }));
    send("nodes-updated", { nodes: discoverNodes(), whiteboards: discoverWhiteboards() });
  });

  window.addEventListener(BOARD_SELECTION_EVENT, (event) => {
    if (mode !== "annotate" || !event.detail?.target) return;
    send("target-selected", event.detail.target);
  });

  window.addEventListener(BOARD_CHANGE_EVENT, (event) => {
    if (!event.detail?.boardAnchor || !event.detail?.scene) return;
    send("whiteboard-change", event.detail);
  });

  window.addEventListener(BOARD_ERROR_EVENT, (event) => {
    send("whiteboard-error", event.detail || {});
  });

  /** Human-readable node label: heading first, never script/style text. */
  function labelFor(element) {
    if (element.hasAttribute("data-tweakloop-whiteboard")) {
      return element.getAttribute("aria-label") || "Whiteboard canvas";
    }
    const heading = element.querySelector("h1,h2,h3,h4,h5,h6");
    const headingText = heading?.textContent?.trim();
    if (headingText) return headingText.slice(0, 80);
    let text = "";
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
      else if (
        node.nodeType === Node.ELEMENT_NODE &&
        node.tagName !== "SCRIPT" &&
        node.tagName !== "STYLE"
      ) {
        text += node.textContent;
      }
      if (text.trim().length > 80) break;
    }
    const cleaned = text.trim().replace(/\s+/g, " ");
    return (cleaned || element.getAttribute("data-tweak-id") || "").slice(0, 80);
  }

  function anchorFor(element) {
    return element?.closest ? element.closest("[data-tweak-id]") : null;
  }

  function clearHighlight() {
    if (highlighted) {
      highlighted.style.outline = previousOutline;
      highlighted = null;
    }
  }

  // ---- selection comment popover -------------------------------------------

  const popover = document.createElement("div");
  popover.dataset.tweakloopSelectionPopover = "";
  popover.style.cssText = "position:absolute;z-index:2147483647;display:none;";
  const shadow = popover.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      .card {
        width: 300px; background: #fff; color: #101828;
        border: 1px solid #e4e7ec; border-radius: 12px;
        box-shadow: 0 10px 30px rgba(16, 24, 40, 0.16);
        font: 13px/1.45 system-ui, sans-serif; padding: 10px;
        display: grid; gap: 8px;
      }
      .quote {
        font: 12px ui-monospace, monospace; color: #667085;
        border-left: 3px solid #7c3aed; padding-left: 8px;
        max-height: 3.6em; overflow: hidden;
      }
      textarea {
        width: 100%; box-sizing: border-box; resize: vertical; min-height: 52px;
        border: 1px solid #e4e7ec; border-radius: 8px; padding: 6px 8px;
        font: inherit; color: inherit; outline-color: #2563eb;
      }
      .row { display: flex; gap: 6px; justify-content: flex-end; }
      button {
        font: 14px system-ui, sans-serif; border-radius: 8px; padding: 5px 10px;
        border: 1px solid #e4e7ec; background: #fff; cursor: pointer; color: #101828;
      }
      button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
      button:disabled { opacity: 0.45; cursor: default; }
      .status { margin: 0; color: #b42318; font-size: 12px; }
    </style>
    <div class="card">
      <div class="quote"></div>
      <textarea placeholder="Comment on this…"></textarea>
      <p class="status" role="status" aria-live="polite" hidden></p>
      <div class="row">
        <button data-act="cancel">Cancel</button>
        <button data-act="review">Add to review</button>
        <button data-act="chat" class="primary">Send to agent</button>
      </div>
    </div>`;
  const quoteEl = shadow.querySelector(".quote");
  const textEl = shadow.querySelector("textarea");
  const popoverStatus = shadow.querySelector(".status");
  const buttons = shadow.querySelectorAll("button");
  const submitButtons = shadow.querySelectorAll(
    'button[data-act="review"], button[data-act="chat"]',
  );
  let pending = null;
  let focusContext = null;

  function documentEditorFor(range) {
    const container =
      range?.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range?.commonAncestorContainer?.parentElement;
    const selector =
      '[data-tweakloop-editor], [contenteditable]:not([contenteditable="false"]), textarea, input:not([type="hidden"])';
    return container?.closest(selector) || document.querySelector(selector) || document.body;
  }

  function focusConnected(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const hadTabIndex = element.hasAttribute("tabindex");
    if (element === document.body && !hadTabIndex) element.tabIndex = -1;
    element.focus({ preventScroll: true });
    if (element === document.body && !hadTabIndex) element.removeAttribute("tabindex");
    return document.activeElement === element;
  }

  function restorePopoverFocus(context) {
    if (!context) return;
    if (focusConnected(context.invoker)) return;
    if (focusConnected(context.editor)) return;
    focusConnected(documentEditorFor());
  }

  function openPopover(target, range) {
    pending = { target, range: range.cloneRange() };
    focusContext = {
      invoker: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      editor: documentEditorFor(range),
    };
    quoteEl.textContent = `“${target.textQuote.exact.slice(0, 160)}”`;
    textEl.value = "";
    popoverStatus.hidden = true;
    popoverStatus.textContent = "";
    const rect = range.getBoundingClientRect();
    if (!popover.isConnected) document.body.appendChild(popover);
    popover.style.display = "block";
    const left = Math.max(
      8,
      Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - 320),
    );
    popover.style.left = `${left}px`;
    popover.style.top = `${rect.bottom + window.scrollY + 8}px`;
    textEl.focus();
  }

  function closePopover({ force = false, restoreFocus = false } = {}) {
    if (pendingComment && !force) return;
    const closingFocusContext = focusContext;
    popover.style.display = "none";
    pending = null;
    focusContext = null;
    window.getSelection()?.removeAllRanges();
    if (restoreFocus) restorePopoverFocus(closingFocusContext);
  }

  shadow.querySelector('button[data-act="cancel"]').addEventListener("click", () => {
    closePopover({ restoreFocus: true });
  });

  for (const button of submitButtons) {
    button.addEventListener("click", () => {
      if (!pending || pendingComment) return;
      const text = textEl.value.trim();
      if (!text) {
        textEl.focus();
        return;
      }
      const requestId = crypto.randomUUID();
      pendingComment = { requestId, range: pending.range?.cloneRange() ?? null };
      for (const action of buttons) action.disabled = true;
      popoverStatus.hidden = false;
      popoverStatus.textContent = "Saving comment…";
      send("selection-comment", {
        requestId,
        target: pending.target,
        text,
        deliver: button.dataset.act === "chat" ? "chat" : "review",
      });
    });
  }

  shadow.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePopover({ restoreFocus: true });
      return;
    }
    if (event.target === textEl && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      shadow.querySelector('button[data-act="chat"]').click();
    }
  });

  document.addEventListener(
    "mousedown",
    (event) => {
      if (popover.style.display === "block" && !popover.contains(event.target)) closePopover();
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    (event) => {
      if (event.composedPath().includes(popover)) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const exact = selection.toString().trim();
      if (!exact) return;
      const range = selection.getRangeAt(0);
      const container =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      openPopover(
        {
          semanticId: anchorFor(container)?.getAttribute("data-tweak-id") ?? null,
          domHint: container ? domHint(container) : null,
          textQuote: quoteWithContext(range, exact),
        },
        range,
      );
    },
    true,
  );

  // ---- annotate-mode element targeting --------------------------------------

  document.addEventListener(
    "mousemove",
    (event) => {
      if (mode !== "annotate") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target === highlighted) return;
      clearHighlight();
      if (!target || target === document.body || target === document.documentElement) return;
      if (popover.contains(target)) return;
      if (target.closest("[data-tweakloop-whiteboard]")) return;
      highlighted = target;
      previousOutline = target.style.outline;
      target.style.outline = "2px solid #6366f1";
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (mode !== "annotate") return;
      if (popover.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (popover.style.display === "block") return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const element = event.target instanceof Element ? event.target : null;
      if (!element) return;
      if (element.closest("[data-tweakloop-whiteboard]")) return;
      const anchor = anchorFor(element);
      const exact = (element.textContent || "").trim().slice(0, 200);
      send("target-selected", {
        semanticId: anchor ? anchor.getAttribute("data-tweak-id") : null,
        domHint: domHint(element),
        textQuote: { exact },
      });
    },
    true,
  );

  function quoteWithContext(range, exact) {
    const quote = { exact: exact.slice(0, 500) };
    const start = range.startContainer;
    const end = range.endContainer;
    if (start.nodeType === Node.TEXT_NODE) {
      const prefix = (start.textContent || "").slice(0, range.startOffset).trimStart();
      if (prefix) quote.prefix = prefix.slice(-CONTEXT_CHARS);
    }
    if (end.nodeType === Node.TEXT_NODE) {
      const suffix = (end.textContent || "").slice(range.endOffset).trimEnd();
      if (suffix) quote.suffix = suffix.slice(0, CONTEXT_CHARS);
    }
    return quote;
  }

  function domHint(element) {
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 8) {
      const parent = current.parentElement;
      const index = parent ? Array.prototype.indexOf.call(parent.children, current) + 1 : 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
      current = parent;
    }
    return `body > ${parts.join(" > ")}`;
  }
})();
