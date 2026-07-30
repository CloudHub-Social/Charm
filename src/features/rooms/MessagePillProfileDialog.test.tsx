import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMutualRooms, getUserProfile } from "@/lib/matrix";
import { MessagePillProfileDialog } from "./MessagePillProfileDialog";

vi.mock("@/lib/matrix", () => ({
  getUserProfile: vi.fn(),
  getMutualRooms: vi.fn(),
}));

function renderDialog(props: Partial<Parameters<typeof MessagePillProfileDialog>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onNavigateToRoom = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MessagePillProfileDialog
        profile={{ userId: "@alice:example.org", label: "Alice" }}
        onClose={onClose}
        onNavigateToRoom={onNavigateToRoom}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose, onNavigateToRoom };
}

describe("MessagePillProfileDialog", () => {
  beforeEach(() => {
    vi.mocked(getUserProfile).mockReset();
    vi.mocked(getMutualRooms).mockReset();
  });

  it("shows the pill identity and closes through the dialog control", () => {
    const { onClose } = renderDialog();

    expect(screen.getByRole("heading", { name: "Alice" })).toBeInTheDocument();
    expect(screen.getByText("@alice:example.org")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("loads canonical profile details and navigates to a mutual room", async () => {
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice Global",
      avatar_url: null,
      avatar_path: null,
      room_display_name: "Alice Here",
      room_avatar_url: null,
      room_avatar_path: null,
      presence: {
        user_id: "@alice:example.org",
        presence: "online",
        status_msg: "Writing tests",
        last_active_ago_ms: null,
      },
    });
    vi.mocked(getMutualRooms).mockResolvedValue([
      {
        room_id: "!mutual:example.org",
        name: "Mutual Room",
        avatar_url: null,
        avatar_path: null,
        is_direct: false,
        is_space: false,
      },
    ]);

    const { onClose, onNavigateToRoom } = renderDialog({
      detailed: true,
      roomId: "!current:example.org",
    });

    expect(await screen.findByRole("heading", { name: "Alice Here" })).toBeInTheDocument();
    expect(screen.getByText("online · Writing tests")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mutual Room" }));
    expect(onNavigateToRoom).toHaveBeenCalledWith("!mutual:example.org");
    expect(onClose).toHaveBeenCalledOnce();
    expect(getUserProfile).toHaveBeenCalledWith("@alice:example.org", "!current:example.org");
  });
});
