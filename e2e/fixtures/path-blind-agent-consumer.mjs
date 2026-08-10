import { createHash } from "node:crypto";

const encodedConnection = process.env.TWEAKLOOP_CONSUMER_CONNECTION;
if (!encodedConnection) {
  process.stderr.write("missing TWEAKLOOP_CONSUMER_CONNECTION\n");
  process.exit(2);
}

const connection = JSON.parse(encodedConnection);
const suppressAttachments = process.argv.includes("--suppress-attachments");
const afterSeq = Number(connection.afterSeq ?? 0);
const query = new URLSearchParams({
  agent: connection.agentId,
  process: connection.processNonce,
  session: connection.sessionId,
});

const headers = { authorization: `Bearer ${connection.cliToken}` };
const eventsResponse = await fetch(`${connection.shellOrigin}/api/v1/events?after=${afterSeq}`, {
  headers,
});
if (!eventsResponse.ok) {
  process.stderr.write(`event replay failed (${eventsResponse.status})\n`);
  process.exit(2);
}

const replay = await eventsResponse.json();
const attachments = replay.filter(
  (event) =>
    !suppressAttachments &&
    event.eventType === "session.artifact-attached" &&
    event.payload?.sessionId === connection.sessionId,
);
if (attachments.length === 0) {
  process.stderr.write("no matching session.artifact-attached event\n");
  process.exit(3);
}

const snapshotResponse = await fetch(
  `${connection.shellOrigin}/api/v1/agent-session/snapshot?${query}`,
  { headers },
);
if (!snapshotResponse.ok) {
  process.stderr.write(`agent snapshot failed (${snapshotResponse.status})\n`);
  process.exit(2);
}

const snapshot = await snapshotResponse.json();
const attachedIds = new Set(attachments.map((event) => event.payload.artifactId));
const memberships = (snapshot.artifacts ?? []).filter((artifact) =>
  attachedIds.has(artifact.artifactId),
);
if (memberships.length !== attachedIds.size) {
  process.stderr.write("event and agent snapshot membership disagree\n");
  process.exit(4);
}

const artifacts = [];
for (const membership of memberships) {
  const hash = membership.currentEntryHash;
  const response = await fetch(
    `${connection.shellOrigin}/api/v1/revisions/${membership.currentRevisionId}/source`,
    { headers },
  );
  if (!response.ok) {
    process.stderr.write(`artifact fetch failed (${response.status})\n`);
    process.exit(5);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== hash) {
    process.stderr.write(`artifact hash mismatch for ${membership.artifactId}\n`);
    process.exit(6);
  }
  artifacts.push({
    artifactId: membership.artifactId,
    revisionId: membership.currentRevisionId,
    hash,
    name: membership.name,
    format: membership.format,
    attachedSeq: membership.attachedSeq,
    text: bytes.toString("utf8"),
  });
}

process.stdout.write(
  `${JSON.stringify({ sessionId: connection.sessionId, attachments: attachments.length, artifacts })}\n`,
);
