import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { projectWhiteboardSceneInspect } from "../../src/cli/whiteboard-scene-inspect.js";
import type {
  SemanticSceneEntity,
  SemanticSceneGroup,
  SemanticSceneMap,
} from "../../src/whiteboard/semantic-representation.js";

type OutputClass = "finite" | "jsonl";

type LeafRecord = Readonly<{
  path: string;
  usage: string;
  purpose: string;
  output: OutputClass;
}>;

type InvocationContract = Readonly<{
  order: readonly ["checkout", "installed", "npx"];
  checkout: readonly ["node", "dist/cli/index.js"];
  checkoutAlternative: readonly ["pnpm", "tweak"];
  installed: readonly ["tweak"];
  npx: readonly ["npx", "-y", "tweakloop"];
  npxInvocationEnv: readonly ["npx", "-y", "tweakloop"];
  registryAvailability: "unverified";
}>;

type SceneInspectContract = Readonly<{
  protocol: "tweakloop.whiteboard-scene-inspect/v1";
  topLevelFields: readonly string[];
  sceneFields: readonly string[];
  nodeFields: readonly string[];
  edgeFields: readonly string[];
  groupFields: readonly string[];
  ordering: "semanticKey";
  forbiddenFields: readonly string[];
}>;

type HelpInspection = Readonly<{
  path: string;
  usage: string;
  identity: string;
  purpose: string;
  isGroup: boolean;
  children: readonly string[];
}>;

type SourceInspection = HelpInspection &
  Readonly<{
    implementation: string;
  }>;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "dist/cli/index.js");
const referencePath = join(root, "docs/cli-reference.md");
const readmePath = join(root, "README.md");
const implementationStatusPath = join(root, "docs/architecture/16-implementation-status.md");
const registrarPaths = [
  join(root, "src/cli/index.ts"),
  join(root, "src/cli/inbound-commands.ts"),
  join(root, "src/cli/question-commands.ts"),
  join(root, "src/cli/native-hook-commands.ts"),
] as const;

let markdown = "";
let records: readonly LeafRecord[] = [];
let invocation: InvocationContract;
let discoveredLeaves: readonly string[] = [];
let discoveredNodeCount = 0;
let readme = "";
let implementationStatus = "";
let sceneInspectContract: SceneInspectContract;
const sourceByPath = new Map<string, SourceInspection>();
const helpByPath = new Map<string, HelpInspection>();
const verifyPackagedHelp = process.env.TWEAKLOOP_VERIFY_PACKAGED_HELP === "1";

beforeAll(() => {
  markdown = readFileSync(referencePath, "utf8");
  readme = readFileSync(readmePath, "utf8");
  implementationStatus = readFileSync(implementationStatusPath, "utf8");
  records = parseLeafRecords(markdown);
  invocation = parseInvocationContract(markdown);
  sceneInspectContract = parseSceneInspectContract(markdown);
  const discovered = discoverSourceTree();
  discoveredLeaves = discovered.leaves;
  discoveredNodeCount = discovered.nodeCount;
}, 30_000);

