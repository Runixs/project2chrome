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

export interface PluginState {
  managedFolderIds: Record<string, string>;
  managedBookmarkIds: Record<string, string>;
}

export interface Project2ChromeSettings {
  targetFolderPath: string;
  linkHeading: string;
  chromeBookmarksFileByOs: {
    macos: string;
    linux: string;
    windows: string;
  };
  bookmarkBarRootMode: "custom" | "target";
  bookmarkBarRootCustomName: string;
  autoSync: boolean;
  debounceMs: number;
  state: PluginState;
}

export const DEFAULT_SETTINGS: Project2ChromeSettings = {
  targetFolderPath: "1_Projects",
  linkHeading: "Link",
  chromeBookmarksFileByOs: {
    macos: "~/Library/Application Support/Google/Chrome/Default/Bookmarks",
    linux: "~/.config/google-chrome/Default/Bookmarks",
    windows: "~/AppData/Local/Google/Chrome/User Data/Default/Bookmarks"
  },
  bookmarkBarRootMode: "custom",
  bookmarkBarRootCustomName: "Projects",
  autoSync: true,
  debounceMs: 700,
  state: {
    managedFolderIds: {},
    managedBookmarkIds: {}
  }
};
