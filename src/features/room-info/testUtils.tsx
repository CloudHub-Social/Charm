import { fireEvent, screen } from "@testing-library/react";
import type { RoomDetails } from "@/lib/matrix";

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
  set_canonical_alias: true,
  set_pinned_events: true,
  set_space_child: true,
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
    canonical_alias: null,
    alt_aliases: [],
    pinned_event_ids: [],
    ...overrides,
  };
}