describe("public CLI reference parity", () => {
  it("documents every current-source public leaf exactly once", () => {
    const documented = records.map((record) => record.path).sort();
    expect(documented).toEqual([...discoveredLeaves].sort());
    expect(discoveredLeaves).toHaveLength(69);
    expect(discoveredNodeCount).toBe(86);
    expect(markdown).toMatch(/all 69 public leaf commands/);
    expect(readme).toContain("[complete CLI reference](docs/cli-reference.md)");
    expect(readme).not.toMatch(/all \d+ public leaf commands/);
    expect(`${markdown}\n${readme}`).not.toMatch(/all 52 public leaf commands/);
    expect(`${markdown}\n${readme}`).not.toMatch(/all 65 public leaf commands/);
    expect(`${markdown}\n${readme}`).not.toMatch(/all 67 public leaf commands/);
    expect(markdown).not.toContain("save an immutable, hash-verified workspace snapshot");
    expect(markdown).toContain("quiescent-verified");
    expect(markdown).toContain("event-seq-exact");
    expect(markdown).toContain("not a kernel-atomic filesystem snapshot");
    const packageStatus = implementationStatus;
    expect(implementationStatus).toContain("Current source and rebuilt package help");
    expect(implementationStatus).toContain(
      "current local build and opt-in package-help check prove checkout source",
    );
    expect(packageStatus).toMatch(/do(?:es)? not prove (?:npm )?registry publication/);
  });

  it("resolves every documented record to the exact current-source usage and purpose", () => {
    for (const record of records) {
      const inspection = resolveSourceLeaf(record.path);
      expect(record.usage, record.path).toBe(inspection.usage);
      expect(normalizeWhitespace(record.purpose), record.path).toBe(inspection.purpose);
      expect(markdown).toContain(`### \`tweak ${record.path}\``);
    }
  });

  it("classifies only the two persistent stdout streams as JSONL", () => {
    expect(jsonlPaths(records)).toEqual(["chat listen", "session listen"]);

    const wrong = records.map((record) =>
      record.path === "chat listen" ? { ...record, output: "finite" as const } : record,
    );
    expect(() => assertOutputClasses(wrong)).toThrow(/chat listen/);
  });

  it("documents process-backed claimed-work liveness without inventing progress", () => {
    for (const marker of [
      "--presence <listening|thinking|working>",
      "--until-work-settled <workId>",
      "Socket liveness never",
      "Listener failure is non-authoritative",
    ]) {
      expect(markdown).toContain(marker);
    }
    expect(implementationStatus).toContain("without creating `work.progressed`");
  });

  it("fails closed on malformed help rows and distinguishes a group from its children", () => {
    const fixture = [
      "Usage: tweak sample [options] [command]",
      "",
      "sample group",
      "",
      "Commands:",
      "  alpha           first child",
      "  beta [options]  second child with a wrapped",
      "                  description",
      "  helpful         a real command whose name starts with help",
      "  help [command]  display help for command",
    ].join("\n");
    expect(parseImmediateCommands(fixture)).toEqual(["alpha", "beta", "helpful"]);

    const malformed = fixture.replace("  beta [options]", "   beta [options]");
    expect(() => parseImmediateCommands(malformed)).toThrow(/indentation|unparsed/i);

    expect(() => resolveSourceLeaf("daemon")).toThrow(/group/i);
  });

  it("rejects source groups and positional-argument phantoms", () => {
    expect(() => resolveSourceLeaf("daemon bogus")).toThrow(/unknown current-source leaf/i);
    expect(() => resolveSourceLeaf("lint bogus")).toThrow(/unknown current-source leaf/i);
  });

  it("diagnoses omissions, phantoms, duplicates, and malformed records independently", () => {
    expect(parityDelta(["init", "status"], ["init", "phantom"])).toEqual({
      undocumented: ["status"],
      uncallable: ["phantom"],
    });

    const firstRecord = markdown
      .split("\n")
      .find((line) => line.startsWith("<!-- cli-reference-leaf "));
    expect(firstRecord).toBeDefined();
    expect(() => parseLeafRecords(`${markdown}\n${firstRecord}\n`)).toThrow(/duplicate/i);
    expect(() =>
      parseLeafRecords(
        '<!-- cli-reference-leaf {"path":"init","usage":"tweak init [options]"} -->',
      ),
    ).toThrow(/complete|keys|output|purpose/i);
    expect(() => parseLeafRecords("<!-- cli-reference-leaf not-json -->")).toThrow(/malformed/i);
  });

  it("keeps the checkout-first, installed-second, npx-fallback invocation contract exact", () => {
    expect(invocation).toEqual({
      order: ["checkout", "installed", "npx"],
      checkout: ["node", "dist/cli/index.js"],
      checkoutAlternative: ["pnpm", "tweak"],
      installed: ["tweak"],
      npx: ["npx", "-y", "tweakloop"],
      npxInvocationEnv: ["npx", "-y", "tweakloop"],
      registryAvailability: "unverified",
    });

    expect(markdown).toContain(
      "inside the checkout, replace that prefix with `node dist/cli/index.js`",
    );
    expect(readme).toContain("node dist/cli/index.js");
    expect(markdown).toContain("npx -y tweakloop");
    expect(normalizeWhitespace(markdown)).toContain(
      "session list --document <intended-path> --json",
    );
  });

  it("separates generated-session open from explicit-ID creation and existing-session open", () => {
    const openImplementation = resolveSourceLeaf("open").implementation;
    expect(openImplementation).toContain("if (opts.session)");
    expect(openImplementation).toContain(
      'fail("--title and --goal only apply when creating a new session"',
    );
    expect(openImplementation).toContain("getSession(connection, opts.session)");
    expect(openImplementation).toContain("openArtifactInSession(connection");

    const reference = normalizeWhitespace(markdown);
    expect(reference).toContain("`--session <id>` targets an existing active session only");
    expect(reference).toContain("For a caller-selected new session ID, use the explicit lifecycle");
    expect(reference).toContain("session start <path> --agent <id> --session-id <new-session-id>");
    expect(reference).not.toContain(
      "--session <id> supplies a stable session ID; otherwise one is generated",
    );
  });

  it("pins all seven semantic scene leaves and their finite, semantic-only public contract", () => {
    const expected = [
      "whiteboard scene add-node",
      "whiteboard scene add-edge",
      "whiteboard scene set-label",
      "whiteboard scene group",
      "whiteboard scene layout",
      "whiteboard scene inspect",
      "whiteboard scene publish",
    ];
    expect(
      records
        .filter((record) => record.path.startsWith("whiteboard scene "))
        .map((record) => record.path),
    ).toEqual(expected);
    for (const path of expected) {
      expect(resolveSourceLeaf(path).purpose).toBe(
        records.find((record) => record.path === path)?.purpose,
      );
      expect(records.find((record) => record.path === path)?.output).toBe("finite");
    }
    for (const path of expected.slice(0, 5)) {
      const implementation = resolveSourceLeaf(path).implementation;
      expect(implementation, path).toContain('.requiredOption("--session <id>"');
      expect(implementation, path).toContain('.requiredOption("--idempotency-key <key>"');
      expect(implementation, path).toContain("runSemanticSceneMutation");
    }
    expect(resolveSourceLeaf("whiteboard scene inspect").implementation).not.toContain(
      "runSemanticSceneMutation",
    );
    expect(resolveSourceLeaf("whiteboard scene publish").implementation).toContain(
      '.requiredOption("--idempotency-key <key>"',
    );
    expect(normalizeWhitespace(markdown)).toContain(
      "no raw Excalidraw element, renderer bookkeeping, or authority fields",
    );
  });

  it("pins the closed scene-inspect ABI and rejects additive private fields", () => {
    expect(sceneInspectContract).toEqual({
      protocol: "tweakloop.whiteboard-scene-inspect/v1",
      topLevelFields: ["protocol", "artifactId", "scene"],
      sceneFields: ["nodes", "edges", "groups"],
      nodeFields: ["semanticKey", "kind", "shape", "label", "bounds", "deleted"],
      edgeFields: ["semanticKey", "kind", "from", "to", "label", "bounds", "deleted"],
      groupFields: ["semanticKey", "members"],
      ordering: "semanticKey",
      forbiddenFields: [
        "draftId",
        "baseRevisionId",
        "draftVersion",
        "sceneHash",
        "semanticMap",
        "anchorId",
        "elementId",
        "elementSeed",
        "elementVersion",
        "elementVersionNonce",
        "labelElementId",
        "labelSeed",
        "labelVersion",
        "labelVersionNonce",
        "retiredElements",
        "groupId",
      ],
    });

    const projection = projectWhiteboardSceneInspect("artifact_public", sceneInspectFixture());
    assertClosedSceneInspect(projection, sceneInspectContract);
    expect(projection.scene.nodes.map((node) => node.semanticKey)).toEqual(["node-a", "node-z"]);
    expect(projection.scene.edges.map((edge) => edge.semanticKey)).toEqual(["edge-a", "edge-z"]);
    expect(projection.scene.groups.map((group) => group.semanticKey)).toEqual([
      "group-a",
      "group-z",
    ]);

    expect(() =>
      assertClosedSceneInspect(
        { ...projection, sceneHash: "private-scene-hash" },
        sceneInspectContract,
      ),
    ).toThrow(/top-level fields/i);
    expect(() =>
      assertClosedSceneInspect(
        {
          ...projection,
          scene: {
            ...projection.scene,
            nodes: [{ ...projection.scene.nodes[0], elementId: "renderer-id" }],
          },
        },
        sceneInspectContract,
      ),
    ).toThrow(/node fields/i);
  });

  it("pins browser-derived human authority without erasing explicit agent CLI paths", () => {
    const authority = parseHumanAuthorityContract(markdown);
    expect(authority).toEqual({
      errorCode: "human.browser-required",
      mutated: false,
      nextAction: "session url <sessionId>",
      alwaysBrowser: ["decision accept", "decision reopen", "review submit-comments"],
      conditionalBrowser: ["chat send", "chat promote"],
      agentCli: ["chat send", "chat promote", "work create-from-intents"],
      acceptedWorkReopen: "work.accepted-browser-required",
    });
    for (const path of authority.alwaysBrowser) {
      const implementation = resolveSourceLeaf(path).implementation;
      expect(implementation, path).toContain("requireHumanBrowser");
      expect(implementation, path).not.toContain("postCommand(");
    }
    for (const path of authority.conditionalBrowser) {
      const implementation = resolveSourceLeaf(path).implementation;
      expect(implementation, path).toContain("requireHumanBrowser");
      expect(implementation, path).toContain("postCommand(");
    }
    expect(markdown).toContain("`human.browser-required`");
    expect(markdown).toContain("`mutated: false`");
    expect(markdown).toContain("`work.accepted-browser-required`");
  });

  it.runIf(verifyPackagedHelp)(
    "matches the rebuilt package help tree after the final root build",
    () => {
      const built = discoverBuiltTree();
      expect([...built.leaves].sort()).toEqual([...discoveredLeaves].sort());
      expect(built.nodeCount).toBe(discoveredNodeCount);
      for (const record of records) {
        const inspection = resolveBuiltLeaf(record.path.split(" "));
        expect(inspection.usage, record.path).toBe(record.usage);
        expect(inspection.purpose, record.path).toBe(normalizeWhitespace(record.purpose));
      }
    },
    30_000,
  );
});

