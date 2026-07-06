import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AutocompletePopover, type AutocompleteItem } from "./AutocompletePopover";

const items: AutocompleteItem[] = [
  { key: "a", label: "Alice", sublabel: "@alice:example.org", leading: "@" },
  { key: "b", label: "Bob" },
];

describe("AutocompletePopover", () => {
  it("renders nothing when there are no items", () => {
    const { container } = render(
      <AutocompletePopover
        items={[]}
        activeIndex={0}
        onSelect={vi.fn()}
        position={{ top: 0, left: 0 }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders every item's label and sublabel", () => {
    render(
      <AutocompletePopover
        items={items}
        activeIndex={0}
        onSelect={vi.fn()}
        position={{ top: 10, left: 20 }}
      />,
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("@alice:example.org")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("marks the active item as selected", () => {
    render(
      <AutocompletePopover
        items={items}
        activeIndex={1}
        onSelect={vi.fn()}
        position={{ top: 0, left: 0 }}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("calls onSelect with the clicked item's index", () => {
    const onSelect = vi.fn();
    render(
      <AutocompletePopover
        items={items}
        activeIndex={0}
        onSelect={onSelect}
        position={{ top: 0, left: 0 }}
      />,
    );
    fireEvent.mouseDown(screen.getByText("Bob"));
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});
