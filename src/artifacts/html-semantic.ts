import {
  duplicateIdFindings,
  idFindings,
  LOWER_KEBAB_KIND,
  placeholderFindings,
  type SemanticFinding,
  type SemanticIndex,
  type SemanticNode,
  semanticNode,
  sourceRange,
} from "./semantic-types.js";

type Attribute = Readonly<{ present: true; value: string; start: number; end: number }>;

type Frame = {
  tagName: string;
  startOffset: number;
  contentStart: number;
  endOffset: number;
  contentEnd: number;
  path: number[];
  childCount: number;
  parent: Frame | null;
  semanticId: string | null;
  kind: string | null;
  order: number | null;
};

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function extractHtmlSemanticIndex(source: string): SemanticIndex {
  const findings: SemanticFinding[] = [...placeholderFindings(source)];
  const frames: Frame[] = [];
  const nodeFrames: Frame[] = [];
  let rootChildCount = 0;
  let order = 0;
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) break;
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      cursor = close < 0 ? source.length : close + 3;
      continue;
    }
    const tagEnd = findTagEnd(source, open);
    if (tagEnd < 0) break;
    const raw = source.slice(open + 1, tagEnd);
    if (/^\s*[!?]/.test(raw)) {
      cursor = tagEnd + 1;
      continue;
    }
    const closing = raw.match(/^\s*\/\s*([A-Za-z][\w:-]*)/);
    if (closing?.[1]) {
      closeFrames(frames, closing[1].toLowerCase(), open, tagEnd + 1);
      cursor = tagEnd + 1;
      continue;
    }
    const opening = raw.match(/^\s*([A-Za-z][\w:-]*)/);
    if (!opening?.[1]) {
      cursor = tagEnd + 1;
      continue;
    }
    const tagName = opening[1].toLowerCase();
    const parent = frames.at(-1) ?? null;
    const siblingIndex = parent ? parent.childCount++ : rootChildCount++;
    const path = [...(parent?.path ?? []), siblingIndex];
    const attributes = parseAttributes(
      source,
      open + 1 + (opening.index ?? 0) + opening[0].length,
      tagEnd,
    );
    const idAttribute = attributes.get("data-tweak-id");
    const kindAttribute = attributes.get("data-tweak-kind");
    const id = idAttribute?.value.trim() ?? null;
    const kind = kindAttribute?.value.trim() ?? null;
    const frame: Frame = {
      tagName,
      startOffset: open,
      contentStart: tagEnd + 1,
      endOffset: tagEnd + 1,
      contentEnd: tagEnd + 1,
      path,
      childCount: 0,
      parent,
      semanticId: id && id.length > 0 ? id : null,
      kind: kind && kind.length > 0 ? kind : null,
      order: null,
    };

    if (kindAttribute && !idAttribute) {
      findings.push({
        code: "anchor.missing-id",
        severity: "error",
        message: "data-tweak-kind requires data-tweak-id",
        sourceRange: sourceRange(source, kindAttribute.start, kindAttribute.end),
      });
    }
    if (kindAttribute && frame.kind && !LOWER_KEBAB_KIND.test(frame.kind)) {
      findings.push({
        code: "anchor.invalid-kind",
        severity: "error",
        message: `semantic kind ${JSON.stringify(frame.kind)} is not lower-kebab`,
        ...(frame.semanticId ? { semanticId: frame.semanticId } : {}),
        sourceRange: sourceRange(source, kindAttribute.start, kindAttribute.end),
      });
    }
    if (idAttribute && !frame.semanticId) {
      findings.push({
        code: "anchor.invalid-id",
        severity: "error",
        message: "data-tweak-id must be nonempty",
        sourceRange: sourceRange(source, idAttribute.start, idAttribute.end),
      });
    }
    if (frame.semanticId) {
      frame.order = order++;
      nodeFrames.push(frame);
      findings.push(
        ...idFindings(
          frame.semanticId,
          idAttribute ? sourceRange(source, idAttribute.start, idAttribute.end) : undefined,
        ),
      );
      if (!frame.kind) {
        findings.push({
          code: "anchor.missing-kind",
          severity: "error",
          message: `semantic node ${frame.semanticId} requires nonempty data-tweak-kind`,
          semanticId: frame.semanticId,
          sourceRange: sourceRange(source, frame.startOffset, frame.contentStart),
        });
      }
    }

    const selfClosing = /\/\s*$/.test(raw) || VOID_ELEMENTS.has(tagName);
    if (selfClosing) {
      frame.endOffset = tagEnd + 1;
      frame.contentEnd = tagEnd + 1;
    } else {
      frames.push(frame);
    }
    if ((tagName === "script" || tagName === "style") && !selfClosing) {
      const closingStart = source.toLowerCase().indexOf(`</${tagName}`, tagEnd + 1);
      if (closingStart >= 0) {
        const closingEnd = findTagEnd(source, closingStart);
        closeFrames(frames, tagName, closingStart, closingEnd < 0 ? source.length : closingEnd + 1);
        cursor = closingEnd < 0 ? source.length : closingEnd + 1;
        continue;
      }
    }
    cursor = tagEnd + 1;
  }
  closeFrames(frames, null, source.length, source.length);

  const nodes: SemanticNode[] = nodeFrames.map((frame) =>
    semanticNode(
      frame.semanticId ?? "",
      frame.kind,
      visibleHtmlText(source.slice(frame.contentStart, frame.contentEnd)),
      {
        parentId: nearestSemanticParent(frame.parent),
        path: frame.path,
        order: frame.order ?? 0,
      },
      sourceRange(source, frame.startOffset, frame.endOffset),
    ),
  );
  findings.push(...duplicateIdFindings(nodes));
  return { format: "html", nodes, findings };
}

function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseAttributes(source: string, start: number, end: number): Map<string, Attribute> {
  const attributes = new Map<string, Attribute>();
  let cursor = start;
  while (cursor < end) {
    while (cursor < end && /[\s/]/.test(source[cursor] ?? "")) cursor += 1;
    const nameStart = cursor;
    while (cursor < end && !/[\s=/>]/.test(source[cursor] ?? "")) cursor += 1;
    if (cursor === nameStart) break;
    const name = source.slice(nameStart, cursor).toLowerCase();
    while (cursor < end && /\s/.test(source[cursor] ?? "")) cursor += 1;
    let value = "";
    if (source[cursor] === "=") {
      cursor += 1;
      while (cursor < end && /\s/.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < end && source[cursor] !== quote) cursor += 1;
        value = source.slice(valueStart, cursor);
        if (cursor < end) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < end && !/[\s>]/.test(source[cursor] ?? "")) cursor += 1;
        value = source.slice(valueStart, cursor);
      }
    }
    attributes.set(name, {
      present: true,
      value: decodeEntities(value),
      start: nameStart,
      end: cursor,
    });
  }
  return attributes;
}

function closeFrames(
  frames: Frame[],
  tagName: string | null,
  contentEnd: number,
  endOffset: number,
): void {
  while (frames.length > 0) {
    const frame = frames.pop();
    if (!frame) return;
    frame.contentEnd = contentEnd;
    frame.endOffset = endOffset;
    if (tagName === null || frame.tagName === tagName) {
      if (tagName !== null) return;
    }
  }
}

function nearestSemanticParent(frame: Frame | null): string | null {
  let current = frame;
  while (current) {
    if (current.semanticId) return current.semanticId;
    current = current.parent;
  }
  return null;
}

function visibleHtmlText(value: string): string {
  return decodeEntities(
    value
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " "),
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}