function parseLeafRecords(source: string): readonly LeafRecord[] {
  const candidateLines = source
    .split("\n")
    .filter((line) => line.includes("<!-- cli-reference-leaf"));
  const recordPattern = /^<!-- cli-reference-leaf (\{.*\}) -->$/;
  const parsed = candidateLines.map((line) => {
    const match = recordPattern.exec(line);
    if (!match?.[1]) throw new Error(`malformed CLI reference record: ${line}`);
    let value: unknown;
    try {
      value = JSON.parse(match[1]);
    } catch {
      throw new Error(`malformed CLI reference JSON: ${line}`);
    }
    return validateLeafRecord(value);
  });
  const unique = new Set(parsed.map((record) => record.path));
  if (unique.size !== parsed.length) throw new Error("duplicate CLI reference leaf record");
  assertOutputClasses(parsed);
  return parsed;
}

function validateLeafRecord(value: unknown): LeafRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CLI reference record must be a complete object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "output,path,purpose,usage") {
    throw new Error(`CLI reference record has incomplete or unknown keys: ${keys.join(",")}`);
  }
  if (
    typeof record.path !== "string" ||
    record.path.trim() === "" ||
    typeof record.usage !== "string" ||
    !record.usage.startsWith("tweak ") ||
    typeof record.purpose !== "string" ||
    record.purpose.trim() === "" ||
    (record.output !== "finite" && record.output !== "jsonl")
  ) {
    throw new Error("CLI reference record requires path, usage, purpose, and output");
  }
  return {
    path: record.path,
    usage: record.usage,
    purpose: record.purpose,
    output: record.output,
  };
}

