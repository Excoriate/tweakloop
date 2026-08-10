const VIEW_ONLY_APP_STATE_FIELDS = new Set([
  "activeTool",
  "collaborators",
  "cursorButton",
  "cursorX",
  "cursorY",
  "editingElement",
  "editingGroupId",
  "editingLinearElement",
  "openDialog",
  "openMenu",
  "scrollX",
  "scrollY",
  "selectedElementIds",
  "selectedGroupIds",
  "selectedLinearElement",
  "selectionElement",
  "suggestedBindings",
  "zoom",
]);

export function durableWhiteboardAppState(
  appState: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(appState).filter(([key]) => !VIEW_ONLY_APP_STATE_FIELDS.has(key)),
  );
}
