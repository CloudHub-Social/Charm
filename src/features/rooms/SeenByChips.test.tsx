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

  // Review fix: the whole chip stack is clickable even when nothing
  // overflows (readers.length <= MAX_RECEIPT_AVATARS) — previously only the
  // "+N" overflow chip was wrapped in a `PopoverTrigger`, so this common
  // case (1-2 readers) rendered a static, non-clickable stack with no way
  // to open the full "Seen by" list at all.
  it("the chip stack itself is clickable and opens the full list when nothing overflows", () => {
    renderWithProviders(
      <SeenByChips
        readers={["@alice:localhost", "@bob:localhost"]}
        senderNameByUserId={new Map()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Seen by 2 people/i });

    fireEvent.click(trigger);

    expect(screen.getByText("Seen by 2")).toBeInTheDocument();
    expect(screen.getByText("@alice:localhost")).toBeInTheDocument();
    expect(screen.getByText("@bob:localhost")).toBeInTheDocument();
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

  // Review fix: `className` (e.g. a caller's layout spacing) must land on
  // the outer `<button>` once `expandableListEnabled` wraps the stack in
  // one — it used to be applied to the inner chip-row `div` instead,
  // leaving the actual outer box without the caller's intended margin.
  it("applies the className prop to the outer button when the stack is wrapped in a popover trigger", () => {
    renderWithProviders(
      <SeenByChips
        readers={["@alice:localhost", "@bob:localhost"]}
        senderNameByUserId={new Map()}
        className="mt-0.5"
      />,
    );
    const trigger = screen.getByRole("button", { name: /Seen by 2 people/i });
    expect(trigger.className).toContain("mt-0.5");
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