function parseInvocationContract(source: string): InvocationContract {
  const match = /```json cli-invocation-contract\n([\s\S]*?)\n```/.exec(source);
  if (!match?.[1]) throw new Error("missing canonical CLI invocation contract");
  return JSON.parse(match[1]) as InvocationContract;
}

function parseSceneInspectContract(source: string): SceneInspectContract {
  const match = /```json cli-whiteboard-scene-inspect-contract\n([\s\S]*?)\n```/.exec(source);
  if (!match?.[1]) throw new Error("missing whiteboard scene-inspect contract");
  return JSON.parse(match[1]) as SceneInspectContract;
}

function assertClosedSceneInspect(value: unknown, contract: SceneInspectContract): void {
  assertExactObjectFields(value, contract.topLevelFields, "top-level fields");
  const output = value as Record<string, unknown>;
  if (output.protocol !== contract.protocol) throw new Error("unexpected inspect protocol");
  assertExactObjectFields(output.scene, contract.sceneFields, "scene fields");
  const scene = output.scene as Record<string, unknown>;
  const nodes = assertArray(scene.nodes, "scene nodes");
  const edges = assertArray(scene.edges, "scene edges");
  const groups = assertArray(scene.groups, "scene groups");
  for (const node of nodes) assertExactObjectFields(node, contract.nodeFields, "node fields");
  for (const edge of edges) assertExactObjectFields(edge, contract.edgeFields, "edge fields");
  for (const group of groups) assertExactObjectFields(group, contract.groupFields, "group fields");

  for (const collection of [nodes, edges, groups]) {
    const keys = collection.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("inspect collection item must be an object");
      }
      const semanticKey = (item as Record<string, unknown>).semanticKey;
      if (typeof semanticKey !== "string") throw new Error("inspect item lacks semanticKey");
      return semanticKey;
    });
    expect(keys).toEqual([...keys].sort());
  }

  const recursive = recursiveObjectKeys(value);
  for (const forbidden of contract.forbiddenFields) {
    if (recursive.includes(forbidden)) throw new Error(`forbidden inspect field: ${forbidden}`);
  }
  const privatePattern = recursive.filter((key) =>
    /(seed|nonce|version|authority|path|url)/i.test(key),
  );
  if (privatePattern.length > 0) {
    throw new Error(`private inspect fields: ${privatePattern.join(", ")}`);
  }
}

