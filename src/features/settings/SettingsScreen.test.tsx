import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "./SettingsScreen";
import { settingsOpenAtom } from "./settingsAtoms";

vi.mock("@/lib/matrix", () => ({
  getProfile: vi.fn().mockResolvedValue({
    user_id: "@me:localhost",
    display_name: null,
    avatar_url: null,
    uses_oauth: false,
  }),
  getAccountDeactivateUrl: vi.fn().mockResolvedValue(null),
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
  registerPush: vi.fn().mockResolvedValue({
    transport: "none",
    registered: false,
    endpoint_present: false,
  }),
  unregisterPush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  requestPermission: vi.fn().mockResolvedValue("granted"),
}));

function renderScreen(section: "account" | "notifications" | "devices" | "appearance" | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createStore();
  store.set(settingsOpenAtom, section);
  render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <SettingsScreen onLoggedOut={vi.fn()} />
      </JotaiProvider>
    </QueryClientProvider>,
  );
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsScreen", () => {
  it("renders nothing when closed", () => {
    renderScreen(null);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("switches sections via the nav", async () => {
    renderScreen("account");
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();

    const notificationsTab = screen.getByRole("tab", { name: "Notifications" });
    // Radix's Tabs activates on focus (the default "automatic" activation
    // mode), which a real click produces but jsdom's synthetic `click` alone
    // does not — focus it explicitly first.
    notificationsTab.focus();
    fireEvent.click(notificationsTab);

    expect(
      await screen.findByRole("heading", { name: "Default notification mode" }),
    ).toBeInTheDocument();
  });

  it("closes via the close button", async () => {
    const store = renderScreen("account");
    await screen.findByRole("heading", { name: "Profile" });

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expect(store.get(settingsOpenAtom)).toBeNull();
  });
});
