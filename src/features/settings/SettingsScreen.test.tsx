import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "./SettingsScreen";
import { settingsOpenAtom, type SettingsSection } from "./settingsAtoms";
import type * as PlatformModule from "@/lib/platform";

const getAutostart = vi.fn().mockResolvedValue(false);
const getDndState = vi.fn().mockReturnValue(new Promise(() => {}));

vi.mock("@/lib/matrix", () => ({
  isDesktopPlatform: vi.fn().mockResolvedValue(false),
  getProfile: vi.fn().mockResolvedValue({
    user_id: "@me:localhost",
    display_name: null,
    avatar_url: null,
    uses_oauth: false,
  }),
  getAccountDeactivateUrl: vi.fn().mockResolvedValue(null),
  listDevices: vi.fn().mockResolvedValue([]),
  crossSigningStatus: vi.fn().mockResolvedValue({
    has_identity: true,
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
  get3pids: vi.fn().mockResolvedValue([]),
  getIgnoredUsers: vi.fn().mockResolvedValue([]),
  unignoreUser: vi.fn(),
  getAutostart: (...args: unknown[]) => getAutostart(...args),
  setAutostart: vi.fn(),
  getDndState: (...args: unknown[]) => getDndState(...args),
  setDndState: vi.fn().mockResolvedValue({ enabled: false, until: null }),
  onDndChanged: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  requestPermission: vi.fn().mockResolvedValue("granted"),
}));

let focusModeFlagEnabled = false;
vi.mock("@/featureFlags", () => ({
  useFlag: (key: string) => (key === "focus_mode" ? focusModeFlagEnabled : false),
}));

// `useFocusMode` gates its `getDndState` query on `isTauri()` (whether
// `window.__TAURI_INTERNALS__` exists) rather than `isWebBuild()` — jsdom has
// neither, so without this override the query would stay disabled and every
// Focus/DND assertion below would see stale `enabled: false` regardless of
// what `getDndState` is mocked to return. `isWebBuild()` itself is left as
// the real implementation (still driven by `VITE_CHARM_BUILD_TARGET`) since
// `SettingsScreen`'s own web-build gating is what several tests below are
// exercising.
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformModule>();
  return { ...actual, isTauri: () => true };
});

function renderScreen(section: SettingsSection | null) {
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
  focusModeFlagEnabled = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
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

    expect(await screen.findByText("Default notification mode")).toBeInTheDocument();
  });

  it("closes via the close button", async () => {
    const store = renderScreen("account");
    await screen.findByRole("heading", { name: "Profile" });

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expect(store.get(settingsOpenAtom)).toBeNull();
  });

  it("never mounts DesktopPanel outside Tauri, even deep-linked straight to that section", async () => {
    renderScreen("desktop");
    await screen.findByRole("tablist");

    expect(screen.queryByRole("tab", { name: "Desktop" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Launch Charm when I log in")).not.toBeInTheDocument();
    expect(getAutostart).not.toHaveBeenCalled();
  });

  it("falls back to the first available section instead of a blank panel when deep-linked to an unsupported one", async () => {
    renderScreen("desktop");

    // Falls back to Account (the first entry in SECTIONS), rather than
    // leaving the Tabs `value` pointed at "desktop" with no matching
    // trigger or content, which would otherwise render nothing at all.
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Account" })).toHaveAttribute("aria-selected", "true");
  });

  it("hides native notification settings in web builds", async () => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");

    renderScreen("general");

    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "General" })).not.toBeInTheDocument();
    expect(screen.queryByText("Desktop notifications")).not.toBeInTheDocument();
  });

  it("shows Focus even flag-enabled, so long as it's not a web build", async () => {
    focusModeFlagEnabled = true;

    renderScreen("account");
    await screen.findByRole("heading", { name: "Profile" });

    expect(screen.getByRole("tab", { name: "Focus" })).toBeInTheDocument();
  });

  // Review fix: Focus (Do Not Disturb) is a Tauri/native concept —
  // `invokeWeb` has no case for `get_dnd_state`/`set_dnd_state`, so it must
  // stay hidden on web builds the same way General/Notifications already
  // are, regardless of the `focus_mode` flag.
  it("hides Focus in web builds even when focus_mode is flag-enabled", async () => {
    focusModeFlagEnabled = true;
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");

    renderScreen("account");
    await screen.findByRole("heading", { name: "Profile" });

    expect(screen.queryByRole("tab", { name: "Focus" })).not.toBeInTheDocument();
  });

  it("hides Focus when the flag is off and DND is not active", async () => {
    getDndState.mockResolvedValue({ enabled: false, until: null });

    renderScreen("account");
    await screen.findByRole("heading", { name: "Profile" });

    expect(screen.queryByRole("tab", { name: "Focus" })).not.toBeInTheDocument();
  });

  // Review fix: if `focus_mode` is disabled after a user already has DND
  // active (rollout killed, local override cleared), Rust enforcement keeps
  // suppressing notifications regardless of the flag — so the Focus section
  // must stay reachable as an off-ramp even with the flag off.
  it("keeps Focus reachable as an off-ramp when DND is active but the flag is off", async () => {
    focusModeFlagEnabled = false;
    getDndState.mockResolvedValue({ enabled: true, until: null });

    renderScreen("account");
    await screen.findByRole("heading", { name: "Profile" });

    expect(await screen.findByRole("tab", { name: "Focus" })).toBeInTheDocument();
  });
});
