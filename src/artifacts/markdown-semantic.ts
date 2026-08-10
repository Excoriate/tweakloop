import {
  claimSemanticId,
  duplicateIdFindings,
  idFindings,
  placeholderFindings,
  type SemanticFinding,
  type SemanticIndex,
  type SemanticNode,
  semanticNode,
  slugifySemanticText,
  sourceRange,
} from "./semantic-types.js";

const EXPLICIT_ID = /\s+\{#([A-Za-z][A-Za-z0-9_.:-]*)\}\s*$/;
const WHITEBOARD_DIRECTIVE =
  /^tweakloop-whiteboard\s+\{#([A-Za-z][A-Za-z0-9_.:-]*)\s+artifact=([A-Za-z][A-Za-z0-9_.:-]*)\s+revision=([A-Za-z][A-Za-z0-9_.:-]*)\}$/;

export function extractMarkdownSemanticIndex(source: string): SemanticIndex {
  const findings: SemanticFinding[] = [...placeholderFindings(source)];
  const nodes: SemanticNode[] = [];
  const usedIds = new Set<string>();
  const explicitIds = new Set<string>();
  const headingStack: Array<{ level: number; semanticId: string }> = [];
  const blockCounts = new Map<string, number>();
  const lines = lineRecords(source);
  let order = 0;
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line) break;
    const heading = line.text.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading?.[1] && heading[2]) {
      const level = heading[1].length;
      const explicit = heading[2].match(EXPLICIT_ID);
      const visibleSource = explicit
        ? heading[2].slice(0, explicit.index).trimEnd()
        : heading[2].trimEnd();
      while ((headingStack.at(-1)?.level ?? 0) >= level) headingStack.pop();
      const parentId = headingStack.at(-1)?.semanticId ?? null;
      const segment = slugifySemanticText(stripMarkdown(visibleSource)) || `section-${order + 1}`;
      const requestedId = explicit?.[1] ?? (parentId ? `${parentId}.${segment}` : segment);
      const semanticId = explicit?.[1] ? requestedId : claimSemanticId(requestedId, usedIds);
      if (explicit?.[1]) {
        if (!explicitIds.has(semanticId)) usedIds.add(semanticId);
        explicitIds.add(semanticId);
      }
      findings.push(...idFindings(semanticId, sourceRange(source, line.start, line.end)));
      const node = semanticNode(
        semanticId,
        "heading",
        stripMarkdown(visibleSource),
        { parentId, path: [order], order },
        sourceRange(source, line.start, line.end),
      );
      nodes.push(node);
      order += 1;
      headingStack.push({ level, semanticId });
      cursor += 1;
      continue;
    }

    if (line.text.startsWith("```")) {
      const info = line.text.slice(3).trim();
      let end = cursor + 1;
      while (end < lines.length && !lines[end]?.text.startsWith("```")) end += 1;
      const directive = info.match(WHITEBOARD_DIRECTIVE);
      if (directive?.[1] && end === cursor + 1) {
        const semanticId = directive[1];
        const parentId = headingStack.at(-1)?.semanticId ?? null;
        nodes.push(
          semanticNode(
            semanticId,
            "whiteboard",
            "",
            { parentId, path: [order], order },
            sourceRange(source, line.start, lines[end]?.end ?? line.end),
          ),
        );
        findings.push(...idFindings(semanticId, sourceRange(source, line.start, line.end)));
        order += 1;
      }
      cursor = Math.min(lines.length, end + 1);
      continue;
    }

    if (line.text.trim() === "") {
      cursor += 1;
      continue;
    }

    const start = cursor;
    let end = cursor + 1;
    while (
      end < lines.length &&
      lines[end]?.text.trim() !== "" &&
      !/^(?:#{1,6})\s+/.test(lines[end]?.text ?? "") &&
      !lines[end]?.text.startsWith("```")
    ) {
      end += 1;
    }
    const parentId = headingStack.at(-1)?.semanticId ?? "document";
    const count = (blockCounts.get(parentId) ?? 0) + 1;
    blockCounts.set(parentId, count);
    const semanticId = claimSemanticId(`${parentId}.paragraph-${count}`, usedIds);
    const content = lines
      .slice(start, end)
      .map((entry) => entry.text)
      .join("\n");
    nodes.push(
      semanticNode(
        semanticId,
        "paragraph",
        stripMarkdown(content),
        {
          parentId: parentId === "document" ? null : parentId,
          path: [order],
          order,
        },
        sourceRange(source, line.start, lines[end - 1]?.end ?? line.end),
      ),
    );
    order += 1;
    cursor = end;
  }

  findings.push(...duplicateIdFindings(nodes));
  return { format: "markdown", nodes, findings };
}

type LineRecord = Readonly<{ text: string; start: number; end: number }>;

function lineRecords(source: string): LineRecord[] {
  const records: LineRecord[] = [];
  let start = 0;
  for (let cursor = 0; cursor <= source.length; cursor += 1) {
    if (cursor === source.length || source.charCodeAt(cursor) === 10) {
      const rawEnd = cursor > start && source.charCodeAt(cursor - 1) === 13 ? cursor - 1 : cursor;
      records.push({ text: source.slice(start, rawEnd), start, end: cursor });
      start = cursor + 1;
    }
  }
  return records;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`>#-]+/g, " ");
}
