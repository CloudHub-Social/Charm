import {
  createElement,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { ChatVisibilityContext } from "./chatVisibility";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, type MobileView } from "./AppShell";
import { settingsOpenAtom } from "@/features/settings/settingsAtoms";
import { verificationOverlayOpenAtom } from "@/features/verification/verificationAtoms";

const mockUseAdaptiveLayout = vi.fn();
const mockUseFlag = vi.hoisted(() => vi.fn(() => true));
const invokeDrag = vi.hoisted(() => vi.fn());
vi.mock("./useAdaptiveLayout", () => ({
  useAdaptiveLayout: () => mockUseAdaptiveLayout(),
}));
vi.mock("@/featureFlags", () => ({ useFlag: () => mockUseFlag() }));
vi.mock("@use-gesture/react", () => ({
  useDrag: (handler: (...args: unknown[]) => unknown) => {
    invokeDrag.mockImplementation(handler);
    return () => ({});
  },
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
      spaceRail={<div>space-rail</div>}
      roomList={<div>room-list</div>}
      mobileSpacesContent={<div>mobile-spaces</div>}
      content={<button onClick={() => setMobileView("list")}>chat-content</button>}
      rightPanel={rightPanel}
    />
  );
}

function VisibilityProbe() {
  return <output>{useContext(ChatVisibilityContext) ? "chat-visible" : "chat-hidden"}</output>;
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
  it.each(["desktop", "mobile"])(
    "hides capture and pauses media under Settings on %s",
    (layout) => {
      mockUseAdaptiveLayout.mockReturnValue(layout);
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      const props = {
        spaceRail: null,
        roomList: null,
        content: (
          <>
            <VisibilityProbe />
            <audio>
              <track kind="captions" />
            </audio>
            <video>
              <track kind="captions" />
            </video>
          </>
        ),
        rightPanel: null,
        activeRoomId: "!room:example.org",
        selectionRequestId: 0,
        mobileView: "detail" as const,
        onMobileViewChange: vi.fn(),
      };
      const view = render(<AppShell {...props} />);
      expect(screen.getByText("chat-visible")).toBeInTheDocument();
      expect(pause).not.toHaveBeenCalled();
      view.rerender(<AppShell {...props} isSettingsActive />);
      expect(screen.getByText("chat-hidden")).toBeInTheDocument();
      expect(pause).toHaveBeenCalledTimes(2);
      pause.mockRestore();
    },
  );

  it("hides capture and pauses media while verification covers the chat", () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const store = createStore();
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(Provider, { store }, children);
    render(
      <AppShell
        activeRoomId="!room:example.org"
        selectionRequestId={0}
        mobileView="detail"
        onMobileViewChange={vi.fn()}
        spaceRail={null}
        roomList={null}
        content={
          <>
            <VisibilityProbe />
            <audio>
              <track kind="captions" />
            </audio>
          </>
        }
        rightPanel={null}
      />,
      { wrapper },
    );
    expect(screen.getByText("chat-visible")).toBeInTheDocument();

    act(() => store.set(verificationOverlayOpenAtom, true));

    expect(screen.getByText("chat-hidden")).toBeInTheDocument();
    expect(pause).toHaveBeenCalledOnce();
    pause.mockRestore();
  });

  it("pauses retained media on mobile list and right-panel navigation", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const props = {
      spaceRail: null,
      roomList: null,
      content: (
        <audio>
          <track kind="captions" />
        </audio>
      ),
      rightPanel: null,
      activeRoomId: "!room:example.org",
      selectionRequestId: 0,
      onMobileViewChange: vi.fn(),
    };
    const view = render(<AppShell {...props} mobileView="detail" />);
    view.rerender(<AppShell {...props} mobileView="list" />);
    expect(pause).toHaveBeenCalledOnce();
    view.rerender(<AppShell {...props} mobileView="detail" />);
    view.rerender(<AppShell {...props} mobileView="detail" rightPanel={<div>info</div>} />);
    expect(pause).toHaveBeenCalledTimes(2);
    pause.mockRestore();
  });

  it("retains the upload owner through mobile navigation and disposes it on teardown", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const disposed = vi.fn();
    function UploadOwner() {
      useEffect(() => () => disposed(), []);
      return <div>upload-owner</div>;
    }
    const props = {
      spaceRail: <div>spaces</div>,
      roomList: <div>rooms</div>,
      content: <UploadOwner />,
      rightPanel: null,
      activeRoomId: "!room:example.org",
      selectionRequestId: 0,
      onMobileViewChange: vi.fn(),
    };
    const view = render(<AppShell {...props} mobileView="detail" />);
    view.rerender(<AppShell {...props} mobileView="list" />);
    expect(screen.getByText("upload-owner")).not.toBeVisible();
    expect(disposed).not.toHaveBeenCalled();
    view.rerender(<AppShell {...props} mobileView="detail" />);
    expect(screen.getByText("upload-owner")).toBeVisible();
    expect(disposed).not.toHaveBeenCalled();
    view.unmount();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("retains the upload owner across desktop and mobile breakpoints", () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    const disposed = vi.fn();
    function UploadOwner() {
      useEffect(() => () => disposed(), []);
      return <div>breakpoint-upload-owner</div>;
    }
    const props = {
      spaceRail: <div>spaces</div>,
      roomList: <div>rooms</div>,
      content: <UploadOwner />,
      rightPanel: null,
      activeRoomId: "!room:example.org",
      selectionRequestId: 0,
      mobileView: "detail" as const,
      onMobileViewChange: vi.fn(),
    };
    const view = render(<AppShell {...props} />);

    mockUseAdaptiveLayout.mockReturnValue("mobile");
    view.rerender(<AppShell {...props} />);
    expect(screen.getByText("breakpoint-upload-owner")).toBeVisible();
    expect(disposed).not.toHaveBeenCalled();

    mockUseAdaptiveLayout.mockReturnValue("desktop");
    view.rerender(<AppShell {...props} />);
    expect(disposed).not.toHaveBeenCalled();
    view.unmount();
    expect(disposed).toHaveBeenCalledOnce();
  });

  beforeEach(() => {
    mockUseFlag.mockReturnValue(true);
    invokeDrag.mockClear();
  });

  it("renders the sidebar layout (room list, content, right panel side by side) on desktop", () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    renderShell("!room:example.org", { rightPanel: <div>right-panel</div> });

    expect(screen.getByText("space-rail")).toBeInTheDocument();
    expect(screen.getByText("room-list")).toBeInTheDocument();
    expect(screen.getByText("chat-content")).toBeInTheDocument();
    const rightPanel = screen.getByText("right-panel");
    expect(rightPanel).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("uses a dedicated full-width Spaces root instead of squeezing the desktop rail onto mobile", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    render(
      <AppShell
        activeRoomId={null}
        selectionRequestId={0}
        mobileView="list"
        onMobileViewChange={vi.fn()}
        primaryDestination="spaces"
        spaceRail={<div>desktop-space-rail</div>}
        roomList={<div>room-list</div>}
        mobileSpacesContent={<main>mobile-spaces</main>}
        content={<div>chat-content</div>}
        rightPanel={null}
        onSelectSpaces={vi.fn()}
      />,
    );

    expect(screen.getByText("mobile-spaces")).toBeInTheDocument();
    expect(screen.queryByText("desktop-space-rail")).not.toBeInTheDocument();
    expect(screen.queryByText("room-list")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spaces" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the chat owner mounted but hidden while Activity replaces the workspace", () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    render(
      <AppShell
        activeRoomId="!room:example.org"
        selectionRequestId={0}
        mobileView="detail"
        onMobileViewChange={vi.fn()}
        primaryDestination="activity"
        destinationContent={<main>activity-feed</main>}
        spaceRail={<div>space-rail</div>}
        roomList={<div>room-list</div>}
        content={<VisibilityProbe />}
        rightPanel={null}
      />,
    );

    expect(screen.getByText("activity-feed")).toBeInTheDocument();
    expect(screen.queryByText("room-list")).not.toBeInTheDocument();
    expect(screen.getByText("chat-hidden")).not.toBeVisible();
  });

  it("renders the bottom-nav layout with the room list by default on mobile", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderShell(null);

    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.queryByText("space-rail")).not.toBeInTheDocument();
    expect(screen.getByText("room-list")).toBeInTheDocument();
    expect(screen.queryByText("right-panel")).not.toBeInTheDocument();
  });

  it("switches to the chat detail view once a room becomes active on mobile", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderShell("!room:example.org");

    expect(screen.getByText("chat-content")).toBeInTheDocument();
    expect(screen.queryByText("room-list")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-current", "page");
  });

  it("returns to the room list after a committed leading-edge swipe", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderShell("!room:example.org");

    act(() => {
      invokeDrag({
        first: true,
        last: false,
        initial: [8, 120],
        movement: [84, 2],
        velocity: [0.2, 0],
        direction: [1, 0],
        cancel: vi.fn(),
      });
    });
    expect(screen.getByText("chat-content").parentElement).toHaveStyle({
      transform: "translateX(84px)",
    });

    act(() => {
      invokeDrag({
        first: false,
        last: true,
        initial: [8, 120],
        movement: [84, 2],
        velocity: [0.2, 0],
        direction: [1, 0],
        cancel: vi.fn(),
      });
    });

    expect(screen.getByText("room-list")).toBeInTheDocument();
  });

  it("keeps the existing bottom navigation in room detail when the redesign flag is disabled", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    mockUseFlag.mockReturnValue(false);
    renderShell("!room:example.org");

    expect(screen.getByText("chat-content")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /chats/i })).not.toHaveAttribute("aria-current");
  });

  it("shows the right panel instead of chat content in mobile detail view when it's open", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderShell("!room:example.org", { rightPanel: <div>right-panel</div> });

    const rightPanel = screen.getByText("right-panel");
    expect(rightPanel).toBeInTheDocument();
    expect(rightPanel.parentElement).toHaveClass("min-h-0", "flex-1", "overflow-hidden");
    expect(screen.getByText("chat-content")).not.toBeVisible();
  });

  it("tapping Settings opens the settings overlay via settingsOpenAtom", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const { store } = renderShell(null);

    fireEvent.click(screen.getByRole("button", { name: /settings/i }));

    expect(store.get(settingsOpenAtom)).toBe("account");
  });

  it("keeps the mobile list visible when Chats is reselected", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderShell(null);

    fireEvent.click(screen.getByRole("button", { name: /chats/i }));

    expect(screen.getByText("room-list")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /chats/i })).not.toHaveAttribute("aria-current");
  });

  it("reports the chat hidden while Settings covers mobile detail", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const props = {
      activeRoomId: "!room:example.org",
      selectionRequestId: 0,
      mobileView: "detail" as const,
      onMobileViewChange: vi.fn(),
      spaceRail: null,
      roomList: null,
      rightPanel: null,
      content: <VisibilityProbe />,
    };
    const { rerender } = render(<AppShell {...props} />);
    expect(screen.getByText("chat-visible")).toBeInTheDocument();
    rerender(<AppShell {...props} isSettingsActive />);
    expect(screen.getByText("chat-hidden")).toBeInTheDocument();
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
    fireEvent.click(screen.getByText("chat-content"));
    expect(screen.getByText("room-list")).toBeInTheDocument();

    rerender(
      <Provider store={store}>
        <Harness activeRoomId="!room:example.org" selectionRequestId={2} />
      </Provider>,
    );

    expect(screen.getByText("chat-content")).toBeInTheDocument();
  });

  it("returns to the mobile list when the active room disappears", () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const store = createStore();
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(Provider, { store }, children);
    const { rerender } = render(<Harness activeRoomId="!room:example.org" />, { wrapper });

    expect(screen.getByText("chat-content")).toBeInTheDocument();

    rerender(
      <Provider store={store}>
        <Harness activeRoomId={null} />
      </Provider>,
    );

    expect(screen.getByText("room-list")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });
});
