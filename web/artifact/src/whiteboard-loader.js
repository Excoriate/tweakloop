(() => {
  const containers = Array.from(document.querySelectorAll("[data-tweakloop-whiteboard]"));
  if (containers.length === 0) return;

  for (const container of containers) {
    container.dataset.tweakloopWhiteboardStatus = "loading";
    const state = document.createElement("div");
    state.className = "tweakloop-whiteboard__state";
    state.setAttribute("role", "status");
    state.setAttribute("aria-live", "polite");
    state.innerHTML =
      '<span class="tweakloop-whiteboard__pulse" aria-hidden="true"></span><span>Opening whiteboard…</span>';
    container.appendChild(state);
  }

  const base = new URL("./assets/", import.meta.url);
  window.EXCALIDRAW_ASSET_PATH = base.href;

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("runtime.css", base).href;
  css.dataset.tweakloopWhiteboardAsset = "styles";
  document.head.appendChild(css);

  import(new URL("runtime.js", base).href).catch((error) => {
    for (const container of containers) {
      container.dataset.tweakloopWhiteboardStatus = "error";
      const state = container.querySelector(".tweakloop-whiteboard__state");
      if (!state) continue;
      state.classList.add("tweakloop-whiteboard__state--error");
      state.setAttribute("role", "alert");
      state.innerHTML =
        "<strong>Whiteboard could not open</strong><span>The local editor bundle is unavailable. Your document is still safe.</span>";
    }
    console.error("tweakloop whiteboard: local Excalidraw bundle failed", error);
  });
})();
