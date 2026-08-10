import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  restore,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { durableWhiteboardAppState } from "../../../src/whiteboard/app-state.js";
import {
  convertLegacyScene,
  elementsFingerprint,
  LEGACY_MIME,
  NATIVE_MIME,
  normalizeElementAnchors,
  sceneElementNodes,
  validateNativeScene,
  WhiteboardDataError,
} from "./whiteboard-adapter.js";
import "./whiteboard-runtime.css";

const BOARD_READY_EVENT = "tweakloop:whiteboard-ready";
const BOARD_SELECTION_EVENT = "tweakloop:whiteboard-selection";
const BOARD_CHANGE_EVENT = "tweakloop:whiteboard-change";
const BOARD_ERROR_EVENT = "tweakloop:whiteboard-error";
const MODE_EVENT = "tweakloop:set-mode";
const CHANGE_DELAY_MS = 350;
const DARK_CANVAS_DEFAULT_STROKE = "#a5d8ff";

const registry =
  window.__TWEAKLOOP_WHITEBOARDS__ instanceof Map ? window.__TWEAKLOOP_WHITEBOARDS__ : new Map();
window.__TWEAKLOOP_WHITEBOARDS__ = registry;

function parseContainerScene(container, boardId) {
  const nativeScript = container.querySelector(`script[type="${NATIVE_MIME}"]`);
  const legacyScript = container.querySelector(`script[type="${LEGACY_MIME}"]`);
  if (nativeScript && legacyScript) {
    throw new WhiteboardDataError("Whiteboard contains both native and legacy scene data");
  }
  const script = nativeScript || legacyScript;
  if (!script) {
    const artifactId = container.getAttribute("data-tweak-whiteboard-artifact");
    const revisionId = container.getAttribute("data-tweak-whiteboard-revision");
    if (!artifactId || !revisionId) {
      throw new WhiteboardDataError(
        `Whiteboard needs both data-tweak-whiteboard-artifact and data-tweak-whiteboard-revision`,
      );
    }
    return { reference: { artifactId, revisionId } };
  }
  let parsed;
  try {
    parsed = JSON.parse(script.textContent || "null");
  } catch (error) {
    throw new WhiteboardDataError(`Whiteboard data is not valid JSON: ${error.message}`);
  }
  if (legacyScript) {
    return {
      scene: convertLegacyScene(parsed, { boardId, convert: convertToExcalidrawElements }),
      migratedFrom: LEGACY_MIME,
    };
  }
  return { scene: restoreNativeScene(parsed), migratedFrom: null };
}

function restoreNativeScene(rawScene) {
  const validated = validateNativeScene(rawScene);
  const restored = restore(validated, null, null, {
    refreshDimensions: true,
    repairBindings: true,
  });
  return {
    type: "excalidraw",
    version: validated.version,
    source: validated.source,
    elements: normalizeElementAnchors(restored.elements).elements,
    appState: restored.appState,
    files: restored.files,
  };
}

function serializableScene(elements, appState, files) {
  const scene = JSON.parse(serializeAsJSON(elements, appState, files, "local"));
  scene.source = "https://tweakloop.local";
  return scene;
}

function durableSceneFingerprint(elements, appState, files) {
  const scene = serializableScene(elements, appState, files);
  return JSON.stringify({
    elements: scene.elements,
    appState: durableWhiteboardAppState(scene.appState),
    files: scene.files,
  });
}

function preferredTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function dispatch(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function errorState(container, error) {
  container.dataset.tweakloopWhiteboardStatus = "error";
  const state = container.querySelector(".tweakloop-whiteboard__state");
  if (state) {
    state.hidden = false;
    state.classList.add("tweakloop-whiteboard__state--error");
    state.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = "Whiteboard data needs attention";
    const message = document.createElement("code");
    message.textContent = error instanceof Error ? error.message : String(error);
    state.replaceChildren(title, message);
  }
  dispatch(BOARD_ERROR_EVENT, {
    boardId: container.getAttribute("data-tweak-id") || null,
    error: error instanceof Error ? error.message : String(error),
  });
}

function waitForSceneCommit(api, expectedElements, timeoutMs = 2_000) {
  const expectedFingerprint = elementsFingerprint(expectedElements);
  const expectedIds = expectedElements.map((element) => element.id);
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      const actual = api.getSceneElementsIncludingDeleted();
      if (elementsFingerprint(actual) === expectedFingerprint) {
        resolve(actual);
        return;
      }
      if (performance.now() < deadline) {
        requestAnimationFrame(inspect);
        return;
      }
      reject(
        new WhiteboardDataError("Excalidraw did not commit the remote scene", {
          expectedIds,
          actualIds: actual.map((element) => element.id),
        }),
      );
    };
    requestAnimationFrame(inspect);
  });
}

