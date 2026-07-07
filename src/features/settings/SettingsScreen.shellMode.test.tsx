import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "./SettingsScreen";
import { settingsOpenAtom } from "./settingsAtoms";

const mockUseAdaptiveLayout = vi.fn();
vi.mock("@/features/shell/useAdaptiveLayout", () => ({
  useAdaptiveLayout: () => mockUseAdaptiveLayout(),
}));

vi.mock("@/lib/matrix", () => ({
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
  window.location.hash = "";
});

describe("SettingsScreen shell mode", () => {
  it("renders a centered dialog over a frozen background on desktop", async () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    renderScreen("account");

    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
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
});
