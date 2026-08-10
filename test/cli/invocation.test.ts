import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderInvocation, resolveInvocation } from "../../src/cli/invocation.js";

describe("Invocation", () => {
  it("records an absolute Node plus local dist entry point", () => {
    expect(
      resolveInvocation({
        execPath: "/opt/node/bin/node",
        scriptPath: "dist/cli/index.js",
        cwd: "/repo",
      }),
    ).toEqual({
      prefix: ["/opt/node/bin/node", "/repo/dist/cli/index.js"],
      source: "local-node",
    });
  });

  it("preserves an installed bin path rather than rewriting it", () => {
    expect(
      resolveInvocation({ execPath: "/opt/node/bin/node", scriptPath: "/usr/local/bin/tweak" }),
    ).toEqual({ prefix: ["/usr/local/bin/tweak"], source: "installed" });
  });

  it("preserves an exact npx route through the narrow outer-invocation override", () => {
    expect(
      resolveInvocation({
        execPath: "/opt/node/bin/node",
        scriptPath: "/npm/cache/index.js",
        overrideJson: '["npx","-y","tweakloop@0.1.0"]',
      }),
    ).toEqual({ prefix: ["npx", "-y", "tweakloop@0.1.0"], source: "override" });
  });

  it("quotes every executable and argument without changing spaces or apostrophes", () => {
    const rendered = renderInvocation(
      { prefix: ["/opt/node bin/node", "/repo's copy/dist/cli/index.js"], source: "local-node" },
      ["publish", "/tmp/a file's plan.md"],
    );
    expect(rendered).toBe(
      "'/opt/node bin/node' '/repo'\"'\"'s copy/dist/cli/index.js' 'publish' '/tmp/a file'\"'\"'s plan.md'",
    );
  });

  it("preserves the active workspace as an absolute global selector", () => {
    const invocation = resolveInvocation({
      execPath: "/opt/node/bin/node",
      scriptPath: "dist/cli/index.js",
      cwd: "/repo",
      argv: ["--workspace", "fixtures/live workspace", "--json", "open", "plan.html"],
    });

    expect(invocation.globalArgs).toEqual(["--workspace", "/repo/fixtures/live workspace"]);
    expect(renderInvocation(invocation, ["next", "--session", "session_1", "--json"])).toBe(
      "'/opt/node/bin/node' '/repo/dist/cli/index.js' '--workspace' '/repo/fixtures/live workspace' 'next' '--session' 'session_1' '--json'",
    );
  });

  it("lets a returned destination workspace replace the current selector", () => {
    const invocation = {
      prefix: ["tweak"],
      globalArgs: ["--workspace", "/source"],
      source: "installed" as const,
    };

    expect(renderInvocation(invocation, ["--workspace", "/fork", "next", "--json"])).toBe(
      "'tweak' '--workspace' '/fork' 'next' '--json'",
    );
  });

  it("executes a quoted generated route verbatim through a POSIX shell", () => {
    const command = renderInvocation({ prefix: [process.execPath], source: "installed" }, [
      "-e",
      "console.log(process.argv[1])",
      "value with spaces and an ' apostrophe",
    ]);
    expect(execSync(command, { encoding: "utf8", shell: "/bin/sh" }).trim()).toBe(
      "value with spaces and an ' apostrophe",
    );
  });

  it("rejects malformed invocation overrides rather than returning an unsafe command", () => {
    expect(() => resolveInvocation({ overrideJson: "not-json" })).toThrow(
      /invocation|JSON string array/i,
    );
    expect(() => resolveInvocation({ overrideJson: "[]" })).toThrow(/non-empty/);
  });
});
