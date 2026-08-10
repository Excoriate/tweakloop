import { readFileSync } from "node:fs";
import { basename, dirname, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, BrowserType, Page } from "@playwright/test";
import { renderMarkdown } from "../artifacts/markdown.js";
import type { SemanticFinding } from "../artifacts/semantic.js";

export type CheckViewport = Readonly<{ width: 360 | 1440; height: 800 | 900 }>;

export type ArtifactCheckFinding = Readonly<{
  code: string;
  severity: "error" | "warning";
  message: string;
  viewport?: CheckViewport;
  selector?: string;
  details?: Readonly<Record<string, unknown>>;
}>;

export type ArtifactCheckReceipt = Readonly<{
  status: "pass" | "fail";
  path: string;
  auditor: "axe-core";
  testedViewports: readonly Readonly<
    CheckViewport & { status: "pass" | "fail"; findingCount: number }
  >[];
  findings: readonly ArtifactCheckFinding[];
  findingCount: number;
  truncatedFindingCount: number;
}>;

type BrowserLoader = () => Promise<BrowserType<Browser>>;
type AxeLoader = () => Promise<string>;

type ObservedStructure = Readonly<{
  pageOverflow: boolean;
  documentWidth: number;
  viewportWidth: number;
  nestedOverflow: readonly Readonly<{
    selector: string;
    clientWidth: number;
    scrollWidth: number;
  }>[];
  headings: readonly Readonly<{ selector: string; level: number; text: string }>[];
  placeholders: readonly Readonly<{ selector: string; token: string }>[];
}>;

type AxeViolation = Readonly<{
  id: string;
  help: string;
  nodes: readonly Readonly<{ target: readonly string[]; failureSummary?: string }>[];
}>;

type MotionSnapshot = Readonly<{
  scrollBehavior: string;
  animations: readonly Readonly<{
    index: number;
    currentTime: number;
    playState?: string;
  }>[];
}>;

export type ArtifactCheckOptions = Readonly<{
  loadBrowser?: BrowserLoader;
  loadAxeSource?: AxeLoader;
  settleMs?: number;
}>;

const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 1440, height: 900 },
] as const satisfies readonly CheckViewport[];
const MAX_FINDINGS = 80;
const DEFAULT_SETTLE_MS = 750;

/**
 * Browser truth is deliberately separate from semantic source truth. The
 * caller supplies findings from the shared analyzer; this module renders and
 * audits the candidate without implementing another semantic parser.
 */
export async function checkArtifact(
  path: string,
  semanticFindings: readonly SemanticFinding[],
  options: ArtifactCheckOptions = {},
): Promise<ArtifactCheckReceipt> {
  const source = readFileSync(path, "utf8");
  const extension = extname(path).toLowerCase();
  if (![".html", ".htm", ".md", ".markdown", ".mdown", ".mkd"].includes(extension)) {
    return failedWithoutBrowser(
      path,
      "check.unsupported-format",
      "check supports HTML and Markdown",
    );
  }

  // Visibility is a browser fact. Static placeholder findings are replaced by
  // rendered visible-placeholder findings below so <template>/hidden content
  // does not become a false failure.
  const findings: ArtifactCheckFinding[] = semanticFindings
    .filter((finding) => finding.code !== "template.placeholder")
    .map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: truncate(finding.message, 360),
      ...(finding.semanticId ? { details: { semanticId: truncate(finding.semanticId, 240) } } : {}),
    }));

  let axeSource: string;
  try {
    axeSource = await (options.loadAxeSource ?? loadAxeSource)();
  } catch (error) {
    findings.push({
      code: "check.auditor-unavailable",
      severity: "error",
      message: `axe-core is unavailable: ${errorMessage(error)}`,
    });
    return receipt(path, findings, []);
  }

  let chromium: BrowserType<Browser>;
  try {
    chromium = await (options.loadBrowser ?? loadChromium)();
  } catch (error) {
    findings.push({
      code: "check.browser-unavailable",
      severity: "error",
      message: `Chromium is unavailable: ${errorMessage(error)}`,
    });
    return receipt(path, findings, []);
  }

  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    findings.push({
      code: "check.browser-unavailable",
      severity: "error",
      message: `Chromium could not launch: ${errorMessage(error)}`,
    });
    return receipt(path, findings, []);
  }

  const testedViewports: Array<CheckViewport & { status: "pass" | "fail"; findingCount: number }> =
    [];
  try {
    for (const viewport of VIEWPORTS) {
      const before = findings.length;
      findings.push(
        ...(await inspectViewport(browser, {
          path,
          source,
          extension,
          viewport,
          axeSource,
          settleMs: options.settleMs ?? DEFAULT_SETTLE_MS,
        })),
      );
      const findingCount = findings.length - before;
      testedViewports.push({
        ...viewport,
        status: findings.slice(before).some((finding) => finding.severity === "error")
          ? "fail"
          : "pass",
        findingCount,
      });
    }
  } finally {
    await browser.close();
  }

  return receipt(path, findings, testedViewports);
}

