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
  useFolderNotesPlugin: boolean;
  bookmarkBarRootMode: "custom" | "target";
  bookmarkBarRootCustomName: string;
  autoSync: boolean;
  debounceMs: number;
  extensionBridgeServerEnabled: boolean;
  extensionBridgeServerPort: number;
  extensionBridgeServerPath: string;
  extensionBridgeHeartbeatMs: number;
  extensionBridgeClients: ExtensionBridgeClient[];
  extensionBridgeActiveClientId: string;
  reverseDebugEnabled: boolean;
  reverseDebugNoticeOnError: boolean;
}

export interface ExtensionBridgeClient {
  clientId: string;
  token: string;
  enabled: boolean;
  scopes: string[];
}

export const DEFAULT_SETTINGS: Project2ChromeSettings = {
  targetFolderPath: "1_Projects",
  linkHeading: "Link",
  useFolderNotesPlugin: false,
  bookmarkBarRootMode: "custom",
  bookmarkBarRootCustomName: "Projects",
  autoSync: true,
  debounceMs: 700,
  extensionBridgeServerEnabled: true,
  extensionBridgeServerPort: 27123,
  extensionBridgeServerPath: "/ws",
  extensionBridgeHeartbeatMs: 30000,
  extensionBridgeClients: [
    {
      clientId: "local-event-gateway",
      token: "project2chrome-local",
      enabled: true,
      scopes: ["sync:read", "sync:write"]
    }
  ],
  extensionBridgeActiveClientId: "local-event-gateway",
  reverseDebugEnabled: true,
  reverseDebugNoticeOnError: true
};
