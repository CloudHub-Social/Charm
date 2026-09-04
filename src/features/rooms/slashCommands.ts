import type { SlashCommand } from "@/lib/matrix";

type MessageStyleCommand = "plain" | "shrug" | "tableflip";
type LocalActionCommand = "unban" | "nick" | "ignore" | "unignore" | "join";

export interface SlashCommandSpec {
  name: SlashCommand | MessageStyleCommand | LocalActionCommand;
  trigger: string;
  argsHint: string;
  description: string;
}

/** Static list backing the `/` autocomplete menu. */
export const SLASH_COMMANDS: (SlashCommandSpec & { name: SlashCommand })[] = [
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

export const MESSAGE_STYLE_COMMANDS: SlashCommandSpec[] = [
  { name: "plain", trigger: "/plain", argsHint: "<message>", description: "Send plain text" },
  { name: "shrug", trigger: "/shrug", argsHint: "[message]", description: "Append a shrug" },
  {
    name: "tableflip",
    trigger: "/tableflip",
    argsHint: "[message]",
    description: "Append a table flip",
  },
];

export const STAGED_BACKEND_COMMANDS: (SlashCommandSpec & { name: SlashCommand })[] = [
  {
    name: "notice",
    trigger: "/notice",
    argsHint: "<message>",
    description: "Send a notice message",
  },
];

export const LOCAL_ACTION_COMMANDS: (SlashCommandSpec & { name: LocalActionCommand })[] = [
  { name: "join", trigger: "/join", argsHint: "<room id or alias>", description: "Join a room" },
  {
    name: "unban",
    trigger: "/unban",
    argsHint: "<user id> [reason]",
    description: "Unban a room member",
  },
  {
    name: "nick",
    trigger: "/nick",
    argsHint: "<display name>",
    description: "Change your display name",
  },
  { name: "ignore", trigger: "/ignore", argsHint: "<user id>", description: "Ignore a user" },
  {
    name: "unignore",
    trigger: "/unignore",
    argsHint: "<user id>",
    description: "Stop ignoring a user",
  },
];

export type ParsedSlashCommand =
  | {
      command: SlashCommand;
      args: string[];
    }
  | { command: MessageStyleCommand; args: string[]; text: string }
  | { command: LocalActionCommand; args: string[]; action: true };

/**
 * Parses a composer's plain-text body for a leading slash command. Returns
 * `null` for anything that isn't a recognized `/word` — including a message
 * that legitimately starts with `/` (e.g. a file path) or an unknown `/x`,
 * both of which the spec requires to be sent as literal text rather than
 * swallowed. A leading `//` is the escape hatch for a literal message
 * starting with `/`: it's stripped down to a single `/` and never parsed as
 * a command.
 */
export function parseSlashCommand(body: string, extended = false): ParsedSlashCommand | null {
  if (!body.startsWith("/") || body.startsWith("//")) return null;

  const [word, ...rest] = body.slice(1).split(/\s+/);
  const action = extended && LOCAL_ACTION_COMMANDS.find((spec) => spec.name === word);
  if (action) return { command: action.name, args: rest.filter(Boolean), action: true };
  if (extended && (word === "plain" || word === "shrug" || word === "tableflip")) {
    return {
      command: word,
      args: rest.filter((a) => a.length > 0),
      text: body.slice(word.length + 1).replace(/^\s/, ""),
    };
  }
  const spec = [...SLASH_COMMANDS, ...(extended ? STAGED_BACKEND_COMMANDS : [])].find(
    (c) => c.name === word,
  );
  if (!spec) return null;

  return { command: spec.name, args: rest.filter((a) => a.length > 0) };
}

export function isMessageSendingCommand(parsed: ParsedSlashCommand): boolean {
  return parsed.command === "me" || parsed.command === "notice" || "text" in parsed;
}

/**
 * Applies the `//` -> `/` literal-text escape. Only meaningful for messages
 * that start with `/`; anything else passes through unchanged.
 */
export function unescapeLiteralSlash(body: string): string {
  return body.startsWith("//") ? body.slice(1) : body;
}
