/**
 * Tweakloop review shell (Phase 0). Reads the projection snapshot,
 * then follows committed events over SSE. All state shown here is
 * derived from durable facts — refreshing never changes workflow truth.
 */

const connectionBadge = document.getElementById("connection");
const workspaceEl = document.getElementById("workspace");
const artifactsTable = document.getElementById("artifacts");
const artifactsBody = artifactsTable.querySelector("tbody");
const artifactsEmpty = document.getElementById("artifacts-empty");
const timelineEl = document.getElementById("timeline");
const timelineEmpty = document.getElementById("timeline-empty");

let lastSeq = 0;

function setConnection(state, label) {
  connectionBadge.className = `badge badge-${state}`;
  connectionBadge.textContent = label;
}

function renderWorkspace(workspace) {
  workspaceEl.textContent =
    `workspace ${workspace.workspaceId} · project ${workspace.projectId} · ` +
    `protocol v${workspace.protocolVersion} · ${workspace.rootPath}`;
}

function renderArtifacts(artifacts) {
  artifactsBody.replaceChildren();
  for (const artifact of artifacts) {
    const row = document.createElement("tr");
    for (const value of [
      artifact.name,
      artifact.format,
      artifact.artifactId,
      artifact.sourcePath ?? "—",
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    }
    artifactsBody.appendChild(row);
  }
  artifactsTable.hidden = artifacts.length === 0;
  artifactsEmpty.hidden = artifacts.length > 0;
}

function appendTimeline(entry) {
  const item = document.createElement("li");
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `#${entry.seq} ${entry.recordedAt}`;
  item.appendChild(meta);
  item.appendChild(document.createTextNode(entry.summary ?? entry.eventType));
  timelineEl.prepend(item);
  timelineEmpty.hidden = true;
}

async function loadSnapshot() {
  const res = await fetch("/api/v1/snapshot");
  if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
  const snapshot = await res.json();
  lastSeq = snapshot.lastSeq;
  renderWorkspace(snapshot.workspace);
  renderArtifacts(snapshot.artifacts);
  timelineEl.replaceChildren();
  for (const entry of [...snapshot.timeline].reverse()) {
    appendTimeline(entry);
  }
  timelineEmpty.hidden = snapshot.timeline.length > 0;
}

function summarizeEvent(envelope) {
  const payload = envelope.payload ?? {};
  switch (envelope.eventType) {
    case "workspace.opened":
      return `workspace opened at ${payload.rootPath}`;
    case "artifact.registered":
      return `artifact "${payload.name}" registered (${payload.format})`;
    default:
      return envelope.eventType;
  }
}

function follow() {
  const source = new EventSource(`/api/v1/events?after=${lastSeq}`);
  source.onopen = () => setConnection("live", "live");
  source.onerror = () => setConnection("down", "reconnecting…");
  source.onmessage = (message) => {
    const envelope = JSON.parse(message.data);
    if (envelope.seq <= lastSeq) return;
    lastSeq = envelope.seq;
    appendTimeline({
      seq: envelope.seq,
      recordedAt: envelope.recordedAt,
      summary: summarizeEvent(envelope),
    });
    if (envelope.eventType === "artifact.registered") {
      loadSnapshot().catch(() => {});
    }
  };
}

loadSnapshot()
  .then(follow)
  .catch(() => setConnection("down", "unauthorized — use `tweak open`"));
