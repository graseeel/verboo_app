/// <reference types="vite/client" />

import type { VerbooDesktopApi } from '../preload'

declare global {
  interface Window {
    verboo: VerbooDesktopApi
  }
}
