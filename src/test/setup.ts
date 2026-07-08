import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement IntersectionObserver — ChatShell's "mark read when
// the last message scrolls into view" logic (Spec 05) uses one, so components
// that mount it need at least a no-op stub to avoid a ReferenceError.
if (typeof globalThis.IntersectionObserver === "undefined") {
  class MockIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly thresholds: ReadonlyArray<number>;
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
      void callback;
      this.root = options.root ?? null;
      this.rootMargin = options.rootMargin ?? "";
      const threshold = options.threshold ?? 0;
      this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
    }
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

// jsdom's `localStorage` needs `--localstorage-file` to actually persist and
// is otherwise `undefined` in this project's config — but Charm 2.0 Spec 09's
// appearance persistence write-throughs to `localStorage` as a synchronous
// mirror for the flash-free boot script, so tests need a real (in-memory)
// implementation, not just a no-op stub.
if (typeof globalThis.localStorage === "undefined") {
  class MemoryStorage implements Storage {
    #store = new Map<string, string>();

    get length(): number {
      return this.#store.size;
    }

    clear(): void {
      this.#store.clear();
    }

    getItem(key: string): string | null {
      return this.#store.has(key) ? this.#store.get(key)! : null;
    }

    key(index: number): string | null {
      return Array.from(this.#store.keys())[index] ?? null;
    }

    removeItem(key: string): void {
      this.#store.delete(key);
    }

    setItem(key: string, value: string): void {
      this.#store.set(key, value);
    }
  }

  globalThis.localStorage = new MemoryStorage();
}
