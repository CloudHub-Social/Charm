import { createElement, useState, type PropsWithChildren, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { AppShell, type MobileView } from "./AppShell";
import { settingsOpenAtom } from "@/features/settings/settingsAtoms";

const mockUseAdaptiveLayout = vi.fn();
vi.mock("./useAdaptiveLayout", () => ({
  useAdaptiveLayout: () => mockUseAdaptiveLayout(),
}));

/** Mirrors how `RoomsScreen` owns `mobileView` and passes it down controlled. */
function Harness({
  activeRoomId,
  selectionRequestId = 0,
  rightPanel = null,
  initialMobileView = "list",
  isSettingsActive = false,
}: {
  activeRoomId: string | null;
  selectionRequestId?: number;
  rightPanel?: ReactNode;
  initialMobileView?: MobileView;
  isSettingsActive?: boolean;
}) {
  const [mobileView, setMobileView] = useState<MobileView>(initialMobileView);
  return (
    <AppShell
      activeRoomId={activeRoomId}
      selectionRequestId={selectionRequestId}
      mobileView={mobileView}
      onMobileViewChange={setMobileView}
      isSettingsActive={isSettingsActive}
      roomList={<div>room-list</div>}
      peopleList={<div>people-list</div>}
      content={<div>chat-content</div>}
      rightPanel={rightPanel}
    />
  );
}

function renderShell(
  activeRoomId: string | null,
  options: {
    rightPanel?: ReactNode;
    selectionRequestId?: number;
    store?: ReturnType<typeof createStore>;
  } = {},
) {
  const store = options.store ?? createStore();
  const wrapper = ({ children }: PropsWithChildren) => createElement(Provider, { store }, children);
  const view = render(
    <Harness
      activeRoomId={activeRoomId}
      selectionRequestId={options.selectionRequestId}
      rightPanel={options.rightPanel}
    />,
    { wrapper },
  );
  return { store, ...view };
}

describe("AppShell", () => {
  it("renders the sidebar layout (room list, content, right panel side by side) on desktop", () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    renderShell("!room:example.org", { rightPanel: <div>right-panel</div> });

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

  it("shows the right panel instead of chat content in mobile detail view when it's open", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderShell("!room:example.org", { rightPanel: <div>right-panel</div> });

    expect(screen.getByText("right-panel")).toBeInTheDocument();
    expect(screen.queryByText("chat-content")).not.toBeInTheDocument();
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
    const { store } = renderShell(null);

    fireEvent.click(screen.getByRole("button", { name: /settings/i }));

    expect(store.get(settingsOpenAtom)).toBe("account");
  });

  it("marks Settings as current when isSettingsActive is true", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const store = createStore();
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(Provider, { store }, children);
    render(<Harness activeRoomId={null} isSettingsActive />, { wrapper });

    expect(screen.getByRole("button", { name: /settings/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("reopens the detail view when selectionRequestId bumps for the already-active room", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const store = createStore();
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(Provider, { store }, children);
    const { rerender } = render(
      <Harness activeRoomId="!room:example.org" selectionRequestId={1} />,
      { wrapper },
    );

    // Navigate back to the list without changing the active room — this is
    // the scenario the bug covers: tapping the same room again from the
    // list must still reopen detail, even though `activeRoomId` won't change.
    fireEvent.click(screen.getByRole("button", { name: /chats/i }));
    expect(screen.getByText("room-list")).toBeInTheDocument();

    rerender(
      <Provider store={store}>
        <Harness activeRoomId="!room:example.org" selectionRequestId={2} />
      </Provider>,
    );

    expect(screen.getByText("chat-content")).toBeInTheDocument();
  });
});
