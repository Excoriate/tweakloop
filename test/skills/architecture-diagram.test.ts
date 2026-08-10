import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const readCanonical = (path: string) =>
  readFileSync(join(root, ".agents", "skills", "architecture-diagram", path), "utf8");
const skill = readCanonical("SKILL.md");
const cliSource = readFileSync(join(root, "src", "cli", "index.ts"), "utf8");
const executableCommands = [
  "tweak whiteboard scene add-node <document> <semanticKey> --session <id> --idempotency-key <key>",
  "tweak whiteboard scene add-edge <document> <semanticKey> --session <id> --idempotency-key <key> --from <semanticKey> --to <semanticKey>",
  "tweak whiteboard scene set-label <document> <target> --session <id> --idempotency-key <key> (--text <text>|--clear)",
  "tweak whiteboard scene group <document> <semanticKey> --session <id> --idempotency-key <key> --members <semanticKey...>",
  "tweak whiteboard scene layout <document> --session <id> --idempotency-key <key>",
  "tweak whiteboard scene inspect <document>",
  "tweak whiteboard scene publish <document> --idempotency-key <key>",
];

describe("thin architecture-diagram skill", () => {
  it("is capability-gated and authorizes only semantic operations", () => {
    expect(skill).toContain("tweak whiteboard scene --help");
    const allowed = ["node.upsert", "edge.upsert", "label.set", "group.set", "layout.apply"];
    for (const operation of allowed) expect(skill).toContain(operation);

    for (const forbidden of [
      '"elementId"',
      '"version"',
      '"nonce"',
      '"binding"',
      '"points"',
      "--payload",
    ]) {
      expect(skill).not.toContain(forbidden);
    }
    expect(skill).toContain("No other scene operation is authorized");
  });

  it("requires executable scene commands rather than an operation-name-only impostor", () => {
    for (const command of executableCommands) expect(skill).toContain(command);
    const operationNamesOnly =
      "node.upsert edge.upsert label.set group.set layout.apply inspect publish";
    expect(executableCommands.every((command) => operationNamesOnly.includes(command))).toBe(false);

    for (const required of [
      "--session <id>",
      "--idempotency-key <key>",
      "--from <semanticKey>",
      "--to <semanticKey>",
      "--members <semanticKey...>",
      "[--direction lr|tb]",
      "[--gap <number>]",
      "[--scope <semanticKey...>]",
    ]) {
      expect(skill).toContain(required);
    }
  });

  it("matches the settled current-source scene leaf ABI", () => {
    for (const leaf of [
      "add-node",
      "add-edge",
      "set-label",
      "group",
      "layout",
      "inspect",
      "publish",
    ]) {
      expect(cliSource).toContain(`.command("${leaf}`);
      expect(skill).toContain(`tweak whiteboard scene ${leaf}`);
    }
    for (const option of [
      '.requiredOption("--session <id>"',
      '.requiredOption("--idempotency-key <key>"',
      '.requiredOption("--from <semanticKey>"',
      '.requiredOption("--to <semanticKey>"',
      '.requiredOption("--members <semanticKey...>"',
    ]) {
      expect(cliSource).toContain(option);
    }
  });

  it("teaches cold-start-or-inspect, mutate, verify, layout, inspect, and publish", () => {
    const normalWorkflow = skill
      .split("### Normal agent workflow")[1]
      ?.split("## Coherence Oracle")[0];
    expect(normalWorkflow).toBeTruthy();
    expect(normalWorkflow?.match(/tweak whiteboard scene inspect <document>/g)).toHaveLength(3);
    expect(normalWorkflow).toContain("ONLY error.code=whiteboard.draft-missing");
    expect(normalWorkflow).toMatch(
      /add-node <document> browser[^\n]+\n+tweak whiteboard scene inspect <document> --json/,
    );
    expect(normalWorkflow).toContain("tweak whiteboard scene layout <document>");
    expect(normalWorkflow).toContain("tweak whiteboard scene publish <document>");
    expect(normalWorkflow).toMatch(
      /tweak whiteboard scene publish <document>[^\n]+\n+tweak session url <session-id> --document <document> --json/,
    );
    expect(normalWorkflow).not.toMatch(/^tweak open\b/m);
    expect(normalWorkflow).not.toContain("--x");
    expect(normalWorkflow).not.toContain("--y");
    expect(normalWorkflow).toContain("human review");
  });

  it("does not mistake cold start for missing capability or expose private inspect state", () => {
    expect(skill).toContain("Exactly one failure has");
    expect(skill).toContain("error.code` is `whiteboard.draft-missing");
    expect(skill).toContain("published whiteboard attached to the active session");
    expect(skill).toContain("second inspect MUST succeed");
    expect(skill).toContain("Every other inspect failure");
    expect(skill).toContain("`protocol`, `artifactId`, and the semantic `scene` collections");
    expect(skill).not.toContain(
      "artifact, draft, base revision, version, scene hash, and semantic map",
    );
  });

  it("keeps artifact and coherence oracles distinct", () => {
    expect(skill).toContain("**Artifact oracle:**");
    expect(skill).toContain("**Coherence oracle:**");
    expect(skill).toContain("plausibly wrong");
    expect(skill).toContain("swaps one edge direction");
  });

  it("freezes exact semantic keys and never labels a membership-only group", () => {
    expect(skill).toMatch(/Freeze this exact key ledger before the\s+first mutation/);
    expect(skill).toMatch(/copied from\s+that frozen ledger/);
    expect(skill).toContain("It NEVER targets `scene.groups`");
    expect(skill).toContain("latest successful inspect");
    expect(skill).toContain("order-service-boundary");
    expect(skill).toContain("locked, unlabeled enclosure");
    expect(skill).toContain("visible text naming the container is essential");
    expect(skill).toMatch(/current semantic\s+group capability is insufficient/);

    const specimen = readCanonical("examples/service-topology/README.md");
    expect(specimen).toContain("group has membership but no public label field");
    expect(specimen).toContain("one locked, unlabeled");
    expect(specimen).not.toMatch(/set-label <document> service-runtime/);
    expect(specimen).not.toMatch(/set-label <document> service\b/);
  });

  it("ships 5+5, wrong-neighbor, and ablation controls", () => {
    const routing = readCanonical("examples/routing-calibration/README.md");
    expect(routing.match(/^[1-5]\. “/gm)).toHaveLength(10);
    expect(routing).toContain("## Wrong neighbor");
    const ablations = readCanonical("examples/ablations/README.md");
    for (const section of [
      "Mental Model",
      "Decision Core",
      "Heuristic Chain",
      "Generator Route",
      "Executable CLI grammar",
      "Coherence Oracle",
      "Truthful Fallback",
      "Native-wrapper discovery",
      "Scene-builder capability",
    ]) {
      expect(ablations).toContain(`| ${section} |`);
    }
  });

  it("has design, claim ledger, compact HTML view, and truthful fallback", () => {
    const design = readCanonical("skill-design.md");
    expect(design).toContain("## Evidence ledger");
    expect(design).toContain("## Native Shape");
    expect(design).toContain("CALIBRATION-WAIVED:");
    const html = readCanonical("skill-design.html");
    for (const section of ["masthead", "thesis", "invariant", "resources", "ledger", "signoff"]) {
      expect(html).toContain(`data-sd-section="${section}"`);
    }
    expect(skill).toMatch(/not an editable\s+whiteboard/);
  });

  it("ships a command-complete golden specimen", () => {
    const specimen = readCanonical("examples/service-topology/README.md");
    for (const command of [
      "add-node <document> browser --session <session-id> --idempotency-key service-topology-node-browser",
      "set-label <document> api --session <session-id> --idempotency-key service-topology-label-api --text",
      "add-edge <document> browser-calls-api --session <session-id> --idempotency-key service-topology-edge-browser-api --from browser --to api",
      "group <document> service-runtime --session <session-id> --idempotency-key service-topology-group-runtime --members api database",
      "layout <document> --session <session-id> --idempotency-key service-topology-layout-main --direction lr --gap 96",
      "publish <document> --idempotency-key service-topology-publish --agent <agent-id>",
      "session url <session-id> --document <document> --json",
    ]) {
      expect(specimen).toContain(command);
    }
    expect(specimen.match(/tweak whiteboard scene inspect <document>/g)).toHaveLength(3);
    expect(specimen).toContain("error.code=whiteboard.draft-missing");
    expect(specimen).not.toContain(" --x ");
    expect(specimen).not.toContain(" --y ");
    expect(specimen).toContain("Publication is not");
  });
});
