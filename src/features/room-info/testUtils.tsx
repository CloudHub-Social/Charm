import type { ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { AppProviders } from "@/providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RoomDetails } from "@/lib/matrix";

/**
 * Fresh, retry-disabled `QueryClient` per test — this feature is the first
 * user of TanStack Query, so every test needs its own provider tree rather
 * than a global singleton. Also wraps in `TooltipProvider`, since every
 * gated control in this feature renders a `Tooltip` when disabled — in the
 * app that ancestor comes from `RoomInfoPanel`, but components under test
 * here are often rendered standalone.
 */
export function renderWithProviders(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppProviders client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </AppProviders>,
  );
}

/** Radix's `DropdownMenu` opens on pointerdown, not click, in jsdom — see `MessageActions.test.tsx`'s identical helper. */
export function openDropdownMenu(triggerName: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: triggerName }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

const ADMIN_PERMISSIONS: RoomDetails["can"] = {
  set_name: true,
  set_topic: true,
  set_avatar: true,
  set_join_rules: true,
  set_history_visibility: true,
  set_encryption: true,
  set_power_levels: true,
  invite: true,
  kick: true,
  ban: true,
};

export function makeRoomDetails(overrides: Partial<RoomDetails> = {}): RoomDetails {
  return {
    room_id: "!test:localhost",
    name: "Test Room",
    topic: "A room for testing",
    avatar_url: null,
    is_encrypted: false,
    join_rule: "invite",
    history_visibility: "shared",
    member_count: 2,
    my_power_level: 100,
    power_levels: {
      invite: 0,
      kick: 50,
      ban: 50,
      redact: 50,
      events_default: 0,
      state_default: 50,
      users_default: 0,
    },
    can: ADMIN_PERMISSIONS,
    ...overrides,
  };
}
