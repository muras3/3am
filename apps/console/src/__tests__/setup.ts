import "@testing-library/jest-dom";

// jsdom does not implement ResizeObserver — stub it for components that use it
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof globalThis.ResizeObserver;