function assertExactObjectFields(value: unknown, expected: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must belong to an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\n") !== wanted.join("\n")) {
    throw new Error(`${label}: expected ${wanted.join(", ")}; observed ${actual.join(", ")}`);
  }
}

function assertArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function recursiveObjectKeys(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(recursiveObjectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...recursiveObjectKeys(nested)]);
}

function sceneInspectFixture(): SemanticSceneMap {
  const node = (semanticKey: string): SemanticSceneEntity => ({
    semanticKey,
    kind: "node",
    anchorId: `private-anchor-${semanticKey}`,
    elementId: `private-element-${semanticKey}`,
    labelElementId: `private-label-${semanticKey}`,
    deleted: false,
    label: semanticKey,
    shape: "rectangle",
    from: null,
    to: null,
    bounds: { x: 1, y: 2, width: 3, height: 4 },
    elementVersion: 1,
    elementVersionNonce: 2,
    elementSeed: 3,
    labelVersion: 4,
    labelVersionNonce: 5,
    labelSeed: 6,
    retiredElements: [
      {
        elementId: `private-retired-${semanticKey}`,
        elementType: "rectangle",
        role: "primary",
        version: 7,
        versionNonce: 8,
        seed: 9,
      },
    ],
  });
  const edge = (semanticKey: string): SemanticSceneEntity => ({
    ...node(semanticKey),
    kind: "edge",
    shape: null,
    from: "node-a",
    to: "node-z",
  });
  const group = (semanticKey: string): SemanticSceneGroup => ({
    semanticKey,
    groupId: `private-group-${semanticKey}`,
    members: ["node-z", "node-a"],
  });
  return {
    protocol: "tweakloop.semantic-scene-map/v1",
    entities: {
      "node-z": node("node-z"),
      "edge-z": edge("edge-z"),
      "node-a": node("node-a"),
      "edge-a": edge("edge-a"),
    },
    groups: {
      "group-z": group("group-z"),
      "group-a": group("group-a"),
    },
  };
}

