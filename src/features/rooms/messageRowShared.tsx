import type { MouseEvent } from "react";
import { logAndIgnore } from "@/lib/logAndIgnore";
import type { RoomMessageSummary } from "@/lib/matrix";
import { openExternalUrl } from "@/lib/openExternalUrl";
import type { MessageActionsHandle } from "./MessageActions";

/** Caps the read-receipt avatar stack under a message; the rest collapse into a "+N". */
export const MAX_RECEIPT_AVATARS = 3;

/**
 * Schemes a rendered `formatted_body` link is allowed to actually open —
 * matches the sanitizer's own URI allowlist (`composerSanitize.ts`) minus
 * `mxc:`, which isn't meaningful for `<a href>` (only `<img src>`), and
 * matches the `opener:allow-default-urls` Tauri capability this app grants,
 * so a link outside this set would be rejected at that layer too even if
 * this check were somehow bypassed.
 */
export const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * Intercepts clicks on links inside a rendered `formatted_body` message
 * bubble. Without this, a plain `<a href>` click navigates the app's *entire*
 * webview to that URL — no address bar, no way back, and (this being a
 * single-page desktop app) no way to distinguish "phishing page styled like
 * a login screen" from the real thing. Any message from any room member can
 * contain one, so this can't be treated as a rare/internal link. Opens
 * through the OS's default browser instead (real browser chrome, and out of
 * this app's own IPC-privileged webview entirely) and only for schemes on
 * `ALLOWED_LINK_PROTOCOLS` — a relative/fragment href (both valid per the
 * sanitizer's allowlist) is simply left alone rather than resolved and opened.
 */
export function handleMessageLinkClick(event: MouseEvent<HTMLElement>) {
  // `event.target` is normally an Element for a real click, but isn't
  // guaranteed to be one (e.g. a synthetic/dispatched event) — this is a
  // type assertion away from a runtime throw on `.closest`.
  if (!(event.target instanceof HTMLElement)) return;
  const anchor = event.target.closest("a");
  if (!anchor) return;

  const href = anchor.getAttribute("href");
  if (!href) return;

  let parsed: URL;
  try {
    // No base argument: a relative or fragment href (both valid per the
    // sanitizer's allowlist) throws here instead of being silently resolved
    // into an absolute `http(s)` URL against the app's own origin and
    // handed to `openExternalUrl` — that would both contradict "left alone" above
    // and make no sense to open in an external browser. Only a href that's
    // already absolute reaches the scheme check below.
    parsed = new URL(href);
  } catch {
    return;
  }
  if (!ALLOWED_LINK_PROTOCOLS.has(parsed.protocol)) return;

  event.preventDefault();
  openExternalUrl(parsed.href).catch(logAndIgnore);
}

export function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(timestampMs),
  );
}

/** Stable identity for a timeline item across the local-echo -> ack lifecycle. */
export function messageRowKey(message: RoomMessageSummary): string {
  return message.transaction_id ?? message.event_id;
}

/** Props common to all three layout components (`BubbleMessageRow`,
 * `DiscordMessageRow`, `IrcMessageRow`) — the data plumbing `MessageRow`
 * derives once and hands down unchanged regardless of which mode is active. */
export interface MessageRowLayoutProps {
  message: RoomMessageSummary;
  roomId: string;
  /** Whether `message.sender === currentUserId`. */
  own: boolean;
  sameSenderAsPrev: boolean;
  sameSenderAsNext: boolean;
  /** Already resolved: own messages are always redactable regardless of this. */
  canRedact: boolean;
  /** User ids with a read receipt on this message. */
  readers: string[];
  /** Best-effort user id -> display name lookup for the "Read by {name}" tooltip; falls back to the user id when absent. */
  senderNameByUserId: Map<string, string>;
  /** Looks up this row's mounted `MessageActions` handle, for forwarding a long-press. */
  getActionsHandle: (key: string) => MessageActionsHandle | undefined;
  /** Registers/unregisters this row's `MessageActions` handle as it mounts/unmounts. */
  registerActionsRef: (key: string, handle: MessageActionsHandle | null) => void;
  onReply: () => void;
  onReact: (key: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: () => void;
  isPending: boolean;
  isError: boolean;
  disableRelationActions: boolean;
  isUndecrypted: boolean;
  rowKey: string;
}
