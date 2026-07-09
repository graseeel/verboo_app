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
