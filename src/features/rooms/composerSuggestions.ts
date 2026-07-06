import { searchEmoji } from "./emojiShortcodes";
import { SLASH_COMMANDS, type SlashCommandSpec } from "./slashCommands";

export interface RoomMemberOption {
  userId: string;
  displayName: string | null;
}

export interface RoomOption {
  roomId: string;
  name: string | null;
  alias: string | null;
}

export interface EmojiOption {
  shortcode: string;
  emoji: string;
}

/** Filters the static slash-command list by a case-insensitive name prefix. */
export function filterSlashCommands(query: string): SlashCommandSpec[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

/** Thin re-export so every provider's filter lives in one module. */
export function filterEmoji(query: string): EmojiOption[] {
  return searchEmoji(query);
}

/**
 * Filters already-synced room members by user id or display name prefix
 * (case-insensitive) — client-side over synced members rather than a
 * homeserver query, per the spec's latency tradeoff.
 */
export function filterRoomMembers(query: string, members: RoomMemberOption[]): RoomMemberOption[] {
  const q = query.toLowerCase();
  if (q === "") return members;
  return members.filter(
    (m) =>
      m.userId.toLowerCase().includes(q) || (m.displayName?.toLowerCase().includes(q) ?? false),
  );
}

/** Filters known rooms by alias or name prefix (case-insensitive). */
export function filterRooms(query: string, rooms: RoomOption[]): RoomOption[] {
  const q = query.toLowerCase();
  if (q === "") return rooms;
  return rooms.filter(
    (r) =>
      (r.alias?.toLowerCase().includes(q) ?? false) || (r.name?.toLowerCase().includes(q) ?? false),
  );
}
