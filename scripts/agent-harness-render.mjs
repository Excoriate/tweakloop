import { cpSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const hookCommand = (client) =>
  `node "$(git rev-parse --show-toplevel)/.ai/harness/native-hooks/v1/continue-on-durable.mjs" --client ${client}`;

const SCHEMA_ADAPTERS = new Map([
  [
    "claude-hook-adapter",
    {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: hookCommand("claude-code"),
                timeout: 10,
                statusMessage: "Checking durable Tweakloop facts",
              },
            ],
          },
        ],
      },
    },
  ],
  [
    "codex-hook-adapter",
    {
      description: "Continue only after a newer durable Tweakloop fact is observed.",
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: hookCommand("codex"),
                timeout: 10,
                statusMessage: "Checking durable Tweakloop facts",
              },
            ],
          },
        ],
      },
    },
  ],
  [
    "cursor-hook-adapter",
    {
      version: 1,
      hooks: {
        stop: [{ command: hookCommand("cursor") }],
      },
    },
  ],
]);

export function expectedDerivation(row, repositoryRoot, resolveInside) {
  if (row.type === "identity-copy" || row.type === "package-projection") {
    return { kind: "copy", source: resolveInside(repositoryRoot, row.source) };
  }
  if (row.type === "native-import") {
    if (row.id !== "claude-agent-guide-import") {
      throw new Error(`no native-import renderer for ${row.id}`);
    }
    return { kind: "file", bytes: Buffer.from("@.agents/AGENTS.md\n") };
  }
  if (row.type === "schema-adapter") {
    const adapter = SCHEMA_ADAPTERS.get(row.id);
    if (!adapter) throw new Error(`no schema-adapter renderer for ${row.id}`);
    return { kind: "file", bytes: Buffer.from(`${JSON.stringify(adapter, null, 2)}\n`) };
  }
  throw new Error(`no derivation renderer for ${row.id}`);
}

export function materializeDerivation(expected, consumer) {
  mkdirSync(dirname(consumer), { recursive: true });
  rmSync(consumer, { recursive: true, force: true });
  if (expected.kind === "copy") {
    const stat = lstatSync(expected.source);
    if (stat.isDirectory()) {
      cpSync(expected.source, consumer, { recursive: true, errorOnExist: false });
    } else {
      cpSync(expected.source, consumer);
    }
    return;
  }
  writeFileSync(consumer, expected.bytes);
}

export function expectedBytes(expected) {
  if (expected.kind !== "file") throw new Error("expected artifact is not a rendered file");
  return expected.bytes;
}

export function expectedSourceBytes(expected) {
  if (expected.kind !== "copy" || lstatSync(expected.source).isDirectory()) {
    throw new Error("expected artifact is not a copied file");
  }
  return readFileSync(expected.source);
}

export { SCHEMA_ADAPTERS };
