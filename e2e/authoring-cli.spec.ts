import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist/cli/index.js");
const starter = join(root, "skills/tweakloop/assets/minimal-plan-starter.html");

test("new plan is package-relative, byte-exact, daemon-independent, and exclusive", () => {
  const directory = mkdtempSync(join(tmpdir(), "tweakloop-new-plan-cli-"));
  const destination = join(directory, "proposal.html");
  const created = runCli(directory, ["new", "plan", destination, "--json"]);

  expect(created.status).toBe(0);
  expect(created.json).toMatchObject({
    template: "plan",
    created: true,
    path: destination,
  });
  expect(readFileSync(destination)).toEqual(readFileSync(starter));
  expect(() => readFileSync(join(directory, ".tweakloop/project.json"))).toThrow();

  const lint = runCli(directory, ["lint", destination, "--json"]);
  expect(lint.status).not.toBe(0);
  expect(codes(lint.json)).toContain("template.placeholder");

  const sentinel = Buffer.from("existing bytes must survive\n");
  writeFileSync(destination, sentinel);
  const duplicate = runCli(directory, ["new", "plan", destination, "--json"]);
  expect(duplicate.status).not.toBe(0);
  expect(duplicate.json).toEqual({
    protocol: "tweakloop.cli/v1",
    error: {
      code: "scaffold.destination-exists",
      message: `destination already exists: ${destination}`,
      retryable: false,
      details: { path: destination },
    },
  });
  expect(JSON.parse(duplicate.stdout)).toEqual(duplicate.json);
  expect(readFileSync(destination)).toEqual(sentinel);
});

