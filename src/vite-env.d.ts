/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Engine base URL for plain-browser development, e.g. http://127.0.0.1:4096 */
  readonly VITE_ENGINE_URL?: string
  readonly VITE_ENGINE_USER?: string
  readonly VITE_ENGINE_PASSWORD?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
