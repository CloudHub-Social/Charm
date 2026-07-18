import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SeenByChips } from "./SeenByChips";
import { renderWithProviders } from "@/test/renderWithProviders";
import { useFlag } from "@/featureFlags";
import type * as FeatureFlagsModule from "@/featureFlags";

vi.mock("@/featureFlags", async () => {
  const actual = await vi.importActual<typeof FeatureFlagsModule>("@/featureFlags");
  return { ...actual, useFlag: vi.fn(() => true) };
});

describe("SeenByChips", () => {
  it("renders nothing when there are no readers", () => {
    const { container } = renderWithProviders(
      <SeenByChips readers={[]} senderNameByUserId={new Map()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("has no overflow trigger when readers fit within MAX_RECEIPT_AVATARS", () => {
    renderWithProviders(
      <SeenByChips
        readers={["@alice:localhost", "@bob:localhost"]}
        senderNameByUserId={new Map()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not wrap the chip stack in a triggerless Popover when nothing overflows (review fix)", () => {
    // Review fix: `PopoverTrigger` only ever renders in the overflow
    // branch — wrapping the stack in `<Popover>` regardless left a
    // `PopoverContent` with no trigger to ever open it whenever
    // presence_privacy_controls was on but there was nothing to overflow.
    renderWithProviders(
      <SeenByChips
        readers={["@alice:localhost", "@bob:localhost"]}
        senderNameByUserId={new Map()}
      />,
    );
    expect(screen.queryByText(/^Seen by/)).not.toBeInTheDocument();
  });

  it("clicking the overflow '+N' chip expands the full ordered seen-by list", () => {
    const readers = [
      "@a:localhost",
      "@b:localhost",
      "@c:localhost",
      "@d:localhost",
      "@e:localhost",
    ];
    const senderNameByUserId = new Map([
      ["@a:localhost", "Alice"],
      ["@d:localhost", "Dave"],
    ]);
    renderWithProviders(<SeenByChips readers={readers} senderNameByUserId={senderNameByUserId} />);

    const overflowButton = screen.getByRole("button", { name: /Seen by 5 people/i });
    expect(overflowButton).toHaveTextContent("+2");

    fireEvent.click(overflowButton);

    expect(screen.getByText("Seen by 5")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Dave")).toBeInTheDocument();
    // Readers without a resolved display name fall back to the raw user id.
    expect(screen.getByText("@b:localhost")).toBeInTheDocument();
  });

  it("falls back to a static, non-interactive '+N' when presence_privacy_controls is off", () => {
    vi.mocked(useFlag).mockReturnValueOnce(false);
    const readers = [
      "@a:localhost",
      "@b:localhost",
      "@c:localhost",
      "@d:localhost",
      "@e:localhost",
    ];
    renderWithProviders(<SeenByChips readers={readers} senderNameByUserId={new Map()} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });
});
