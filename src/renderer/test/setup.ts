import '@testing-library/jest-dom/vitest'

// jsdom does not implement matchMedia — many components check it for theme
// detection. Provide a no-op stub so imports don't crash during tests.
if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// jsdom does not implement localStorage in Node.js (needs
// --localstorage-file). Stub it so chatStore unit tests can round-trip.
const storage: Record<string, string> = {}
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string): string | null => storage[key] ?? null,
    setItem: (key: string, value: string): void => { storage[key] = value },
    removeItem: (key: string): void => { delete storage[key] },
    clear: (): void => { for (const k in storage) delete storage[k] },
    get length() { return Object.keys(storage).length },
    key: (index: number): string | null => Object.keys(storage)[index] ?? null,
  },
  writable: true,
})

// jsdom lacks IntersectionObserver — stub it so hooks that observe elements
// don't throw during render.
if (!('IntersectionObserver' in window)) {
  // @ts-expect-error — minimal stub for tests
  window.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
}
