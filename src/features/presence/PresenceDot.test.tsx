import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLastActiveAgo, PresenceDot } from "./PresenceDot";
import { renderWithProviders, wrapWithProviders } from "@/test/renderWithProviders";
import type * as FeatureFlagsModule from "@/featureFlags";

vi.mock("@/featureFlags", async () => {
  const actual = await vi.importActual<typeof FeatureFlagsModule>("@/featureFlags");
  return { ...actual, useFlag: vi.fn(() => true) };
});

describe("formatLastActiveAgo", () => {
  it("formats sub-minute durations as 'just now'", () => {
    expect(formatLastActiveAgo(5_000)).toBe("Active just now");
  });

  it("formats minutes", () => {
    expect(formatLastActiveAgo(5 * 60_000)).toBe("Active 5m ago");
  });

  it("formats hours", () => {
    expect(formatLastActiveAgo(3 * 60 * 60_000)).toBe("Active 3h ago");
  });

  it("formats days", () => {
    expect(formatLastActiveAgo(2 * 24 * 60 * 60_000)).toBe("Active 2d ago");
  });
});

describe("PresenceDot", () => {
  it("renders nothing when presence is unknown", () => {
    const { container } = renderWithProviders(<PresenceDot presence={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a plain sr-only label with no status message or last-active", () => {
    renderWithProviders(<PresenceDot presence="online" />);
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("includes the status message and last-active-ago in the accessible text when provided", () => {
    renderWithProviders(
      <PresenceDot presence="online" statusMsg="Making cupcakes" lastActiveAgoMs={5 * 60_000} />,
    );
    expect(screen.getByText(/Online — Making cupcakes/)).toBeInTheDocument();
    expect(screen.getByText(/Active 5m ago/)).toBeInTheDocument();
  });

  it("ignores the status message and last-active detail when presence_privacy_controls is off (review fix)", async () => {
    const { useFlag } = await import("@/featureFlags");
    vi.mocked(useFlag).mockReturnValueOnce(false);
    renderWithProviders(
      <PresenceDot presence="online" statusMsg="Making cupcakes" lastActiveAgoMs={5 * 60_000} />,
    );
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByText(/Making cupcakes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Active 5m ago/)).not.toBeInTheDocument();
  });

  describe("last-active label aging (review fix)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps the last-active label aging across re-renders instead of freezing at the first-received value", () => {
      // Review fix: `lastActiveAgoMs` is a snapshot relative to whenever the
      // presence update carrying it arrived — formatting it directly every
      // render only produced the correct elapsed time at that exact
      // instant. A mounted-but-not-updated DM header/list row used to keep
      // showing the same stale "Active Xm ago" indefinitely.
      const { rerender, client } = renderWithProviders(
        <PresenceDot presence="online" lastActiveAgoMs={5 * 60_000} />,
      );
      expect(screen.getByText(/Active 5m ago/)).toBeInTheDocument();

      // Real time passes with no new presence update (the prop value is
      // unchanged) — only a later, unrelated re-render happens. Rerendered
      // through the same provider tree (`wrapWithProviders`, not a bare
      // `rerender(<PresenceDot .../>)`) so the component instance — and so
      // its anchor ref — actually persists across this rerender instead of
      // remounting from scratch.
      vi.setSystemTime(new Date("2026-01-01T00:03:00.000Z"));
      rerender(
        wrapWithProviders(<PresenceDot presence="online" lastActiveAgoMs={5 * 60_000} />, client),
      );

      expect(screen.getByText(/Active 8m ago/)).toBeInTheDocument();
    });

    it("re-anchors from a genuinely new lastActiveAgoMs value instead of compounding onto the old anchor", () => {
      const { rerender, client } = renderWithProviders(
        <PresenceDot presence="online" lastActiveAgoMs={5 * 60_000} />,
      );
      expect(screen.getByText(/Active 5m ago/)).toBeInTheDocument();

      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      // A genuinely new presence update arrives, reporting 1m ago as of
      // *this* render — must not be added on top of the previous anchor.
      rerender(
        wrapWithProviders(<PresenceDot presence="online" lastActiveAgoMs={1 * 60_000} />, client),
      );

      expect(screen.getByText(/Active 1m ago/)).toBeInTheDocument();
    });

    it("re-anchors from a fresh update even when it carries the exact same lastActiveAgoMs value (review fix)", () => {
      // Review fix (P3): re-anchoring keyed only on the numeric value
      // missed a genuinely fresh update that happens to report the same
      // duration as the last one — e.g. two consecutive "just now" (`0`)
      // pings. Without `updateToken` (here, a fresh object per update,
      // mirroring `usePresence`'s real return value) the anchor wouldn't
      // reset, and the label would keep aging from the *first* update's
      // arrival time well past when the second one landed.
      const { rerender, client } = renderWithProviders(
        <PresenceDot presence="online" lastActiveAgoMs={0} updateToken={{ id: 1 }} />,
      );
      expect(screen.getByText(/Active just now/)).toBeInTheDocument();

      // Real time passes, then a second, genuinely fresh "just now" update
      // arrives — same `lastActiveAgoMs` value, but a new update identity.
      vi.setSystemTime(new Date("2026-01-01T00:30:00.000Z"));
      rerender(
        wrapWithProviders(
          <PresenceDot presence="online" lastActiveAgoMs={0} updateToken={{ id: 2 }} />,
          client,
        ),
      );

      expect(screen.getByText(/Active just now/)).toBeInTheDocument();
    });

    it("ages the label on its own via a periodic timer, with no external re-render trigger", () => {
      // Review fix: re-anchoring alone only recomputes the displayed label
      // when *something else* causes a re-render. A long-mounted component
      // that receives no further presence updates and has no unrelated
      // parent re-renders (the common case for a DM header/list row left
      // open) used to keep showing a frozen label forever, since nothing
      // was scheduling a render purely to let time pass. This test never
      // calls `rerender` — only fake-timer advancement — so it fails
      // without the interval driving its own re-render.
      renderWithProviders(<PresenceDot presence="online" lastActiveAgoMs={5 * 60_000} />);
      expect(screen.getByText(/Active 5m ago/)).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(3 * 60_000);
      });

      expect(screen.getByText(/Active 8m ago/)).toBeInTheDocument();
    });
  });
});
