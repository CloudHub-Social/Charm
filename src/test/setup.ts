import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement IntersectionObserver — ChatShell's "mark read when
// the last message scrolls into view" logic (Spec 05) uses one, so components
// that mount it need at least a no-op stub to avoid a ReferenceError.
if (typeof globalThis.IntersectionObserver === "undefined") {
  class MockIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = "";
    readonly thresholds: ReadonlyArray<number> = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  globalThis.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;
}
