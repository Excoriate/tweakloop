import { Lexer, marked, Renderer, type Tokens } from "marked";
import { claimSemanticId, slugifySemanticText } from "./semantic-types.js";

const EXPLICIT_ID = /\s+\{#([A-Za-z][A-Za-z0-9_.:-]*)\}\s*$/;
const WHITEBOARD_DIRECTIVE =
  /^tweakloop-whiteboard\s+\{#([A-Za-z][A-Za-z0-9_.:-]*)\s+artifact=([A-Za-z][A-Za-z0-9_.:-]*)\s+revision=([A-Za-z][A-Za-z0-9_.:-]*)\}$/;

/**
 * Markdown stays canonical while this renderer supplies the semantic surface
 * that the review bridge needs. Block IDs intentionally derive from heading
 * ancestry and block role, not block contents, so editing prose does not move
 * an existing comment target.
 */
class TweakloopMarkdownRenderer extends Renderer {
  private readonly usedIds = new Set<string>();
  private readonly headingStack: Array<{ level: number; semanticId: string }> = [];
  private readonly blockCounts = new Map<string, number>();

  override html({ text }: Tokens.HTML | Tokens.Tag): string {
    // Raw HTML is displayed as source instead of being granted script-capable
    // execution inside the artifact origin.
    return escapeHtml(text);
  }

  override heading(token: Tokens.Heading): string {
    const explicit = token.text.match(EXPLICIT_ID);
    const visibleSource = explicit ? token.text.slice(0, explicit.index).trimEnd() : token.text;

    while ((this.headingStack.at(-1)?.level ?? 0) >= token.depth) {
      this.headingStack.pop();
    }

    const parentId = this.headingStack.at(-1)?.semanticId;
    const segment = slugifySemanticText(visibleSource) || `section-${this.usedIds.size + 1}`;
    const requestedId = explicit?.[1] ?? (parentId ? `${parentId}.${segment}` : segment);
    const semanticId = this.claimId(requestedId);
    this.headingStack.push({ level: token.depth, semanticId });

    const visibleTokens = Lexer.lexInline(visibleSource);
    const content = this.parser.parseInline(visibleTokens);
    return `<h${token.depth} data-tweak-id="${escapeAttribute(semanticId)}" data-tweak-kind="heading">${content}</h${token.depth}>\n`;
  }

  override paragraph(token: Tokens.Paragraph): string {
    const sectionId = this.headingStack.at(-1)?.semanticId ?? "document";
    const count = (this.blockCounts.get(sectionId) ?? 0) + 1;
    this.blockCounts.set(sectionId, count);
    const semanticId = this.claimId(`${sectionId}.paragraph-${count}`);
    const content = this.parser.parseInline(token.tokens);
    return `<p data-tweak-id="${escapeAttribute(semanticId)}" data-tweak-kind="paragraph">${content}</p>\n`;
  }

  override link(token: Tokens.Link): string {
    const content = this.parser.parseInline(token.tokens);
    if (!isSafeUrl(token.href)) return content;
    const title = token.title ? ` title="${escapeAttribute(token.title)}"` : "";
    return `<a href="${escapeAttribute(token.href)}"${title}>${content}</a>`;
  }

  override image(token: Tokens.Image): string {
    if (!isSafeUrl(token.href)) return escapeHtml(token.text);
    const title = token.title ? ` title="${escapeAttribute(token.title)}"` : "";
    return `<img src="${escapeAttribute(token.href)}" alt="${escapeAttribute(token.text)}"${title}>`;
  }

  override code(token: Tokens.Code): string {
    if (!token.lang?.startsWith("tweakloop-whiteboard")) return super.code(token);
    const match = token.lang.match(WHITEBOARD_DIRECTIVE);
    if (!match || token.text.trim() !== "") {
      throw new Error(
        "invalid tweakloop-whiteboard directive: expected an empty block with {#semantic-id artifact=artifact_id revision=rev_id}",
      );
    }
    const semanticId = match[1];
    const artifactId = match[2];
    const revisionId = match[3];
    if (!semanticId || !artifactId || !revisionId) {
      throw new Error("invalid tweakloop-whiteboard directive identifiers");
    }
    this.claimId(semanticId);
    return `<div data-tweakloop-whiteboard data-tweak-id="${escapeAttribute(semanticId)}" data-tweak-kind="whiteboard" data-tweak-whiteboard-artifact="${escapeAttribute(artifactId)}" data-tweak-whiteboard-revision="${escapeAttribute(revisionId)}" class="tweakloop-whiteboard-host"></div>\n`;
  }

  private claimId(requestedId: string): string {
    return claimSemanticId(requestedId, this.usedIds);
  }
}

/**
 * Markdown is canonical; this HTML is its deterministic review
 * projection. Headings receive data-tweak-id anchors derived from their
 * text so feedback targets semantic identity, not layout.
 * (Interim renderer — the remark/mdast adapter with real source
 * positions is Phase 5; see docs/architecture/07-semantic-identity.md.)
 */
export function renderMarkdown(md: string, title: string): string {
  const renderer = new TweakloopMarkdownRenderer();
  const html = marked.parse(md, { async: false, gfm: true, renderer }) as string;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { max-width: 760px; margin: 2rem auto; padding: 0 1rem; font: 16px/1.6 system-ui, sans-serif; color: #1f2937; background: #fff; }
  h1, h2, h3 { line-height: 1.25; }
  code { background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 4px; font-size: 0.9em; }
  pre code { display: block; padding: 1em; overflow-x: auto; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d1d5db; padding: 0.4em 0.7em; text-align: left; }
</style>
</head>
<body>
${html}
</body>
</html>`;
}

function isSafeUrl(url: string): boolean {
  const compact = [...url.trim()]
    .filter((character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127)
    .join("");
  const scheme = compact.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
