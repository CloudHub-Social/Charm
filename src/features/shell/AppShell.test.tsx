import { createElement, type PropsWithChildren } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { settingsOpenAtom } from "@/features/settings/settingsAtoms";

const mockUseAdaptiveLayout = vi.fn();
vi.mock("./useAdaptiveLayout", () => ({
  useAdaptiveLayout: () => mockUseAdaptiveLayout(),
}));

function renderShell(activeRoomId: string | null, store = createStore()) {
  const wrapper = ({ children }: PropsWithChildren) => createElement(Provider, { store }, children);
  render(
    <AppShell
      activeRoomId={activeRoomId}
      roomList={<div>room-list</div>}
      peopleList={<div>people-list</div>}
      content={<div>chat-content</div>}
      rightPanel={<div>right-panel</div>}
    />,
    { wrapper },
  );
  return store;
}

describe("AppShell", () => {
  it("renders the sidebar layout (room list, content, right panel side by side) on desktop", () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    renderShell("!room:example.org");

    expect(screen.getByText("room-list")).toBeInTheDocument();
    expect(screen.getByText("chat-content")).toBeInTheDocument();
    expect(screen.getByText("right-panel")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("renders the bottom-nav layout with the room list by default on mobile", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderShell(null);

    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("room-list")).toBeInTheDocument();
    expect(screen.queryByText("right-panel")).not.toBeInTheDocument();
  });

  it("switches to the chat detail view once a room becomes active on mobile", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderShell("!room:example.org");

    expect(screen.getByText("chat-content")).toBeInTheDocument();
    expect(screen.queryByText("room-list")).not.toBeInTheDocument();
  });

  it("tapping the Chats tab returns to the list view", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderShell("!room:example.org");
    expect(screen.getByText("chat-content")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /chats/i }));

    expect(screen.getByText("room-list")).toBeInTheDocument();
  });

  it("tapping the People tab shows the people list", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderShell(null);

    fireEvent.click(screen.getByRole("button", { name: /people/i }));

    expect(screen.getByText("people-list")).toBeInTheDocument();
  });

  it("tapping Settings opens the settings overlay via settingsOpenAtom", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const store = renderShell(null);

    fireEvent.click(screen.getByRole("button", { name: /settings/i }));

    expect(store.get(settingsOpenAtom)).toBe("account");
  });
});
