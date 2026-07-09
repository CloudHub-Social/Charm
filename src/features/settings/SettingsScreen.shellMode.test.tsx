import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "./SettingsScreen";
import { settingsOpenAtom } from "./settingsAtoms";

const mockUseAdaptiveLayout = vi.fn();
vi.mock("@/features/shell/useAdaptiveLayout", () => ({
  useAdaptiveLayout: () => mockUseAdaptiveLayout(),
}));

const isDesktopPlatform = vi.fn().mockResolvedValue(false);

vi.mock("@/lib/matrix", () => ({
  isDesktopPlatform: (...args: unknown[]) => isDesktopPlatform(...args),
  getProfile: vi.fn().mockResolvedValue({
    user_id: "@me:localhost",
    display_name: null,
    avatar_url: null,
    uses_oauth: false,
  }),
  getAccountDeactivateUrl: vi.fn().mockResolvedValue(null),
  get3pids: vi.fn().mockResolvedValue([]),
  getIgnoredUsers: vi.fn().mockResolvedValue([]),
  unignoreUser: vi.fn(),
  listDevices: vi.fn().mockResolvedValue([]),
  crossSigningStatus: vi.fn().mockResolvedValue({
    has_master_key: true,
    has_self_signing_key: true,
    has_user_signing_key: true,
  }),
  getCrossSigningResetUrl: vi.fn().mockResolvedValue(null),
  getDeviceDeleteUrl: vi.fn().mockResolvedValue(null),
  getNotificationSettings: vi.fn().mockResolvedValue({
    default_mode: "all_messages",
    keywords: [],
    global_mute: false,
    sound_enabled: true,
  }),
  listRooms: vi.fn().mockResolvedValue([]),
  getPushStatus: vi.fn().mockResolvedValue({
    transport: "none",
    registered: false,
    endpoint_present: false,
    last_error: null,
    available: false,
  }),
  onPushStatus: vi.fn().mockReturnValue(Promise.resolve(() => {})),
  registerPush: vi.fn(),
  unregisterPush: vi.fn(),
  getAutostart: vi.fn().mockResolvedValue(false),
  setAutostart: vi.fn(),
}));

function renderScreen(section: "account") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createStore();
  store.set(settingsOpenAtom, section);
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <SettingsScreen onLoggedOut={vi.fn()} />
      </JotaiProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  isDesktopPlatform.mockResolvedValue(false);
  window.location.hash = "";
});

describe("SettingsScreen shell mode", () => {
  it("renders a centered dialog over a frozen background on desktop", async () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    renderScreen("account");

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("renders exactly one close button on desktop, not a duplicate from Radix's default", async () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    renderScreen("account");

    await screen.findByRole("dialog", { name: "Settings" });
    // Matches both the custom "Close settings" button and Radix's own
    // default close button (accessible name "Close") — DialogContent
    // renders one automatically unless showCloseButton={false}, which
    // would otherwise duplicate this one at the same position.
    expect(screen.getAllByRole("button", { name: /close/i })).toHaveLength(1);
  });

  it("renders a full page (no dialog) on mobile", async () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderScreen("account");

    await screen.findByRole("button", { name: "Close settings" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("switching a section updates the #/settings/<section> hash", async () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderScreen("account");

    await screen.findByRole("button", { name: "Close settings" });
    const notificationsTab = screen.getByRole("tab", { name: "Notifications" });
    notificationsTab.focus();
    notificationsTab.click();

    await screen.findByText("Default notification mode");
    expect(window.location.hash).toBe("#/settings/notifications");
  });

  it("hides the Desktop section on a Tauri build at a mobile-width viewport, not just in a plain browser", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderScreen("account");

    await screen.findByRole("button", { name: "Close settings" });
    expect(screen.queryByRole("tab", { name: "Desktop" })).not.toBeInTheDocument();

    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("hides unsupported settings sections in web builds", async () => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    renderScreen("account");

    await screen.findByRole("button", { name: "Close settings" });
    expect(screen.queryByRole("tab", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Devices" })).toBeInTheDocument();
  });

  it("hides the Desktop section on a Tauri *mobile* build even at a desktop-width viewport", async () => {
    // The bug this guards against: viewport width alone (a Tauri mobile
    // build at a tablet/landscape size can report `useAdaptiveLayout() ===
    // "desktop"`) isn't the real signal — `isDesktopPlatform()` (Tauri's own
    // compile-time desktop/mobile target) is.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    isDesktopPlatform.mockResolvedValue(false);
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    renderScreen("account");

    await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(isDesktopPlatform).toHaveBeenCalled());
    expect(screen.queryByRole("tab", { name: "Desktop" })).not.toBeInTheDocument();

    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("shows the Desktop section on an actual Tauri desktop build", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    isDesktopPlatform.mockResolvedValue(true);
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    renderScreen("account");

    expect(await screen.findByRole("tab", { name: "Desktop" })).toBeInTheDocument();

    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("moves focus into the desktop dialog on open rather than leaving it on the background trigger", async () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    renderScreen("account");

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("closing replaces the settings hash instead of pushing a new history entry", async () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    // Simulates having gotten here via `openSettings` (which sets the hash
    // itself, as a real open would) — `renderScreen` here only seeds the
    // atom directly, so the hash has to be set separately.
    window.location.hash = "#/settings/account";
    const historyLengthAfterOpen = window.history.length;
    renderScreen("account");
    await screen.findByRole("dialog", { name: "Settings" });

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expect(window.location.hash).toBe("");
    // A push on close would grow history.length by one more; a replace
    // leaves it exactly where the (simulated) open left it.
    expect(window.history.length).toBe(historyLengthAfterOpen);
  });

  it("switching sections while already open replaces the hash instead of pushing another history entry", async () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    window.location.hash = "#/settings/account";
    const historyLengthAfterOpen = window.history.length;
    renderScreen("account");
    await screen.findByRole("button", { name: "Close settings" });

    const notificationsTab = screen.getByRole("tab", { name: "Notifications" });
    notificationsTab.focus();
    fireEvent.click(notificationsTab);
    await screen.findByText("Default notification mode");

    expect(window.location.hash).toBe("#/settings/notifications");
    // Only the (simulated) initial open should have pushed a history entry
    // — switching tabs while already open must not add another, or Back
    // would have to step through every section visited before it actually
    // closes settings.
    expect(window.history.length).toBe(historyLengthAfterOpen);

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(window.location.hash).toBe("");
    expect(window.history.length).toBe(historyLengthAfterOpen);
  });
});
