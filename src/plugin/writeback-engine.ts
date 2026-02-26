export type WritebackOperation = {
  type: "create" | "update" | "delete" | "move";
  notePath: string;
  linkIndex?: number;
  toIndex?: number;
  title?: string;
  url?: string;
  linkHeading: string;
};

export type WritebackResult = {
  success: boolean;
  reason?: string;
  newContent?: string;
};

const MARKDOWN_LINK_RE = /\[((?:[^[\]]*|\[[^[\]]*\])*)]\(([^)]*)\)/g;

export function applyWriteback(content: string, op: WritebackOperation): WritebackResult {
  const eol = detectLineEnding(content);
  const hasTrailingEol = content.endsWith("\n");
  const lines = splitLines(content);
  const normalizedHeading = normalizeHeadingText(op.linkHeading);
  const headingIndex = findHeadingIndex(lines, normalizedHeading);

  if (headingIndex < 0) {
    if (op.type === "create") {
      return applyCreateWithMissingHeading(lines, eol, hasTrailingEol, op);
    }
    return { success: false, reason: "heading_not_found" };
  }

  const sectionEndIndex = findSectionEnd(lines, headingIndex);
  const sectionLinks = collectSectionLinks(lines, headingIndex + 1, sectionEndIndex);

  if (op.type === "create") {
    const title = op.title ?? "";
    const url = op.url ?? "";
    const newLine = `- [${title}](${url})`;
    const insertionIndex = resolveCreateInsertionLine(op.linkIndex, sectionLinks, sectionEndIndex);
    if (insertionIndex < 0) {
      return { success: false, reason: "index_out_of_range" };
    }
    lines.splice(insertionIndex, 0, newLine);
    return { success: true, newContent: joinLines(lines, eol, hasTrailingEol) };
  }

  if (op.type === "move") {
    if (
      op.linkIndex === undefined
      || !Number.isInteger(op.linkIndex)
      || op.linkIndex < 0
      || op.linkIndex >= sectionLinks.length
      || op.toIndex === undefined
      || !Number.isInteger(op.toIndex)
      || op.toIndex < 0
      || op.toIndex >= sectionLinks.length
    ) {
      return { success: false, reason: "index_out_of_range" };
    }

    if (op.linkIndex === op.toIndex) {
      return { success: true, newContent: joinLines(lines, eol, hasTrailingEol) };
    }

    const source = sectionLinks[op.linkIndex];
    if (!source) {
      return { success: false, reason: "index_out_of_range" };
    }
    const movedLine = lines[source.lineIndex] ?? "";
    lines.splice(source.lineIndex, 1);

    const sectionEndAfterMove = findSectionEnd(lines, headingIndex);
    const linksAfterMove = collectSectionLinks(lines, headingIndex + 1, sectionEndAfterMove);
    const insertionIndex = resolveCreateInsertionLine(op.toIndex, linksAfterMove, sectionEndAfterMove);
    if (insertionIndex < 0) {
      return { success: false, reason: "index_out_of_range" };
    }

    lines.splice(insertionIndex, 0, movedLine);
    return { success: true, newContent: joinLines(lines, eol, hasTrailingEol) };
  }

  if (op.linkIndex === undefined || !Number.isInteger(op.linkIndex) || op.linkIndex < 0 || op.linkIndex >= sectionLinks.length) {
    return { success: false, reason: "index_out_of_range" };
  }

  const target = sectionLinks[op.linkIndex];
  if (!target) {
    return { success: false, reason: "index_out_of_range" };
  }

  if (op.type === "delete") {
    lines.splice(target.lineIndex, 1);
    return { success: true, newContent: joinLines(lines, eol, hasTrailingEol) };
  }

  const updatedLine = rewriteLineAtLink(lines[target.lineIndex] ?? "", target, op);
  if (updatedLine === null) {
    return { success: false, reason: "index_out_of_range" };
  }
  lines[target.lineIndex] = updatedLine;
  return { success: true, newContent: joinLines(lines, eol, hasTrailingEol) };
}

type SectionLink = {
  lineIndex: number;
  title: string;
  url: string;
  bodyStart: number;
  bodyEnd: number;
  linePrefix: string;
  lineBody: string;
};

