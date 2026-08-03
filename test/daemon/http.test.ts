import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";

let stateDir: string;
let workspaceRoot: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-ws-"));
  process.env.TWEAKLOOP_STATE_DIR = stateDir;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function shellUrl(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}

describe("daemon http", () => {
  it("reports health with a start nonce on both origins", async () => {
    const shell = await (await fetch(shellUrl("/health"))).json();
    expect(shell).toMatchObject({ ok: true, role: "shell", workspaceId: daemon.workspaceId });

    const artifact = await (await fetch(`http://127.0.0.1:${daemon.artifactPort}/health`)).json();
    expect(artifact).toMatchObject({ ok: true, role: "artifact" });
    expect(artifact.startNonce).toBe(shell.startNonce);
  });

  it("refuses API access without credentials", async () => {
    expect((await fetch(shellUrl("/api/v1/snapshot"))).status).toBe(401);
    expect((await fetch(shellUrl("/app"))).status).toBe(401);
  });

  it("accepts commands with the CLI bearer token and serves the snapshot", async () => {
    const command = {
      protocol: "tweakloop.command/v1",
      commandId: "cmd-http-1",
      idempotencyKey: "http-key-1",
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "test-agent" },
      type: "artifact.register",
      payload: {
        artifactId: "artifact_http",
        name: "plan.html",
        format: "html",
        sourcePath: join(workspaceRoot, "plan.html"),
      },
    };
    const res = await fetch(shellUrl("/api/v1/commands"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result).toMatchObject({ status: "accepted" });

    const snapshot = await (
      await fetch(shellUrl("/api/v1/snapshot"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.workspace.workspaceId).toBe(daemon.workspaceId);
    // workspace.opened + artifact.registered
    expect(snapshot.lastSeq).toBe(2);
  });

  it("authenticates a browser through a single-use bootstrap token", async () => {
    const minted = await (
      await fetch(shellUrl("/api/v1/bootstrap-tokens"), {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();

    const bootstrap = await fetch(minted.url, { redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("location")).toBe("/app");
    const cookie = bootstrap.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    const session = cookie?.split(";")[0] ?? "";

    const app = await fetch(shellUrl("/app"), { headers: { cookie: session } });
    expect(app.status).toBe(200);
    expect(await app.text()).toContain("tweakloop");

    // the bootstrap token is consumed
    expect((await fetch(minted.url, { redirect: "manual" })).status).toBe(403);
  });

  it("survives an oversized command body and stays available", async () => {
    const res = await fetch(shellUrl("/api/v1/commands"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: "x".repeat(1_100_000),
    });
    expect(res.status).toBe(413);
    expect((await fetch(shellUrl("/health"))).status).toBe(200);
  });

  it("rejects cookie-authenticated mutations from a foreign origin", async () => {
    const minted = await (
      await fetch(shellUrl("/api/v1/bootstrap-tokens"), {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    const bootstrap = await fetch(minted.url, { redirect: "manual" });
    const session = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";

    const foreign = await fetch(shellUrl("/api/v1/commands"), {
      method: "POST",
      headers: {
        cookie: session,
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(foreign.status).toBe(403);

    const sameOrigin = await fetch(shellUrl("/api/v1/commands"), {
      method: "POST",
      headers: {
        cookie: session,
        origin: `http://127.0.0.1:${daemon.shellPort}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    // past the origin gate: the empty envelope fails protocol validation
    expect(sameOrigin.status).toBe(400);
    expect((await sameOrigin.json()).code).toBe("protocol.invalid-envelope");
  });

  it("refuses a second daemon for the same workspace", async () => {
    await expect(startDaemon({ rootPath: workspaceRoot, log: () => {} })).rejects.toThrow(
      /already running/,
    );
  });

  it("lists committed events as JSON", async () => {
    const events = await (
      await fetch(shellUrl("/api/v1/events?after=0"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, eventType: "workspace.opened" });
  });
});
