import type { LinkItem } from "./types";

const MARKDOWN_LINK_RE = /\[((?:[^[\]]*|\[[^[\]]*\])*)]\(([^)]*)\)/g;

export function parseLinksFromHeading(content: string, heading: string, sourcePath: string): LinkItem[] {
  const lines = content.split(/\r?\n/);
  const normalizedHeading = normalizeHeadingText(heading);
  if (!normalizedHeading) {
    return [];
  }
  const links: LinkItem[] = [];
  let linkIndex = 0;

  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inSection) {
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      const headingText = headingMatch?.[2];
      if (headingText && normalizeHeadingText(headingText) === normalizedHeading) {
        inSection = true;
      }
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      break;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (!bullet) {
      continue;
    }

    const bodyRaw = bullet[1];
    if (!bodyRaw) {
      continue;
    }
    const body = bodyRaw.trim();

    const markdownLinkRe = new RegExp(MARKDOWN_LINK_RE);
    for (const match of body.matchAll(markdownLinkRe)) {
      const titleRaw = match[1] ?? "";
      const urlRaw = match[2] ?? "";
      const title = titleRaw;
      const url = sanitizeUrl(urlRaw);
      if (url === null) {
        continue;
      }
      links.push({ title, url, key: `${sourcePath}|${String(linkIndex)}` });
      linkIndex += 1;
    }
  }

  return links;
}

function normalizeHeadingText(raw: string): string {
  return raw
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .trim()
    .toLowerCase();
}

function sanitizeUrl(raw: string): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = raw.trim().replace(/[)>.,;]+$/, "");
  if (cleaned.length === 0) {
    return "";
  }
  try {
    return new URL(cleaned).toString();
  } catch {
    return cleaned;
  }
}
