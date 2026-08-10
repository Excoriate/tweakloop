// Visual QA: boot a browser against the repo workspace shell, capture
// light + dark screenshots of the main views. Usage: node tl-visual-qa.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const runtime = JSON.parse(
  readFileSync(
    join(
      homedir(),
      "Library/Application Support/tweakloop/workspaces/ws_0db610706334c9cc/runtime.json",
    ),
    "utf8",
  ),
);
const base = `http://127.0.0.1:${runtime.shellPort}`;

const minted = await fetch(`${base}/api/v1/bootstrap-tokens`, {
  method: "POST",
  headers: { authorization: `Bearer ${runtime.cliToken}` },
}).then((r) => r.json());

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(minted.url);
await page.waitForSelector('[data-testid="connection"]');
await page.waitForTimeout(1200);

async function shot(name) {
  await page.screenshot({ path: `/tmp/tl-shot-${name}.png` });
  console.log(`captured /tmp/tl-shot-${name}.png`);
}

await shot("main");
for (const tab of ["chat", "feedback", "work", "timeline"]) {
  const button = page.getByTestId(`tab-${tab}`);
  if ((await button.count()) > 0) {
    await button.click();
    await page.waitForTimeout(250);
    await shot(tab);
  }
}
const toggle = page.getByTestId("theme-toggle");
if ((await toggle.count()) > 0) {
  await toggle.click();
  await page.waitForTimeout(350);
  await page.getByTestId("tab-drafts").click();
  await shot("theme-b-main");
  await page.getByTestId("tab-chat").click();
  await page.waitForTimeout(250);
  await shot("theme-b-chat");
}
await browser.close();
