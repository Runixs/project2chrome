export function extractBookmarkNameFromFrontmatter(content: string): string | null {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    return null;
  }

  const rawValue = frontmatter.get("bookmark_name");
  if (rawValue == null) {
    return null;
  }

  const normalized = stripWrappingQuotes(rawValue.trim()).trim();
  return normalized.length > 0 ? normalized : null;
}

function extractFrontmatter(content: string): Map<string, string> | null {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") {
    return null;
  }

  const values = new Map<string, string>();

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line == null) {
      break;
    }

    if (line.trim() === "---") {
      return values;
    }

    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    if (!key) {
      continue;
    }
    const value = match[2] ?? "";
    values.set(key.trim(), value);
  }

  return null;
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    if (value.startsWith("\"") && value.endsWith("\"")) {
      return value.slice(1, -1);
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1);
    }
  }

  return value;
}
