/**
 * Folder-rename writeback: reflect a managed-key rename into the note's
 * `bookmark_name` frontmatter field.  All functions are pure — no file-system
 * or Obsidian API access.  The caller is responsible for reading and writing
 * the actual file.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FolderRenameOperation {
  /** Managed key, e.g. "folder:1_Projects/APS-45429" or "note:1_Projects/APS-47235.md" */
  managedKey: string;
  /** The new human-readable title to write as bookmark_name */
  newTitle: string;
  /** Absolute path to the vault root directory (no trailing slash required) */
  vaultBasePath: string;
}

export interface FolderRenameResult {
  success: boolean;
  /** Absolute path of the .md file that was (or would be) updated */
  targetPath?: string;
  /** Machine-readable failure reason when success is false */
  reason?: "unresolvable_key" | "file_not_found";
  /** Updated file content when success is true */
  newContent?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function trimTrailingSlash(p: string): string {
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

function getLastSegment(p: string): string {
  const trimmed = trimTrailingSlash(p);
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function joinPath(base: string, ...parts: string[]): string {
  const b = trimTrailingSlash(base);
  return [b, ...parts].join("/");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the vault-absolute path of the .md file that carries the
 * `bookmark_name` for the given managed key.
 *
 * - "note:<vaultRelPath>"   → <vaultBasePath>/<vaultRelPath>  (adds .md if absent)
 * - "folder:<vaultRelPath>" → <vaultBasePath>/<vaultRelPath>/<folderName>.md
 *   where folderName is the last path segment of vaultRelPath
 *
 * Returns null for any unrecognized key format.
 */
export function resolveFolderRenameTarget(
  op: FolderRenameOperation
): { targetFilePath: string } | null {
  const { managedKey, vaultBasePath } = op;

  if (managedKey.startsWith("note:")) {
    const relPath = managedKey.slice("note:".length);
    const filePath = relPath.toLowerCase().endsWith(".md")
      ? joinPath(vaultBasePath, relPath)
      : joinPath(vaultBasePath, `${relPath}.md`);
    return { targetFilePath: filePath };
  }

  if (managedKey.startsWith("folder:")) {
    const relPath = managedKey.slice("folder:".length);
    const folderName = getLastSegment(relPath);
    if (!folderName) {
      return null;
    }
    const filePath = joinPath(vaultBasePath, relPath, `${folderName}.md`);
    return { targetFilePath: filePath };
  }

  return null;
}

/**
 * Return updated file content with `bookmark_name` set to `newTitle`.
 *
 * Rules:
 * - If frontmatter exists and already has `bookmark_name`: replace the value.
 * - If frontmatter exists but `bookmark_name` is absent: insert it before the
 *   closing `---`.
 * - If no frontmatter exists: prepend a minimal frontmatter block.
 * - All other frontmatter fields and all body content are preserved exactly.
 */
export function applyFolderRenameWriteback(
  content: string,
  newTitle: string
): string {
  const newLine = `bookmark_name: ${newTitle}`;
  const lines = content.split(/\r?\n/);

  // No frontmatter → prepend block
  if (lines[0]?.trim() !== "---") {
    return `---\n${newLine}\n---\n${content}`;
  }

  let closingIndex = -1;
  let bookmarkNameIndex = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line == null) break;

    if (line.trim() === "---") {
      closingIndex = i;
      break;
    }

    if (/^bookmark_name\s*:/.test(line)) {
      bookmarkNameIndex = i;
    }
  }

  // Malformed frontmatter (no closing ---) → prepend fresh block
  if (closingIndex === -1) {
    return `---\n${newLine}\n---\n${content}`;
  }

  if (bookmarkNameIndex !== -1) {
    // Replace existing value in-place
    lines[bookmarkNameIndex] = newLine;
  } else {
    // Insert before the closing ---
    lines.splice(closingIndex, 0, newLine);
  }

  return lines.join("\n");
}

/**
 * Orchestrate: resolve target → read file → apply writeback.
 *
 * The `readFile` callback must return the file's UTF-8 content, or null if
 * the file does not exist (or cannot be read).  No file-system I/O is
 * performed inside this function.
 */
export function processFolderRename(
  op: FolderRenameOperation,
  readFile: (path: string) => string | null
): FolderRenameResult {
  const resolved = resolveFolderRenameTarget(op);
  if (resolved === null) {
    return { success: false, reason: "unresolvable_key" };
  }

  const content = readFile(resolved.targetFilePath);
  if (content === null) {
    return { success: false, reason: "file_not_found" };
  }

  const newContent = applyFolderRenameWriteback(content, op.newTitle);
  return { success: true, targetPath: resolved.targetFilePath, newContent };
}
