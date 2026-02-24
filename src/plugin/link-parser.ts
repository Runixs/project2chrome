import type { LinkItem } from "./types";

const MARKDOWN_LINK_RE = /\[((?:[^[\]]+|\[[^[\]]*\])+)\]\((https?:\/\/[^)\s]+)\)/g;

export function parseLinksFromHeading(content: string, heading: string, sourcePath: string): LinkItem[] {
  const lines = content.split(/\r?\n/);
  const normalizedHeading = normalizeHeadingText(heading);
  if (!normalizedHeading) {
    return [];
  }
  const links: LinkItem[] = [];
  const seen = new Set<string>();

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
      const titleRaw = match[1];
      const urlRaw = match[2];
      if (!titleRaw || !urlRaw) {
        continue;
      }
      const title = titleRaw.trim();
      const url = sanitizeUrl(urlRaw);
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      links.push({ title: title.length > 0 ? title : url, url, key: `${sourcePath}|${url}` });
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
  const cleaned = raw.trim().replace(/[)>.,;]+$/, "");
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
