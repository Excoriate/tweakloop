import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const readSkill = (path: string) => readFileSync(join(root, "skills", path), "utf8");
const tweakloop = readSkill("tweakloop/SKILL.md");
const authoring = readSkill("tweakloop/references/authoring-html.md");
const chat = readSkill("tweakloop/references/chat-and-attachments.md");
const liveProgress = readSkill("tweakloop/references/live-progress.md");
const handoff = readSkill("tweakloop/references/session-handoff.md");
const workspace = readSkill("tweakloop/references/workspace-export-restore.md");
const recovery = readSkill("tweakloop/references/recovery-and-inspection.md");
const excalidraw = readSkill("excalidraw/SKILL.md");
const architecture = readSkill("architecture-diagram/SKILL.md");
const htmlStarter = readSkill("tweakloop/assets/minimal-plan-starter.html");

describe("fresh-agent resident workflow contract", () => {
  it("fits the resident budget without deleting the invocation or identity gates", () => {
    expect(Buffer.byteLength(tweakloop, "utf8")).toBeLessThanOrEqual(6_000);

    const checkout = tweakloop.indexOf("in a source checkout");
    const build = tweakloop.indexOf("run `just build`");
    const localDist = tweakloop.indexOf("node <repo-root>/dist/cli/index.js");
    const installed = tweakloop.indexOf("use installed `tweak`");
    const identity = tweakloop.indexOf("resolve durable identity before authoring or overwriting");
    const mutation = tweakloop.indexOf("ordinary five-step review loop");

    expect(checkout).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(checkout);
    expect(localDist).toBeGreaterThan(build);
    expect(installed).toBeGreaterThan(localDist);
    expect(tweakloop).toContain("Build failure stops");
    expect(tweakloop).toContain("NEVER** fall back");
    expect(tweakloop).toContain("Resolve one absolute workspace root");
    expect(tweakloop).toContain("status --summary --json`");
    expect(tweakloop).toContain("`running`: preserve it");
    expect(tweakloop).toContain("source build alone\n   **NEVER** authorizes restart");
    expect(tweakloop).toContain("`stopped`: run");
    expect(tweakloop).toContain("`daemon start --json`");
    expect(tweakloop).toContain("Explicit incompatibility: restart");
    expect(tweakloop).toContain("the old shell is stale");
    expect(tweakloop).toContain("Health ≠ generation parity");
    expect(tweakloop).toContain("retain both");
    expect(identity).toBeGreaterThan(installed);
    expect(mutation).toBeGreaterThan(identity);
    expect(tweakloop).toContain("tweak artifacts list --json");
    expect(tweakloop).toContain(
      "tweak session list --document <exact-intended-path-or-artifact-id>",
    );
    expect(tweakloop).toContain("same logical document stays on");
    expect(tweakloop).toContain("unregistered path and new artifact ID");
  });

  it("keeps the finite ordinary loop, explicit chat receipt, and human decision boundary resident", () => {
    const orderedSteps = [
      "1. **Open.**",
      "2. **Receive or claim.**",
      "3. **Revise under the live-turn gate.**",
      "4. **Publish and complete.**",
      "5. **Wait for the human decision.**",
    ];
    let cursor = -1;
    for (const step of orderedSteps) {
      const next = tweakloop.indexOf(step);
      expect(next, `missing or unordered ${step}`).toBeGreaterThan(cursor);
      cursor = next;
    }

    expect(tweakloop).toContain("tweak next --session <sessionId> --wait --timeout 300000 --json");
    expect(tweakloop).toContain("Execute chat `acknowledgeCommand` exactly");
    expect(tweakloop).toContain("persistent daemon/TUI or live board stream");
    expect(tweakloop).toContain("--presence working --until-work-settled <workId>");
    expect(tweakloop).toContain("claiming live Working, not durable work");
    expect(tweakloop).toContain("nonempty intent IDs become addressed");
    expect(tweakloop).toMatch(/Heartbeat is\s+never progress/);
    expect(tweakloop).toContain(
      "tweak publish <file> --complete <workId> --summary <truthful-intent-account> --json",
    );
    expect(tweakloop).toContain("human Accept");
  });

  it("keeps question ordering, sourcePath-null identity, typed intent, and honesty resident", () => {
    expect(tweakloop).toContain("Ordinary content preference waits until revision 1");
    expect(tweakloop).toContain("identity, authority, missing");
    expect(tweakloop).toContain("2–8 option choice");
    expect(tweakloop).toContain("If `sourcePath` is null");
    expect(tweakloop).toMatch(/a fetched path is\s+not identity/);

    for (const intent of [
      "`comment`; `question`",
      "`replace-text`",
      "`add-constraint`",
      "`remove`, `move`, `choose`, `reject-option`",
      "`approve-node`; `request-implementation`; `reopen`",
    ]) {
      expect(tweakloop, `missing resident intent obligation ${intent}`).toContain(intent);
    }
    expect(tweakloop).toContain("Account for every `intentId`");
    expect(tweakloop).toMatch(/Complete only\s+after durable publication/);
    expect(tweakloop).toContain("A receipt is not comprehension or human acceptance");
  });

  it("keeps board protocol out of core and routes to the authoritative Excalidraw skill", () => {
    expect(tweakloop).toContain("[Excalidraw](../excalidraw/SKILL.md)");
    expect(tweakloop).toContain("[architecture-diagram](../architecture-diagram/SKILL.md)");
    for (const forbidden of [
      "whiteboard draft put",
      "expected-draft-version",
      "sync-state sidecar",
      "whiteboard workspace checkout",
      "whiteboard workspace sync",
    ]) {
      expect(tweakloop).not.toContain(forbidden);
    }

    expect(excalidraw).toContain("Prefer the live Tweakloop canvas");
    expect(excalidraw).toContain('editRoute.kind: "native-excalidraw-editor"');
    expect(excalidraw).toContain("BLOCKED: native Excalidraw editor");
    expect(excalidraw).toContain("NEVER synthesize those raw objects");
    expect(excalidraw).toContain("tweak whiteboard workspace sync <fresh-scratch.excalidraw>");
    expect(architecture).toContain("tweak whiteboard scene --help");
    expect(architecture).toContain("BLOCKED: semantic scene capability unavailable or unconfirmed");
  });
});

