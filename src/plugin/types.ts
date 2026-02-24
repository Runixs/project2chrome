export interface LinkItem {
  title: string;
  url: string;
  key: string;
}

export interface DesiredFolder {
  key: string;
  path: string;
  name: string;
  children: DesiredFolder[];
  links: LinkItem[];
}

export interface Project2ChromeSettings {
  targetFolderPath: string;
  linkHeading: string;
  bookmarkBarRootMode: "custom" | "target";
  bookmarkBarRootCustomName: string;
  autoSync: boolean;
  debounceMs: number;
  extensionBridgeEnabled: boolean;
  extensionBridgePort: number;
  extensionBridgeToken: string;
}

export const DEFAULT_SETTINGS: Project2ChromeSettings = {
  targetFolderPath: "1_Projects",
  linkHeading: "Link",
  bookmarkBarRootMode: "custom",
  bookmarkBarRootCustomName: "Projects",
  autoSync: true,
  debounceMs: 700,
  extensionBridgeEnabled: true,
  extensionBridgePort: 27123,
  extensionBridgeToken: "project2chrome-local"
};