async function inspectViewport(
  browser: Browser,
  input: Readonly<{
    path: string;
    source: string;
    extension: string;
    viewport: CheckViewport;
    axeSource: string;
    settleMs: number;
  }>,
): Promise<ArtifactCheckFinding[]> {
  const findings: ArtifactCheckFinding[] = [];
  const remoteRequests = new Set<string>();
  const context = await browser.newContext({
    viewport: input.viewport,
    reducedMotion: "reduce",
    javaScriptEnabled: true,
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^https?:/i.test(url)) {
      remoteRequests.add(url);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url())) remoteRequests.add(request.url());
  });

  try {
    if ([".md", ".markdown", ".mdown", ".mkd"].includes(input.extension)) {
      const html = withLocalBase(
        renderMarkdown(input.source, basename(input.path)),
        pathToFileURL(`${dirname(input.path)}${sep}`).href,
      );
      await page.setContent(html, { waitUntil: "load" });
    } else {
      await page.goto(pathToFileURL(input.path).href, { waitUntil: "load" });
    }
    await page.waitForTimeout(input.settleMs);

    findings.push(...(await renderedStructureFindings(page, input.viewport)));
    findings.push(...(await contrastFindings(page, input.axeSource, input.viewport)));
    findings.push(...(await reducedMotionFindings(page, input.viewport)));
  } catch (error) {
    findings.push({
      code: "check.render-failed",
      severity: "error",
      message: `candidate render failed: ${errorMessage(error)}`,
      viewport: input.viewport,
    });
  } finally {
    for (const url of remoteRequests) {
      findings.push({
        code: "check.remote-request",
        severity: "error",
        message: `non-local network request attempted: ${truncate(url, 320)}`,
        viewport: input.viewport,
        details: { url: truncate(url, 512) },
      });
    }
    await context.close();
  }
  return findings;
}

async function renderedStructureFindings(
  page: Page,
  viewport: CheckViewport,
): Promise<ArtifactCheckFinding[]> {
  const observed = (await page.evaluate(RENDERED_STRUCTURE_SCRIPT)) as ObservedStructure;

  const findings: ArtifactCheckFinding[] = [];
  if (observed.pageOverflow) {
    findings.push({
      code: "check.horizontal-overflow",
      severity: "error",
      message: `page width ${observed.documentWidth}px exceeds viewport ${observed.viewportWidth}px`,
      viewport,
    });
  }
  for (const overflow of observed.nestedOverflow) {
    findings.push({
      code: "check.nested-horizontal-overflow",
      severity: "error",
      message: `${overflow.selector} scroll width ${overflow.scrollWidth}px exceeds ${overflow.clientWidth}px`,
      viewport,
      selector: overflow.selector,
    });
  }

  if (observed.headings.length === 0 || observed.headings[0]?.level !== 1) {
    findings.push({
      code: "check.heading-order",
      severity: "error",
      message: "rendered document must begin with a visible H1",
      viewport,
    });
  }
  for (let index = 1; index < observed.headings.length; index += 1) {
    const previous = observed.headings[index - 1];
    const current = observed.headings[index];
    if (previous && current && current.level > previous.level + 1) {
      findings.push({
        code: "check.heading-order",
        severity: "error",
        message: `rendered heading level skips from H${previous.level} to H${current.level}`,
        viewport,
        selector: current.selector,
        details: { previous: previous.text, current: current.text },
      });
    }
  }
  for (const placeholder of observed.placeholders) {
    findings.push({
      code: "check.visible-placeholder",
      severity: "error",
      message: `visible placeholder ${placeholder.token}`,
      viewport,
      selector: placeholder.selector,
    });
  }
  return findings;
}

async function contrastFindings(
  page: Page,
  axeSource: string,
  viewport: CheckViewport,
): Promise<ArtifactCheckFinding[]> {
  await page.evaluate(axeSource);
  const violations = (await page.evaluate(AXE_CONTRAST_SCRIPT)) as AxeViolation[];

  return violations.flatMap((violation) =>
    violation.nodes.slice(0, 12).map((node) => ({
      code: "check.color-contrast",
      severity: "error" as const,
      message: truncate(node.failureSummary ?? violation.help, 360),
      viewport,
      selector: truncate(node.target.join(" "), 240),
      details: { auditor: "axe-core", rule: violation.id },
    })),
  );
}

