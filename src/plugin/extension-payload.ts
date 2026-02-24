import type { DesiredFolder, Project2ChromeSettings } from "./types";

export interface ExtensionSyncPayload {
  rootFolderName: string;
  desired: DesiredFolder[];
  generatedAt: string;
}

export function buildExtensionSyncPayload(desired: DesiredFolder[], settings: Project2ChromeSettings): ExtensionSyncPayload {
  return {
    rootFolderName: resolveRootFolderName(settings),
    desired,
    generatedAt: new Date().toISOString()
  };
}

function resolveRootFolderName(settings: Project2ChromeSettings): string {
  if (settings.bookmarkBarRootMode === "target") {
    const trimmed = settings.targetFolderPath.trim().replace(/\/+$/, "");
    const parts = trimmed.split("/").filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? "Projects";
  }
  return settings.bookmarkBarRootCustomName.trim() || "Projects";
}