describe("on-demand reference contracts", () => {
  it("keeps semantic authoring and browser truth in authoring-html only", () => {
    for (const requirement of [
      "../assets/minimal-plan-starter.html",
      "data-tweak-id",
      "data-tweak-kind",
      "tweak lint <file> --json",
      "tweak diff <file> --json",
      "tweak check <file> --json",
      "browser truth surface",
      "no CDN, remote font, tracking, or network dependency",
    ]) {
      expect(authoring, `missing authoring requirement ${requirement}`).toContain(requirement);
    }
    expect(authoring).toContain("explicit empty baseline");
    expect(authoring).toContain("`artifactId` and `beforeRevisionId` are null");
    expect(authoring).toContain("explicit unknown\n`--artifact` still fails");
    expect(authoring).not.toContain("tweak workspace export");
    expect(authoring).not.toContain("tweak chat send");

    expect(htmlStarter).toContain('data-tweak-id="plan.decision"');
    expect(htmlStarter).toContain("<details");
    expect(htmlStarter).toContain("@media (max-width: 720px)");
    expect(htmlStarter).not.toMatch(/https?:\/\//);
    expect(htmlStarter).not.toContain("<script");
  });

  it("keeps acknowledgement, presence, lease, progress, completion, and acceptance distinct", () => {
    expect(tweakloop).toContain("[`live-progress.md`](references/live-progress.md)");
    expect(liveProgress).toContain("A receipt alone must never produce `working`");
    expect(liveProgress).toContain("presence thinking");
    expect(liveProgress).toContain("presence working");
    expect(liveProgress).toContain("presence idle");
    expect(liveProgress).toContain("--presence working --until-work-settled <workId>");
    expect(liveProgress).toContain("Start failure is\n   non-authoritative");
    expect(liveProgress).toContain("current daemon origin");
    expect(liveProgress).toContain("old port after an explicit restart is stale-generation");
    expect(liveProgress).toContain("Nonempty intent IDs become\n   durably addressed");
    expect(liveProgress).toContain("tweak work heartbeat <workId>");
    expect(liveProgress).toContain("tweak work progress <workId>");
    expect(liveProgress).toContain("Heartbeat renews authority only");
    expect(liveProgress).toContain("Never emit timer-, hook-, token-, or");
    expect(liveProgress).toContain("Human acceptance remains a later human fact");
    expect(liveProgress).toContain("Every nonzero heartbeat, progress, publication, or completion");
    expect(chat).not.toContain("tweak work progress");
  });

  it("preserves chat context and intentional attachment disclosure only in the chat reference", () => {
    expect(chat).toContain("tweak chat send");
    expect(chat).toContain("--from-work <workId>");
    expect(chat).toContain("every selection-bearing intent");
    expect(chat).toContain("Attachments are intentional disclosure");
    expect(chat).toContain("tweak chat attachment fetch");
    expect(chat).toContain("tweak chat promote <messageId>");
    expect(chat).not.toContain("tweak workspace restore");
    expect(chat).not.toContain("whiteboard workspace");
  });

  it("separates session lineage, workspace reconstruction, and recovery", () => {
    expect(handoff).toContain("tweak session show <sessionId>");
    expect(handoff).toContain("sourcePath: null");
    expect(handoff).toContain("--artifact <artifactId> --session <sessionId>");
    expect(handoff).toContain("tweak session handoff");
    expect(handoff).toContain("tweak session resume");
    expect(handoff).not.toContain("tweak workspace export");

    expect(workspace).toContain("tweak workspace export <new-directory>");
    expect(workspace).toContain("tweak workspace restore <saved-directory>");
    expect(workspace).toContain("tweak workspace fork <bundle-directory>");
    expect(workspace).toContain("--operation <stable-id>");
    expect(workspace).toContain("event-seq-exact");
    expect(workspace).toContain("quiescent-verified");
    expect(workspace).toContain("not a kernel-atomic filesystem snapshot");
    expect(workspace).toContain("ABA change");
    expect(workspace).toContain("tweak workspace restore-inventory --json");
    expect(workspace).toContain("tweak workspace restore-compact");
    expect(workspace).not.toContain("save an immutable, hash-verified workspace snapshot");
    expect(workspace).not.toContain("tweak session resume");

    expect(recovery).toContain("exact recovery or");
    expect(recovery).toContain("recompute command returned");
    expect(recovery).toContain("stale `nextAction` must fail before mutation");
    expect(recovery).toContain("runtime-capability.daemon-generation-changed");
    expect(recovery).toContain("reports `details.mutated:false`");
    expect(recovery).toContain("returned successor `sessionId`");
    expect(recovery).toContain("same business key");
    expect(recovery).toContain("generic identity/custody mismatch");
    expect(recovery).toContain("tweak work recover");
    expect(recovery).toContain("tweak restore <revisionId>");
    expect(recovery).not.toContain("tweak open <file>");
  });
});