test("lint and diff use the shared semantic API against the immutable current head", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "tweakloop-authoring-state-"));
  const workspace = mkdtempSync(join(tmpdir(), "tweakloop-authoring-workspace-"));
  const path = join(workspace, "plan.html");
  const environment = { ...process.env, TWEAKLOOP_STATE_DIR: stateDirectory };
  const baseline = documentWithDecision("decision.auth", "Use OAuth");
  writeFileSync(path, baseline);

  try {
    const lint = runCli(workspace, ["lint", path, "--json"], environment);
    expect(lint.status).toBe(0);
    expect(lint.json).toMatchObject({ status: "pass", format: "html", errorCount: 0 });

    const opened = runCli(
      workspace,
      [
        "--workspace",
        workspace,
        "open",
        path,
        "--agent",
        "authoring-e2e",
        "--no-browser",
        "--json",
      ],
      environment,
    );
    expect(opened.status).toBe(0);
    writeFileSync(path, documentWithDecision("decision.authentication", "Use OAuth"));

    const diff = runCli(workspace, ["--workspace", workspace, "diff", path, "--json"], environment);
    expect(diff.status).toBe(0);
    expect(diff.json).toMatchObject({ status: "pass", format: "html" });
    expect((diff.json.removed as Array<{ id: string }>).map((node) => node.id)).toEqual([
      "decision.auth",
    ]);
    expect((diff.json.added as Array<{ id: string }>).map((node) => node.id)).toEqual([
      "decision.authentication",
    ]);
    expect(diff.json.possibleRenames).toEqual([
      expect.objectContaining({
        removedId: "decision.auth",
        addedId: "decision.authentication",
      }),
    ]);
  } finally {
    runCli(workspace, ["--workspace", workspace, "--json", "daemon", "stop"], environment);
    rmSync(stateDirectory, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("check runs real Chromium at both frozen viewports while hidden placeholders do not fail", () => {
  const result = checkHtml(`
    <style>
      html { color: #111; background: #fff; scroll-behavior: auto; }
      body { margin: 1rem; font: 16px/1.5 system-ui, sans-serif; }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
    </style>
    <h1>Plan</h1><h2>Scope</h2>
    <section data-tweak-id="plan.scope" data-tweak-kind="scope">Safe content</section>
    <p hidden>[[HIDDEN_PLACEHOLDER]]</p>
  `);

  expect(result.status).toBe(0);
  expect(result.json).toMatchObject({
    status: "pass",
    auditor: "axe-core",
    testedViewports: [
      { width: 360, height: 800, status: "pass" },
      { width: 1440, height: 900, status: "pass" },
    ],
  });
  expect(JSON.stringify(result.json)).not.toContain("check.visible-placeholder");
});

test("check fails nonzero when the Chromium capability is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "tweakloop-check-no-browser-"));
  const path = join(directory, "candidate.html");
  writeFileSync(path, documentWithDecision("decision.auth", "Use OAuth"));
  const result = runCli(directory, ["check", path, "--json"], {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: join(directory, "missing-browser-store"),
  });

  expect(result.status).not.toBe(0);
  expect(result.json).toMatchObject({ status: "fail", testedViewports: [] });
  expect(codes(result.json)).toContain("check.browser-unavailable");
});

test("rendered heading order cannot be replaced by a source-only parser", () => {
  const result = checkHtml(`
    <style>body { color: #111; background: #fff; }</style>
    <h1>Plan</h1><h2 id="changed">Source-valid heading</h2>
    <section data-tweak-id="plan.scope" data-tweak-kind="scope">Scope</section>
    <script>document.querySelector('#changed').outerHTML = '<h3>Rendered skip</h3>';</script>
  `);

  expect(result.status).not.toBe(0);
  expect(codes(result.json)).toContain("check.heading-order");
});

test("visible placeholders fail while hidden/template placeholders remain non-rendered", () => {
  const result = checkHtml(`
    <style>body { color: #111; background: #fff; }</style>
    <h1>Plan</h1>
    <section data-tweak-id="plan.scope" data-tweak-kind="scope">[[VISIBLE_VALUE]]</section>
    <template>[[TEMPLATE_VALUE]]</template>
  `);

  expect(result.status).not.toBe(0);
  expect(codes(result.json)).toContain("check.visible-placeholder");
  expect(JSON.stringify(result.json)).not.toContain("TEMPLATE_VALUE");
});

test("a post-load remote request is blocked and remains a failing attempted request", () => {
  const result = checkHtml(`
    <style>body { color: #111; background: #fff; }</style>
    <h1>Plan</h1>
    <section data-tweak-id="plan.scope" data-tweak-kind="scope">Scope</section>
    <script>setTimeout(() => fetch('https://example.invalid/late'), 75);</script>
  `);

  expect(result.status).not.toBe(0);
  expect(codes(result.json)).toContain("check.remote-request");
  expect(JSON.stringify(result.json)).toContain("https://example.invalid/late");
});

test("page and non-scroll-container nested overflow fail at the narrow viewport", () => {
  const result = checkHtml(`
    <style>
      body { color: #111; background: #fff; margin: 0; }
      .page-wide { width: 420px; }
      .clip { width: 120px; overflow-x: hidden; }
      .nested-wide { width: 390px; }
    </style>
    <h1>Plan</h1>
    <section class="page-wide" data-tweak-id="plan.scope" data-tweak-kind="scope">Wide page</section>
    <div class="clip"><div class="nested-wide">Nested overflow</div></div>
  `);

  expect(result.status).not.toBe(0);
  expect(codes(result.json)).toEqual(
    expect.arrayContaining(["check.horizontal-overflow", "check.nested-horizontal-overflow"]),
  );
});

test("axe-core AA contrast and observable reduced-motion violations fail", () => {
  const result = checkHtml(`
    <style>
      body { color: #b7b7b7; background: #fff; }
      @keyframes drift { from { transform: translateX(0); } to { transform: translateX(20px); } }
      .moving { animation: drift 0.4s linear infinite; }
    </style>
    <h1>Plan</h1>
    <section class="moving" data-tweak-id="plan.scope" data-tweak-kind="scope">Low contrast moving text</section>
  `);

  expect(result.status).not.toBe(0);
  expect(codes(result.json)).toEqual(
    expect.arrayContaining(["check.color-contrast", "check.reduced-motion"]),
  );
  expect(JSON.stringify(result.json)).toContain('"auditor":"axe-core"');
});

type CliResult = Readonly<{
  status: number | null;
  json: Record<string, unknown>;
  stdout: string;
}>;

function checkHtml(body: string): CliResult {
  const directory = mkdtempSync(join(tmpdir(), "tweakloop-check-cli-"));
  const path = join(directory, "candidate.html");
  writeFileSync(
    path,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${body}</body></html>`,
  );
  return runCli(directory, ["check", path, "--json"]);
}

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): CliResult {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const stdout = result.stdout.trim();
  if (stdout === "") {
    throw new Error(`CLI emitted no JSON; stderr=${result.stderr}`);
  }
  return {
    status: result.status,
    json: JSON.parse(stdout) as Record<string, unknown>,
    stdout: result.stdout,
  };
}

function documentWithDecision(id: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>
    <h1>Plan</h1>
    <section data-tweak-id="${id}" data-tweak-kind="decision"><h2>Decision</h2><p>${text}</p></section>
  </body></html>`;
}

function codes(receipt: Record<string, unknown>): string[] {
  const findings = receipt.findings;
  if (!Array.isArray(findings)) return [];
  return findings.flatMap((finding) =>
    typeof finding === "object" && finding !== null && typeof finding.code === "string"
      ? [finding.code]
      : [],
  );
}
