/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHARM_BUILD_TARGET?: "tauri" | "web";
  readonly VITE_CHARM_WEB_API_BASE_URL?: string;
  readonly VITE_CHARM_DEFAULT_HOMESERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
