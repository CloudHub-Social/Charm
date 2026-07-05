import type { SlashCommand } from "@/lib/matrix";

export interface SlashCommandSpec {
  name: SlashCommand;
  trigger: string;
  argsHint: string;
  description: string;
}

/** Static list backing the `/` autocomplete menu. */
export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: "me", trigger: "/me", argsHint: "<action>", description: "Send an action message" },
  { name: "topic", trigger: "/topic", argsHint: "<topic>", description: "Set the room topic" },
  { name: "invite", trigger: "/invite", argsHint: "<user id>", description: "Invite a user" },
  {
    name: "kick",
    trigger: "/kick",
    argsHint: "<user id> [reason]",
    description: "Kick a user from the room",
  },
  {
    name: "ban",
    trigger: "/ban",
    argsHint: "<user id> [reason]",
    description: "Ban a user from the room",
  },
];

export interface ParsedSlashCommand {
  command: SlashCommand;
  args: string[];
}

/**
 * Parses a composer's plain-text body for a leading slash command. Returns
 * `null` for anything that isn't a recognized `/word` — including a message
 * that legitimately starts with `/` (e.g. a file path) or an unknown `/x`,
 * both of which the spec requires to be sent as literal text rather than
 * swallowed. A leading `//` is the escape hatch for a literal message
 * starting with `/`: it's stripped down to a single `/` and never parsed as
 * a command.
 */
export function parseSlashCommand(body: string): ParsedSlashCommand | null {
  if (!body.startsWith("/") || body.startsWith("//")) return null;

  const [word, ...rest] = body.slice(1).split(/\s+/);
  const spec = SLASH_COMMANDS.find((c) => c.name === word);
  if (!spec) return null;

  return { command: spec.name, args: rest.filter((a) => a.length > 0) };
}

/**
 * Applies the `//` -> `/` literal-text escape. Only meaningful for messages
 * that start with `/`; anything else passes through unchanged.
 */
export function unescapeLiteralSlash(body: string): string {
  return body.startsWith("//") ? body.slice(1) : body;
}
