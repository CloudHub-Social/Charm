import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SeenByChips } from "./SeenByChips";
import { renderWithProviders } from "@/test/renderWithProviders";

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

  it("clicking the overflow '+N' chip expands the full ordered seen-by list", () => {
    const readers = ["@a:localhost", "@b:localhost", "@c:localhost", "@d:localhost", "@e:localhost"];
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
});
