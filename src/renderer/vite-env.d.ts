/// <reference types="vite/client" />

import type { VerbooDesktopApi } from './verboo-bridge'

declare global {
  interface Window {
    verboo: VerbooDesktopApi
  }
}