async function reducedMotionFindings(
  page: Page,
  viewport: CheckViewport,
): Promise<ArtifactCheckFinding[]> {
  const before = (await page.evaluate(MOTION_BEFORE_SCRIPT)) as MotionSnapshot;
  await page.waitForTimeout(120);
  const after = (await page.evaluate(MOTION_AFTER_SCRIPT)) as MotionSnapshot["animations"];
  const moving = after.filter((animation) => {
    const prior = before.animations.find((candidate) => candidate.index === animation.index);
    return (
      animation.playState === "running" &&
      prior !== undefined &&
      Math.abs(animation.currentTime - prior.currentTime) > 20
    );
  });
  const findings: ArtifactCheckFinding[] = [];
  if (before.scrollBehavior === "smooth") {
    findings.push({
      code: "check.reduced-motion",
      severity: "error",
      message: "smooth scrolling remains enabled under prefers-reduced-motion",
      viewport,
    });
  }
  if (moving.length > 0) {
    findings.push({
      code: "check.reduced-motion",
      severity: "error",
      message: `${moving.length} animation(s) remain observably active under prefers-reduced-motion`,
      viewport,
      details: { activeAnimationCount: moving.length },
    });
  }
  return findings;
}

function withLocalBase(html: string, baseHref: string): string {
  const base = `<base href=${JSON.stringify(baseHref)}>`;
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${base}`)
    : `${base}\n${html}`;
}

const RENDERED_STRUCTURE_SCRIPT = String.raw`(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.closest("[hidden], [aria-hidden='true']")) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number.parseFloat(style.opacity || "1") > 0 && element.getClientRects().length > 0;
  };
  const selector = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parent = element.parentElement;
    if (!parent) return element.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter(
      (candidate) => candidate.tagName === element.tagName,
    );
    return element.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(element) + 1) + ")";
  };

  const root = document.documentElement;
  const nestedOverflow = Array.from(document.body.querySelectorAll("*"))
    .filter(visible)
    .filter((element) => {
      const style = getComputedStyle(element);
      if (["auto", "scroll"].includes(style.overflowX)) return false;
      return element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1;
    })
    .slice(0, 12)
    .map((element) => ({
      selector: selector(element),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    .filter(visible)
    .map((element) => ({
      selector: selector(element),
      level: Number(element.tagName.slice(1)),
      text: (element.textContent || "").trim().slice(0, 160),
    }));
  const placeholderPattern = /\[\[[^\]\n]+\]\]/g;
  const placeholders = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !visible(parent) || ["SCRIPT", "STYLE", "TEMPLATE"].includes(parent.tagName)) {
      continue;
    }
    for (const match of (node.textContent || "").matchAll(placeholderPattern)) {
      placeholders.push({ selector: selector(parent), token: match[0] });
    }
  }
  for (const element of document.querySelectorAll("input, textarea, img")) {
    if (!visible(element)) continue;
    const values = element instanceof HTMLImageElement
      ? [element.alt]
      : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? [element.value, element.placeholder]
        : [];
    for (const value of values) {
      for (const match of value.matchAll(placeholderPattern)) {
        placeholders.push({ selector: selector(element), token: match[0] });
      }
    }
  }
  return {
    pageOverflow: root.scrollWidth > root.clientWidth + 1,
    documentWidth: root.scrollWidth,
    viewportWidth: root.clientWidth,
    nestedOverflow,
    headings,
    placeholders: placeholders.slice(0, 12),
  };
})()`;

const AXE_CONTRAST_SCRIPT = `(() => {
  if (!globalThis.axe) throw new Error("axe-core did not initialize in the rendered page");
  return globalThis.axe.run(document, {
    runOnly: { type: "rule", values: ["color-contrast"] },
    resultTypes: ["violations"],
  }).then((result) => result.violations);
})()`;

const MOTION_BEFORE_SCRIPT = `(() => ({
  scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
  animations: document.getAnimations({ subtree: true }).map((animation, index) => ({
    index,
    currentTime: Number(animation.currentTime || 0),
  })),
}))()`;

const MOTION_AFTER_SCRIPT = `(() => document.getAnimations({ subtree: true }).map(
  (animation, index) => ({
    index,
    currentTime: Number(animation.currentTime || 0),
    playState: animation.playState,
  }),
))()`;

async function loadChromium(): Promise<BrowserType<Browser>> {
  const moduleName = "@playwright/test";
  const playwright = (await import(moduleName)) as typeof import("@playwright/test");
  return playwright.chromium;
}

async function loadAxeSource(): Promise<string> {
  const moduleName = "axe-core";
  const loaded = (await import(moduleName)) as unknown as {
    default?: { source?: unknown };
    source?: unknown;
  };
  const source = loaded.default?.source ?? loaded.source;
  if (typeof source !== "string" || source === "") throw new Error("axe-core source is empty");
  return source;
}

function receipt(
  path: string,
  allFindings: readonly ArtifactCheckFinding[],
  testedViewports: ArtifactCheckReceipt["testedViewports"],
): ArtifactCheckReceipt {
  const findings = allFindings.slice(0, MAX_FINDINGS);
  return {
    status: allFindings.some((finding) => finding.severity === "error") ? "fail" : "pass",
    path,
    auditor: "axe-core",
    testedViewports,
    findings,
    findingCount: allFindings.length,
    truncatedFindingCount: Math.max(0, allFindings.length - findings.length),
  };
}

function failedWithoutBrowser(path: string, code: string, message: string): ArtifactCheckReceipt {
  return receipt(path, [{ code, severity: "error", message }], []);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