function applyCreateWithMissingHeading(
  lines: string[],
  eol: "\n" | "\r\n",
  hasTrailingEol: boolean,
  op: WritebackOperation
): WritebackResult {
  const heading = op.linkHeading.trim().length > 0 ? op.linkHeading.trim() : "Link";
  const title = op.title ?? "";
  const url = op.url ?? "";
  if (op.linkIndex !== undefined && op.linkIndex !== 0) {
    return { success: false, reason: "index_out_of_range" };
  }

  if (lines.length === 1 && lines[0] === "") {
    return { success: true, newContent: [heading, `- [${title}](${url})`].join(eol) };
  }

  const nextLines = [...lines];
  nextLines.push(heading, `- [${title}](${url})`);
  return { success: true, newContent: joinLines(nextLines, eol, hasTrailingEol) };
}

function collectSectionLinks(lines: string[], start: number, end: number): SectionLink[] {
  const links: SectionLink[] = [];
  for (let i = start; i < end; i += 1) {
    const line = lines[i] ?? "";
    const parsed = parseFirstLinkFromBullet(line);
    if (!parsed) {
      continue;
    }
    links.push({ lineIndex: i, ...parsed });
  }
  return links;
}

function parseFirstLinkFromBullet(line: string): Omit<SectionLink, "lineIndex"> | null {
  const bullet = line.match(/^(\s*[-*+]\s+)(.+)$/);
  if (!bullet) {
    return null;
  }
  const linePrefix = bullet[1] ?? "";
  const lineBody = bullet[2] ?? "";
  if (!lineBody) {
    return null;
  }

  const re = new RegExp(MARKDOWN_LINK_RE);
  const match = re.exec(lineBody);
  if (!match) {
    return null;
  }

  const title = match[1] ?? "";
  const url = match[2] ?? "";

  const bodyStart = match.index;
  const bodyEnd = bodyStart + match[0].length;

  return { title, url, bodyStart, bodyEnd, linePrefix, lineBody };
}

function rewriteLineAtLink(line: string, target: SectionLink, op: WritebackOperation): string | null {
  const parsed = parseFirstLinkFromBullet(line);
  if (!parsed) {
    return null;
  }

  const title = op.title ?? target.title;
  const url = op.url ?? target.url;
  const replacement = `[${title}](${url})`;
  const updatedBody =
    parsed.lineBody.slice(0, parsed.bodyStart) + replacement + parsed.lineBody.slice(parsed.bodyEnd);

  return `${parsed.linePrefix}${updatedBody}`;
}

function findHeadingIndex(lines: string[], normalizedHeading: string): number {
  if (!normalizedHeading) {
    return -1;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]?.trim() ?? "";
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    const headingText = headingMatch?.[2];
    if (headingText && normalizeHeadingText(headingText) === normalizedHeading) {
      return i;
    }
    if (!headingMatch && normalizeHeadingText(trimmed) === normalizedHeading) {
      return i;
    }
  }

  return -1;
}

function findSectionEnd(lines: string[], headingIndex: number): number {
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i]?.trim() ?? "";
    if (/^#{1,6}\s+/.test(trimmed)) {
      return i;
    }
  }
  return lines.length;
}

function resolveCreateInsertionLine(linkIndex: number | undefined, links: SectionLink[], sectionEndIndex: number): number {
  if (linkIndex === undefined) {
    return sectionEndIndex;
  }

  if (!Number.isInteger(linkIndex) || linkIndex < 0 || linkIndex > links.length) {
    return -1;
  }

  if (linkIndex === links.length) {
    return sectionEndIndex;
  }

  const target = links[linkIndex];
  return target ? target.lineIndex : -1;
}

function normalizeHeadingText(raw: string): string {
  return raw
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .trim()
    .toLowerCase();
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  return /\r\n/.test(content) ? "\r\n" : "\n";
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [""] : content.split(/\r?\n/);
}

function joinLines(lines: string[], eol: "\n" | "\r\n", hasTrailingEol: boolean): string {
  const joined = lines.join(eol);
  return hasTrailingEol ? `${joined}${eol}` : joined;
}