function parseHumanAuthorityContract(source: string): Readonly<{
  errorCode: string;
  mutated: boolean;
  nextAction: string;
  alwaysBrowser: readonly string[];
  conditionalBrowser: readonly string[];
  agentCli: readonly string[];
  acceptedWorkReopen: string;
}> {
  const match = /```json cli-human-authority-contract\n([\s\S]*?)\n```/.exec(source);
  if (!match?.[1]) throw new Error("missing CLI human-authority contract");
  return JSON.parse(match[1]) as ReturnType<typeof parseHumanAuthorityContract>;
}

function discoverSourceTree(): Readonly<{ leaves: readonly string[]; nodeCount: number }> {
  sourceByPath.clear();
  for (const path of registrarPaths) parseSourceRegistrar(path);

  const inspections = [...sourceByPath.values()];
  for (const inspection of inspections) {
    const children = inspections
      .filter((candidate) => {
        const prefix = `${inspection.path} `;
        if (!candidate.path.startsWith(prefix)) return false;
        return !candidate.path.slice(prefix.length).includes(" ");
      })
      .map((candidate) => candidate.path.slice(inspection.path.length + 1))
      .sort();
    sourceByPath.set(inspection.path, {
      ...inspection,
      isGroup: children.length > 0,
      children,
      usage: children.length > 0 ? `${inspection.usage} [command]` : inspection.usage,
    });
  }

  return {
    leaves: [...sourceByPath.values()]
      .filter((inspection) => !inspection.isGroup)
      .map((inspection) => inspection.path),
    nodeCount: sourceByPath.size,
  };
}

function parseSourceRegistrar(path: string): void {
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map<string, ts.Expression>();
  const implicitRoots = new Map<string, readonly string[]>([
    ["program", []],
    ...(path.endsWith("inbound-commands.ts")
      ? ([
          ["chat", ["chat"]],
          ["work", ["work"]],
        ] as const)
      : []),
  ]);

  const visitDeclarations = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      containsCommandCall(node.initializer)
    ) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(file);

  const resolveExpression = (
    expression: ts.Expression,
    seen = new Set<string>(),
  ): readonly string[] | null => {
    if (ts.isIdentifier(expression)) {
      const implicit = implicitRoots.get(expression.text);
      if (implicit) return implicit;
      if (seen.has(expression.text)) return null;
      const declaration = declarations.get(expression.text);
      if (!declaration) return null;
      seen.add(expression.text);
      return resolveExpression(declaration, seen);
    }
    if (ts.isParenthesizedExpression(expression))
      return resolveExpression(expression.expression, seen);
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
      const receiver = expression.expression.expression;
      if (expression.expression.name.text === "command") {
        const parent = resolveExpression(receiver, seen);
        const signature = stringArgument(expression.arguments[0]);
        if (!parent || !signature) return null;
        return [...parent, commandName(signature)];
      }
      return resolveExpression(receiver, seen);
    }
    if (ts.isPropertyAccessExpression(expression))
      return resolveExpression(expression.expression, seen);
    return null;
  };

  const visitCommands = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "command"
    ) {
      const parent = resolveExpression(node.expression.expression);
      const signature = stringArgument(node.arguments[0]);
      if (parent && signature) {
        const commandPath = [...parent, commandName(signature)].join(" ");
        const chain = commandChain(node);
        const description = chain.description;
        if (!description)
          throw new Error(`source command has no literal description: ${commandPath}`);
        const args = signature.slice(commandName(signature).length).trim();
        const usage = `tweak ${commandPath} [options]${args ? ` ${args}` : ""}`;
        if (sourceByPath.has(commandPath))
          throw new Error(`duplicate source command: ${commandPath}`);
        sourceByPath.set(commandPath, {
          path: commandPath,
          identity: commandPath,
          usage,
          purpose: normalizeWhitespace(description),
          isGroup: false,
          children: [],
          implementation: source.slice(node.getStart(file), chain.end),
        });
      }
    }
    ts.forEachChild(node, visitCommands);
  };
  visitCommands(file);
}

