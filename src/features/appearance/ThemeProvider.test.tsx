import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "./ThemeProvider";

const storeGet = vi.fn();
const load = vi.fn();

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => load(...args),
}));

// `Object.defineProperty` — not `vi.stubGlobal` — is what actually reaches
// `window.matchMedia` in this jsdom setup (see dom.test.ts). It's a real
// property mutation, not a vi-tracked stub, so it must be restored by hand
// or it leaks into whichever test file vitest runs next in the same worker.
const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");

function restoreMatchMedia() {
  if (originalMatchMediaDescriptor) {
    Object.defineProperty(window, "matchMedia", originalMatchMediaDescriptor);
  } else {
    Reflect.deleteProperty(window, "matchMedia");
  }
}

beforeEach(() => {
  localStorage.clear();
  storeGet.mockReset();
  load.mockReset().mockResolvedValue({ get: storeGet, set: vi.fn() });
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-density");
  document.documentElement.removeAttribute("data-font-size");
  document.documentElement.removeAttribute("data-reduced-motion");
});

afterEach(() => {
  // Unmount every rendered ThemeProvider so its matchMedia change-listener
  // effect actually tears down — without this, a stale listener from an
  // earlier test (holding a closure over that test's mock matchMedia
  // object) can still fire during a later test in this file and clobber its
  // dataset assertions.
  cleanup();
  restoreMatchMedia();
  vi.restoreAllMocks();
});

describe("ThemeProvider", () => {
  it("renders children immediately without blocking on reconciliation", () => {
    storeGet.mockResolvedValue(undefined);
    render(
      <Provider store={createStore()}>
        <ThemeProvider>
          <div>app content</div>
        </ThemeProvider>
      </Provider>,
    );
    expect(screen.getByText("app content")).toBeInTheDocument();
  });

  it("reconciles the DOM to the persisted store value after mount", async () => {
    storeGet.mockResolvedValue({
      theme: "midnight",
      fontSize: "lg",
      density: "compact",
      reducedMotion: "on",
    });
    render(
      <Provider store={createStore()}>
        <ThemeProvider>
          <div>app content</div>
        </ThemeProvider>
      </Provider>,
    );
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("midnight"));
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.dataset.fontSize).toBe("lg");
    expect(document.documentElement.dataset.reducedMotion).toBe("on");
  });

  it("falls back to the localStorage mirror when the store plugin is unavailable", async () => {
    load.mockRejectedValue(new Error("no host"));
    localStorage.setItem(
      "charm:appearance",
      JSON.stringify({ theme: "light", fontSize: "sm", density: "cozy", reducedMotion: "off" }),
    );
    render(
      <Provider store={createStore()}>
        <ThemeProvider>
          <div>app content</div>
        </ThemeProvider>
      </Provider>,
    );
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(document.documentElement.dataset.fontSize).toBe("sm");
  });

  // `Object.defineProperty(window, "matchMedia", ...)` — not `vi.stubGlobal`
  // — is the pattern that actually reaches the component's `window.matchMedia`
  // call in this jsdom setup (see dom.test.ts's `mockMatchMedia` helper).
  function mockMatchMedia(initialMatches: boolean) {
    let changeHandler: (() => void) | undefined;
    let matches = initialMatches;
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return matches;
        },
        media: query,
        addEventListener: (_event: string, handler: () => void) => {
          changeHandler = handler;
        },
        removeEventListener: vi.fn(),
      })),
    });
    return {
      setMatches: (next: boolean) => {
        matches = next;
      },
      fireChange: () => changeHandler?.(),
      hasSubscribed: () => changeHandler !== undefined,
    };
  }

  it("reacts live to an OS color-scheme change when the theme choice is system", async () => {
    storeGet.mockResolvedValue({
      theme: "system",
      fontSize: "md",
      density: "cozy",
      reducedMotion: "system",
    });
    const { setMatches, fireChange, hasSubscribed } = mockMatchMedia(false);

    render(
      <Provider store={createStore()}>
        <ThemeProvider>
          <div>app content</div>
        </ThemeProvider>
      </Provider>,
    );

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    // The matchMedia-subscription effect only (re-)runs once the `theme`
    // atom itself has updated to "system" and React has flushed that
    // effect — which can be a tick after the dataset attribute above (set
    // directly by the reconcile effect) is already visible. Wait for the
    // subscription itself before firing a change, or `fireChange()` below
    // can be a no-op against a `changeHandler` that hasn't been assigned yet.
    await waitFor(() => expect(hasSubscribed()).toBe(true));

    setMatches(true);
    fireChange();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  });

  it("ignores an OS color-scheme change when the theme choice is not system", async () => {
    storeGet.mockResolvedValue({
      theme: "light",
      fontSize: "md",
      density: "cozy",
      reducedMotion: "system",
    });
    const { fireChange } = mockMatchMedia(true);

    render(
      <Provider store={createStore()}>
        <ThemeProvider>
          <div>app content</div>
        </ThemeProvider>
      </Provider>,
    );

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

    fireChange();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
