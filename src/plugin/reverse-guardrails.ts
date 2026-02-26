export type ManagedKeySet = {
  managedNotePaths: Set<string>;
  managedFolderPaths: Set<string>;
};

export type GuardrailResult = {
  eligible: boolean;
  reason?: string;
};

/**
 * Validates that a managedKey refers to a known managed resource.
 * Returns { eligible: false, reason: "skipped_unmanaged" } for any key
 * whose resolved path is not found in the provided ManagedKeySet.
 */
export function validateManagedKey(managedKey: string, knownKeys: ManagedKeySet): GuardrailResult {
  if (managedKey.startsWith("note:")) {
    const path = managedKey.slice("note:".length).trim();
    if (!path) {
      return { eligible: false, reason: "skipped_unmanaged" };
    }
    return knownKeys.managedNotePaths.has(path)
      ? { eligible: true }
      : { eligible: false, reason: "skipped_unmanaged" };
  }

  if (managedKey.startsWith("folder:")) {
    const path = managedKey.slice("folder:".length).trim();
    if (!path) {
      return { eligible: false, reason: "skipped_unmanaged" };
    }
    return knownKeys.managedFolderPaths.has(path)
      ? { eligible: true }
      : { eligible: false, reason: "skipped_unmanaged" };
  }

  // Try link key format: <sourcePath>|<linkIndex>
  const separator = managedKey.lastIndexOf("|");
  if (separator < 1 || separator === managedKey.length - 1) {
    return { eligible: false, reason: "skipped_unmanaged" };
  }

  const sourcePath = managedKey.slice(0, separator).trim();
  const rawIndex = managedKey.slice(separator + 1).trim();

  if (!sourcePath || !/^\d+$/.test(rawIndex)) {
    return { eligible: false, reason: "skipped_unmanaged" };
  }

  return knownKeys.managedNotePaths.has(sourcePath)
    ? { eligible: true }
    : { eligible: false, reason: "skipped_unmanaged" };
}

/**
 * For link keys (<sourcePath>|<linkIndex>), checks whether the linkIndex is
 * within the bounds of the link section in the given file content.
 * An index strictly greater than the current link count is considered ambiguous.
 *
 * For note: and folder: keys, always returns { eligible: true } — ambiguity
 * is handled downstream by the writeback engine.
 */
export function checkAmbiguity(
  managedKey: string,
  content: string,
  linkHeading: string
): GuardrailResult {
  const separator = managedKey.lastIndexOf("|");
  if (separator < 1 || separator === managedKey.length - 1) {
    // Not a link key (note:/folder:/ or unrecognized) — no ambiguity check here
    return { eligible: true };
  }

  const rawIndex = managedKey.slice(separator + 1).trim();
  if (!/^\d+$/.test(rawIndex)) {
    // Not a numeric index — not a link key
    return { eligible: true };
  }

  const linkIndex = Number.parseInt(rawIndex, 10);
  if (!Number.isFinite(linkIndex) || linkIndex < 0) {
    return { eligible: false, reason: "skipped_ambiguous" };
  }

  const linkCount = countLinksInSection(content, linkHeading);

  // Allow linkIndex == linkCount for append/create operations; reject strictly beyond that
  if (linkIndex > linkCount) {
    return { eligible: false, reason: "skipped_ambiguous" };
  }

  return { eligible: true };
}

/**
 * Counts valid markdown link bullet items (`- [title](url)`) in the
 * section identified by the given link heading within the content.
 * Returns 0 if the heading is not found.
 */
function countLinksInSection(content: string, linkHeading: string): number {
  const lines = content.split(/\r?\n/);
  const normalizedTarget = normalizeHeadingText(linkHeading);

  if (!normalizedTarget) {
    return 0;
  }

  let inSection = false;
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inSection) {
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      const headingText = headingMatch?.[2];
      if (headingText && normalizeHeadingText(headingText) === normalizedTarget) {
        inSection = true;
        continue;
      }
      // Support bare (non-prefixed) heading lines matching the target
      if (!headingMatch && normalizeHeadingText(trimmed) === normalizedTarget) {
        inSection = true;
        continue;
      }
    } else {
      // Next heading closes the section
      if (/^#{1,6}\s+/.test(trimmed)) {
        break;
      }
      // Count valid markdown link bullet items only
      if (/^\s*[-*+]\s+\[.+\]\([^)]+\)/.test(line)) {
        count++;
      }
    }
  }

  return count;
}

function normalizeHeadingText(raw: string): string {
  return raw
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .trim()
    .toLowerCase();
}