function canvasMutationIsActive(appState) {
  return Boolean(
    appState.newElement ||
      appState.draggingElement ||
      appState.resizingElement ||
      appState.editingElement ||
      appState.editingTextElement ||
      appState.multiElement,
  );
}

function Whiteboard({ container, boardId, boardContext, initialScene, migratedFrom }) {
  const [theme, setTheme] = useState(preferredTheme);
  const apiRef = useRef(null);
  const commentModeRef = useRef(false);
  const pointerSelectionPendingRef = useRef(false);
  const lastSelectedIdRef = useRef(null);
  const suppressFingerprintRef = useRef(null);
  const initialFingerprintRef = useRef(elementsFingerprint(initialScene.elements));
  const lastDurableFingerprintRef = useRef(
    durableSceneFingerprint(initialScene.elements, initialScene.appState, initialScene.files),
  );
  const applyingRemoteRef = useRef(false);
  const localMutationArmedRef = useRef(false);
  const pendingChangeRef = useRef(null);
  const changeTimerRef = useRef(null);
  const boardContextRef = useRef(boardContext);
  const initialViewportFitPendingRef = useRef(true);
  const initialViewportFitFrameRef = useRef(null);

  const initialData = useMemo(
    () => ({
      elements: initialScene.elements,
      appState: {
        ...initialScene.appState,
        ...(theme === "dark" &&
        (!initialScene.appState.currentItemStrokeColor ||
          initialScene.appState.currentItemStrokeColor === "#1e1e1e")
          ? { currentItemStrokeColor: DARK_CANVAS_DEFAULT_STROKE }
          : {}),
      },
      files: initialScene.files,
    }),
    [initialScene, theme],
  );

  const fitInitialViewport = useCallback((api, elements) => {
    if (!api) return false;
    if (!initialViewportFitPendingRef.current) return false;
    if (!elements.some((element) => !element.isDeleted)) return false;
    initialViewportFitPendingRef.current = false;
    requestAnimationFrame(() => {
      if (apiRef.current !== api) return;
      const liveElements = api.getSceneElements();
      if (liveElements.length === 0) return;
      api.scrollToContent(liveElements, {
        fitToContent: true,
        viewportZoomFactor: 0.85,
        maxZoom: 1,
        animate: false,
      });
    });
    return true;
  }, []);

  const scheduleInitialViewportFit = useCallback(
    (api) => {
      if (initialViewportFitFrameRef.current !== null) {
        cancelAnimationFrame(initialViewportFitFrameRef.current);
      }
      let remainingFrames = 120;
      const inspect = () => {
        initialViewportFitFrameRef.current = null;
        if (apiRef.current !== api || !initialViewportFitPendingRef.current) return;
        const elements = api.getSceneElements();
        if (elements.length > 0) {
          api.refresh();
          fitInitialViewport(api, elements);
          return;
        }
        remainingFrames -= 1;
        if (remainingFrames > 0) {
          initialViewportFitFrameRef.current = requestAnimationFrame(inspect);
        }
      };
      initialViewportFitFrameRef.current = requestAnimationFrame(inspect);
    },
    [fitInitialViewport],
  );

  const currentNodes = useCallback(() => {
    const api = apiRef.current;
    return sceneElementNodes(
      boardId,
      api ? api.getSceneElementsIncludingDeleted() : initialScene.elements,
      boardContextRef.current,
    );
  }, [boardId, initialScene.elements]);

  const emitScene = useCallback(
    (elements, appState, files) => {
      pendingChangeRef.current = serializableScene(elements, appState, files);
      window.clearTimeout(changeTimerRef.current);
      changeTimerRef.current = window.setTimeout(() => {
        const scene = pendingChangeRef.current;
        pendingChangeRef.current = null;
        dispatch(BOARD_CHANGE_EVENT, {
          boardAnchor: { semanticId: boardId, ...boardContextRef.current },
          coalesceKey: `${window.__TWEAKLOOP__?.revisionId || "revision"}:${boardId}`,
          scene,
        });
      }, CHANGE_DELAY_MS);
    },
    [boardId],
  );

  const installApi = useCallback(
    (api) => {
      apiRef.current = api;
      scheduleInitialViewportFit(api);
      const adapter = {
        boardId,
        artifactId: boardContextRef.current.whiteboardArtifactId,
        revisionId: boardContextRef.current.baseRevisionId,
        getNodes: currentNodes,
        getScene: () =>
          serializableScene(
            api.getSceneElementsIncludingDeleted(),
            api.getAppState(),
            api.getFiles(),
          ),
        getViewportState: () => {
          const appState = api.getAppState();
          const zoom = appState.zoom;
          return {
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
            zoom: typeof zoom === "number" ? zoom : zoom?.value,
            offsetLeft: appState.offsetLeft,
            offsetTop: appState.offsetTop,
          };
        },
        revealElement: (elementAnchor) => {
          const elementId = elementAnchor?.elementId;
          const anchorId = elementAnchor?.anchorId;
          const element = api
            .getSceneElementsIncludingDeleted()
            .find(
              (candidate) =>
                !candidate.isDeleted &&
                (candidate.id === elementId ||
                  candidate.customData?.tweakloop?.anchorId === anchorId),
            );
          if (!element) return false;
          container.scrollIntoView({ behavior: "smooth", block: "center" });
          api.updateScene({ appState: { selectedElementIds: { [element.id]: true } } });
          api.scrollToContent(element, { fitToContent: false, animate: true, duration: 280 });
          return true;
        },
        applyScene: async (rawScene, nextContext = null) => {
          const scene = validateNativeScene(rawScene);
          if (
            nextContext?.whiteboardArtifactId &&
            nextContext.whiteboardArtifactId !== adapter.artifactId
          ) {
            throw new WhiteboardDataError(
              "Applied whiteboard artifact does not match the mounted canvas",
            );
          }
          localMutationArmedRef.current = false;
          const restoredElements = restoreElements(
            scene.elements,
            api.getSceneElementsIncludingDeleted(),
            { refreshDimensions: true, repairBindings: true },
          );
          const normalized = normalizeElementAnchors(restoredElements).elements;
          const restoredIds = new Set(normalized.map((element) => element.id));
          const rejectedLiveIds = scene.elements
            .filter((element) => !element.isDeleted && !restoredIds.has(element.id))
            .map((element) => element.id);
          if (rejectedLiveIds.length > 0) {
            throw new WhiteboardDataError(
              "Excalidraw rejected live elements from the remote scene",
              { rejectedLiveIds },
            );
          }
          applyingRemoteRef.current = true;
          suppressFingerprintRef.current = elementsFingerprint(normalized);
          const durableAppState = durableWhiteboardAppState(scene.appState);
          lastDurableFingerprintRef.current = durableSceneFingerprint(
            normalized,
            durableAppState,
            scene.files,
          );
          try {
            if (Object.keys(scene.files).length > 0) api.addFiles(Object.values(scene.files));
            api.updateScene({
              elements: normalized,
              appState: durableAppState,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
            await waitForSceneCommit(api, normalized);
            fitInitialViewport(api, normalized);
          } catch (error) {
            applyingRemoteRef.current = false;
            suppressFingerprintRef.current = null;
            throw error;
          }
          if (nextContext) {
            boardContextRef.current = nextContext;
            adapter.revisionId = nextContext.baseRevisionId;
          }
          requestAnimationFrame(() => {
            applyingRemoteRef.current = false;
          });
          return {
            boardAnchor: { semanticId: boardId, ...boardContextRef.current },
            elementCount: normalized.filter((element) => !element.isDeleted).length,
          };
        },
      };
      registry.set(boardId, adapter);
      container.dataset.tweakloopWhiteboardStatus = "ready";
      const state = container.querySelector(".tweakloop-whiteboard__state");
      if (state) state.hidden = true;
      dispatch(BOARD_READY_EVENT, {
        boardId,
        migratedFrom,
        nodes: adapter.getNodes(),
      });
    },
    [
      boardId,
      container,
      currentNodes,
      fitInitialViewport,
      migratedFrom,
      scheduleInitialViewportFit,
    ],
  );

  const onChange = useCallback(
    (elements, appState, files) => {
      // Excalidraw emits the provisional element at pointer-down. Replacing the
      // scene to add our durable anchor during that native transaction aborts
      // its resize/draw continuation and leaves a zero-size element. Element
      // IDs are already stable targets; normalize custom anchors only after
      // Excalidraw finishes the mutation.
      if (canvasMutationIsActive(appState)) return;
      const rawFingerprint = elementsFingerprint(elements);
      const isInitialHydration = initialFingerprintRef.current === rawFingerprint;
      initialFingerprintRef.current = null;
      const normalized = normalizeElementAnchors(elements);
      const fingerprint = elementsFingerprint(normalized.elements);
      const durableFingerprint = durableSceneFingerprint(normalized.elements, appState, files);
      if (normalized.changed) {
        suppressFingerprintRef.current = fingerprint;
        apiRef.current?.updateScene({
          elements: normalized.elements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        if (!isInitialHydration && !applyingRemoteRef.current && localMutationArmedRef.current) {
          localMutationArmedRef.current = false;
          if (lastDurableFingerprintRef.current !== durableFingerprint) {
            lastDurableFingerprintRef.current = durableFingerprint;
            emitScene(normalized.elements, appState, files);
          }
        }
        return;
      }
      if (isInitialHydration) {
        lastDurableFingerprintRef.current = durableFingerprint;
        return;
      }
      if (applyingRemoteRef.current || suppressFingerprintRef.current === fingerprint) {
        suppressFingerprintRef.current = null;
        localMutationArmedRef.current = false;
        lastDurableFingerprintRef.current = durableFingerprint;
        return;
      }
      if (commentModeRef.current && pointerSelectionPendingRef.current) {
        const selectedIds = Object.keys(appState.selectedElementIds || {}).filter(
          (id) => appState.selectedElementIds[id],
        );
        const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
        if (selectedId && selectedId !== lastSelectedIdRef.current) {
          const node = sceneElementNodes(boardId, elements, boardContextRef.current).find(
            (candidate) => candidate.boardAnchor.elementAnchor.elementId === selectedId,
          );
          if (node) dispatch(BOARD_SELECTION_EVENT, { target: node });
        }
        lastSelectedIdRef.current = selectedId;
        pointerSelectionPendingRef.current = false;
      }
      if (!localMutationArmedRef.current) return;
      localMutationArmedRef.current = false;
      if (lastDurableFingerprintRef.current === durableFingerprint) return;
      lastDurableFingerprintRef.current = durableFingerprint;
      emitScene(elements, appState, files);
    },
    [boardId, emitScene],
  );

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const update = () => setTheme(preferredTheme());
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const setMode = (event) => {
      const annotate = event.detail?.mode === "annotate";
      commentModeRef.current = annotate;
      lastSelectedIdRef.current = null;
      container.dataset.tweakloopWhiteboardCommentMode = String(annotate);
    };
    window.addEventListener(MODE_EVENT, setMode);
    return () => window.removeEventListener(MODE_EVENT, setMode);
  }, [container]);

  useEffect(() => {
    const armLocalMutation = () => {
      initialViewportFitPendingRef.current = false;
      if (initialViewportFitFrameRef.current !== null) {
        cancelAnimationFrame(initialViewportFitFrameRef.current);
        initialViewportFitFrameRef.current = null;
      }
      localMutationArmedRef.current = true;
    };
    container.addEventListener("pointerdown", armLocalMutation, true);
    container.addEventListener("keydown", armLocalMutation, true);
    container.addEventListener("paste", armLocalMutation, true);
    container.addEventListener("drop", armLocalMutation, true);
    return () => {
      container.removeEventListener("pointerdown", armLocalMutation, true);
      container.removeEventListener("keydown", armLocalMutation, true);
      container.removeEventListener("paste", armLocalMutation, true);
      container.removeEventListener("drop", armLocalMutation, true);
    };
  }, [container]);

  useEffect(
    () => () => {
      window.clearTimeout(changeTimerRef.current);
      if (initialViewportFitFrameRef.current !== null) {
        cancelAnimationFrame(initialViewportFitFrameRef.current);
      }
      registry.delete(boardId);
    },
    [boardId],
  );

  return (
    <Excalidraw
      initialData={initialData}
      excalidrawAPI={installApi}
      onChange={onChange}
      onPointerDown={() => {
        initialViewportFitPendingRef.current = false;
        if (initialViewportFitFrameRef.current !== null) {
          cancelAnimationFrame(initialViewportFitFrameRef.current);
          initialViewportFitFrameRef.current = null;
        }
        localMutationArmedRef.current = true;
        if (commentModeRef.current) pointerSelectionPendingRef.current = true;
      }}
      onDuplicate={(nextElements, previousElements) => {
        const previousIds = new Set(previousElements.map((element) => element.id));
        return nextElements.map((element) => {
          if (previousIds.has(element.id)) return element;
          return {
            ...element,
            customData: {
              ...element.customData,
              tweakloop: {
                ...(element.customData?.tweakloop || {}),
                schema: 1,
                anchorId: element.id,
              },
            },
          };
        });
      }}
      langCode="en"
      theme={theme}
      handleKeyboardGlobally={false}
      autoFocus={false}
      isCollaborating={false}
      UIOptions={{
        canvasActions: {
          changeViewBackgroundColor: true,
          clearCanvas: true,
          export: { saveFileToDisk: true },
          loadScene: true,
          saveAsImage: true,
          toggleTheme: true,
        },
      }}
    />
  );
}

function mountWhiteboard(container, boardId, scene, migratedFrom, boardContext) {
  const mount = document.createElement("div");
  mount.className = "tweakloop-whiteboard__mount";
  container.appendChild(mount);
  createRoot(mount).render(
    <Whiteboard
      container={container}
      boardId={boardId}
      boardContext={boardContext}
      initialScene={scene}
      migratedFrom={migratedFrom}
    />,
  );
}

for (const [index, container] of Array.from(
  document.querySelectorAll("[data-tweakloop-whiteboard]"),
).entries()) {
  const boardId =
    container.getAttribute("data-tweak-id") ||
    container.getAttribute("data-whiteboard-id") ||
    `whiteboard.${index + 1}`;
  if (!container.getAttribute("data-tweak-id")) container.setAttribute("data-tweak-id", boardId);
  if (!container.style.height && container.clientHeight < 240) container.style.height = "480px";
  try {
    const parsed = parseContainerScene(container, boardId);
    if (parsed.reference) {
      const reference = parsed.reference;
      let consumed = false;
      const pendingAdapter = {
        boardId,
        artifactId: reference.artifactId,
        revisionId: reference.revisionId,
        getNodes: () => [],
        getScene: () => null,
        loadScene: (rawScene, loadContext) => {
          if (consumed) {
            throw new WhiteboardDataError("Whiteboard host has already consumed its pinned scene");
          }
          if (!loadContext || typeof loadContext !== "object") {
            throw new WhiteboardDataError("Whiteboard load context is missing");
          }
          if (loadContext.whiteboardArtifactId !== reference.artifactId) {
            throw new WhiteboardDataError(
              "Loaded whiteboard artifact does not match the pinned host",
            );
          }
          if (loadContext.baseRevisionId !== reference.revisionId) {
            throw new WhiteboardDataError(
              "Loaded whiteboard revision does not match the pinned host",
            );
          }
          if (registry.get(boardId) !== pendingAdapter) {
            throw new WhiteboardDataError("Whiteboard host has already consumed its pinned scene");
          }
          const scene = restoreNativeScene(rawScene);
          const boardContext = {
            whiteboardArtifactId: reference.artifactId,
            baseRevisionId: reference.revisionId,
          };
          if (typeof loadContext.sceneHash === "string" && loadContext.sceneHash) {
            boardContext.sceneHash = loadContext.sceneHash;
          }
          if (typeof loadContext.draftId === "string" && loadContext.draftId) {
            boardContext.draftId = loadContext.draftId;
          }
          if (Number.isInteger(loadContext.draftVersion)) {
            boardContext.draftVersion = loadContext.draftVersion;
          }
          consumed = true;
          mountWhiteboard(container, boardId, scene, null, boardContext);
          return {
            boardAnchor: { semanticId: boardId, ...boardContext },
            elementCount: scene.elements.filter((element) => !element.isDeleted).length,
          };
        },
      };
      registry.set(boardId, pendingAdapter);
      container.dataset.tweakloopWhiteboardStatus = "waiting";
      const state = container.querySelector(".tweakloop-whiteboard__state span:last-child");
      if (state) state.textContent = "Loading pinned whiteboard…";
      dispatch(BOARD_READY_EVENT, { boardId, reference, nodes: [] });
      continue;
    }
    const boardContext = {
      whiteboardArtifactId:
        container.getAttribute("data-tweak-whiteboard-artifact") ||
        window.__TWEAKLOOP__?.artifactId ||
        undefined,
      baseRevisionId:
        container.getAttribute("data-tweak-whiteboard-revision") ||
        window.__TWEAKLOOP__?.revisionId ||
        undefined,
    };
    mountWhiteboard(container, boardId, parsed.scene, parsed.migratedFrom, boardContext);
  } catch (error) {
    errorState(container, error);
    console.error("tweakloop whiteboard: scene rejected", error);
  }
}