function containsCommandCall(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "command"
  ) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsCommandCall(child)) found = true;
  });
  return found;
}

function commandChain(
  commandCall: ts.CallExpression,
): Readonly<{ description: string; end: number }> {
  let expression: ts.Expression = commandCall;
  let description = "";
  let end = commandCall.getEnd();
  for (;;) {
    const property = expression.parent;
    if (
      !ts.isPropertyAccessExpression(property) ||
      property.expression !== expression ||
      !ts.isCallExpression(property.parent) ||
      property.parent.expression !== property
    ) {
      break;
    }
    const call = property.parent;
    if (property.name.text === "description") {
      description = stringArgument(call.arguments[0]) ?? "";
    }
    expression = call;
    end = call.getEnd();
  }
  return { description, end };
}

function stringArgument(node: ts.Expression | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function commandName(signature: string): string {
  const name = signature.trim().split(/\s+/, 1)[0];
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid source command signature: ${signature}`);
  }
  return name;
}

function resolveSourceLeaf(path: string): SourceInspection {
  const inspection = sourceByPath.get(path);
  if (!inspection) throw new Error(`unknown current-source leaf: ${path}`);
  if (inspection.isGroup) throw new Error(`${path} is a command group, not a leaf`);
  return inspection;
}

function discoverBuiltTree(): Readonly<{ leaves: readonly string[]; nodeCount: number }> {
  const leaves: string[] = [];
  let nodeCount = 0;
  const walk = (path: readonly string[]): void => {
    const group = inspectHelp(path);
    if (!group.isGroup) throw new Error(`expected command group: ${path.join(" ") || "tweak"}`);
    for (const child of group.children) {
      const childPath = [...path, child];
      const inspection = inspectHelp(childPath);
      nodeCount += 1;
      if (inspection.isGroup) walk(childPath);
      else leaves.push(inspection.path);
    }
  };
  walk([]);
  return { leaves, nodeCount };
}

function resolveBuiltLeaf(path: readonly string[], useCache = true): HelpInspection {
  const requested = path.join(" ");
  const inspection = useCache
    ? (helpByPath.get(requested) ?? inspectHelp(path))
    : inspectHelp(path);
  if (inspection.identity !== requested) {
    throw new Error(`requested ${requested}, observed ${inspection.identity || "tweak"} help`);
  }
  if (inspection.isGroup) throw new Error(`${requested} is a command group, not a leaf`);
  return inspection;
}

function inspectHelp(path: readonly string[]): HelpInspection {
  const result = spawnSync(process.execPath, [cli, ...path, "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`help failed for ${path.join(" ") || "tweak"}: ${result.stderr}`);
  }
  const usageLine = result.stdout.split("\n")[0];
  if (!usageLine?.startsWith("Usage: tweak")) {
    throw new Error(`missing canonical Usage line for ${path.join(" ") || "tweak"}`);
  }
  const usage = usageLine.slice("Usage: ".length);
  const identity = canonicalIdentity(usageLine);
  const isGroup = usageLine.split(/\s+/).includes("[command]");
  const children = parseImmediateCommands(result.stdout);
  if (isGroup && children.length === 0)
    throw new Error(`group has no parsed children: ${identity}`);
  if (!isGroup && children.length > 0) {
    throw new Error(`leaf unexpectedly exposes children: ${identity}`);
  }
  const inspection = {
    path: identity,
    usage,
    identity,
    purpose: helpPurpose(result.stdout),
    isGroup,
    children,
  };
  helpByPath.set(identity, inspection);
  return inspection;
}

function canonicalIdentity(usageLine: string): string {
  const tokens = usageLine.replace(/^Usage: tweak\s*/, "").split(/\s+/);
  return tokens
    .filter((token) => token !== "" && !token.startsWith("[") && !token.startsWith("<"))
    .join(" ");
}

function helpPurpose(help: string): string {
  const match = /^Usage: [^\n]+\n\n([\s\S]*?)\n\n(?:Options|Commands):/m.exec(help);
  if (!match?.[1]) throw new Error("help output has no purpose paragraph");
  return normalizeWhitespace(match[1]);
}

function parseImmediateCommands(help: string): readonly string[] {
  const lines = help.split("\n");
  const start = lines.indexOf("Commands:");
  const isGroup = lines[0]?.split(/\s+/).includes("[command]") === true;
  if (!isGroup) {
    if (start >= 0) throw new Error("leaf help has an unexpected Commands section");
    return [];
  }
  if (start < 0) throw new Error("group help is missing its Commands section");

  const children: string[] = [];
  let syntheticHelpCount = 0;
  let sawEntry = false;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    const indentation = line.match(/^ */)?.[0].length ?? 0;
    if (indentation === 0 && /^[A-Z][^:]*:$/.test(line)) break;
    if (indentation === 1 || indentation === 3) {
      throw new Error(`unparsed command-row indentation: ${JSON.stringify(line)}`);
    }
    if (indentation === 2) {
      sawEntry = true;
      const signature =
        line
          .slice(2)
          .split(/\s{2,}/)[0]
          ?.trim() ?? "";
      if (signature === "help [command]") {
        syntheticHelpCount += 1;
        continue;
      }
      const name = /^([a-z][a-z0-9-]*)(?:\s|$)/.exec(signature)?.[1];
      if (!name) throw new Error(`unparsed command row: ${JSON.stringify(line)}`);
      children.push(name);
      continue;
    }
    if (indentation >= 4 && sawEntry) continue;
    throw new Error(`unparsed Commands section row: ${JSON.stringify(line)}`);
  }
  if (syntheticHelpCount !== 1) {
    throw new Error(`expected one synthetic help [command] row, got ${syntheticHelpCount}`);
  }
  if (new Set(children).size !== children.length) throw new Error("duplicate child command row");
  return children;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function jsonlPaths(input: readonly LeafRecord[]): readonly string[] {
  return input
    .filter((record) => record.output === "jsonl")
    .map((record) => record.path)
    .sort();
}

function assertOutputClasses(input: readonly LeafRecord[]): void {
  const expected = ["chat listen", "session listen"];
  const actual = jsonlPaths(input);
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(`JSONL paths must be ${expected.join(", ")}; observed ${actual.join(", ")}`);
  }
}

function parityDelta(
  shipped: readonly string[],
  documented: readonly string[],
): Readonly<{ undocumented: readonly string[]; uncallable: readonly string[] }> {
  const shippedSet = new Set(shipped);
  const documentedSet = new Set(documented);
  return {
    undocumented: shipped.filter((path) => !documentedSet.has(path)).sort(),
    uncallable: documented.filter((path) => !shippedSet.has(path)).sort(),
  };
}
