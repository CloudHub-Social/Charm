import { Extension } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { PluginKey } from "@tiptap/pm/state";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { getRoomMembers, listRooms } from "@/lib/matrix";
import type { AutocompleteItem } from "./AutocompletePopover";
import { AutocompletePopover } from "./AutocompletePopover";
import { rectToAutocompletePosition } from "./autocompletePosition";
import { resolveEnterKeyAction } from "./composerKeybinding";
import { serializeComposerContent, type SerializedComposerContent } from "./composerSerialize";
import { useSuggestionMenu, type SuggestionMenuApi } from "./composerSuggestionMenu";
import {
  filterEmoji,
  filterRoomMembers,
  filterRooms,
  filterSlashCommands,
  type RoomMemberOption,
  type RoomOption,
} from "./composerSuggestions";
import { resolveInlineShortcodes } from "./emojiShortcodes";
import { FormattingToolbar } from "./FormattingToolbar";
import { RoomMention, UserMention } from "./mentionExtensions";
import { parseSlashCommand, unescapeLiteralSlash, type ParsedSlashCommand } from "./slashCommands";
import { useRoomDraft } from "./useRoomDraft";
import { logAndIgnore } from "@/lib/logAndIgnore";

export type ComposerMode = "send" | "edit" | "reply";

interface ComposerProps {
  roomId: string;
  mode: ComposerMode;
  /** Preloaded editor HTML when entering edit mode; ignored otherwise. */
  initialHtml?: string;
  placeholder: string;
  onSubmit: (content: SerializedComposerContent) => void;
  /** A resolved slash command was typed as plain text and submitted. */
  onSlashCommand: (command: ParsedSlashCommand) => void;
  onEscape: () => void;
  onTypingInput: () => void;
  /** The editor lost focus — old textarea's cue to stop the room's typing notice. */
  onBlur?: () => void;
  /**
   * Fired whenever the trimmed plain-text content transitions between empty
   * and non-empty (including once on mount) — lets the parent (the Send
   * button in `ChatShell`) disable Send while there's nothing to submit.
   * There's no attachment concept in this composer today (attachments
   * upload and send independently — see `useAttachmentUploads`), so text
   * emptiness is the only signal Send's disabled state needs.
   */
  onEmptyChange?: (isEmpty: boolean) => void;
}

/** Lets a parent (the Send button in `ChatShell`) trigger the same submit path as Enter. */
export interface ComposerHandle {
  submit: () => void;
}

/**
 * Bridges one `suggestion` provider's own lifecycle (`onStart`/`onUpdate`/
 * `onExit`, which run outside React's render cycle) into the single shared
 * {@link SuggestionMenuApi}, so all four providers render into one
 * {@link AutocompletePopover} — only one can be open at a time, which
 * matches only one trigger character ever being "active" in the doc.
 */
function createMenuBridgeRender<T>(menu: SuggestionMenuApi, toItem: (raw: T) => AutocompleteItem) {
  return () => ({
    onStart: (props: SuggestionProps<T>) => {
      // A query with zero matches (e.g. `/nonexistent`, `:zz`) must not
      // leave the menu "open" with nothing to show — `Composer`'s
      // `handleKeyDown` treats `menuOpenRef.current` as "intercept Enter for
      // the menu", so an open-but-empty menu would swallow Enter forever
      // with nothing for `selectActive` to commit.
      if (props.items.length === 0) return;
      const position = rectToAutocompletePosition(props.clientRect?.());
      menu.open(props.items.map(toItem), position, (index: number) => {
        const item = props.items[index];
        if (item !== undefined) props.command(item);
      });
    },
    onUpdate: (props: SuggestionProps<T>) => {
      if (props.items.length === 0) {
        menu.close();
        return;
      }
      const position = rectToAutocompletePosition(props.clientRect?.());
      menu.update(props.items.map(toItem), position, (index: number) => {
        const item = props.items[index];
        if (item !== undefined) props.command(item);
      });
    },
    onExit: () => menu.close(),
  });
}

/**
 * Builds a `Suggestion`-backed `Extension` for a trigger character that
 * inserts plain text (slash commands, emoji) rather than a persistent
 * Mention node.
 */
function createTextSuggestionExtension(
  name: string,
  char: string,
  options: Pick<SuggestionOptions, "items" | "command" | "render" | "allow">,
) {
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char,
          // Each `Suggestion()` call defaults to the SAME plugin key
          // (`suggestion$`) unless given one explicitly — with two
          // independent instances (slash + emoji) both left at the
          // default, ProseMirror throws "Adding different instances of a
          // keyed plugin" as soon as both are registered on one editor.
          pluginKey: new PluginKey(name),
          ...options,
        }),
      ];
    },
  });
}

/** Walks the doc for `userMention` nodes and returns their bare user ids. */
function collectMentionIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "userMention" && typeof node.attrs.id === "string") {
      ids.push(node.attrs.id);
    }
    return true;
  });
  return ids;
}

/**
 * Same text as `editor.getText()`, except `userMention`/`roomMention` nodes
 * are rendered as their bare Matrix id rather than their display label — see
 * `submit()`'s slash-command arg parsing for why this matters.
 */
function textWithMentionIds(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", (node) => {
    if (node.type.name === "userMention" || node.type.name === "roomMention") {
      return typeof node.attrs.id === "string" ? node.attrs.id : "";
    }
    return "";
  });
}

/**
 * Shared rich-text composer for send/edit/reply (`mode`), driven by TipTap —
 * see the spec's "library decision" for why. All four autocomplete triggers
 * (`@`/`#`/`/`/`:`) go through the same `suggestion` mechanism and render
 * into one {@link AutocompletePopover} via {@link useSuggestionMenu}.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    roomId,
    mode,
    initialHtml,
    placeholder,
    onSubmit,
    onSlashCommand,
    onEscape,
    onTypingInput,
    onBlur,
    onEmptyChange,
  },
  ref,
) {
  const menu = useSuggestionMenu();
  const menuOpenRef = useRef(false);
  // Tracks the last value reported via `onEmptyChange` so we only call it on
  // an actual empty/non-empty transition, not on every keystroke. `null`
  // (rather than defaulting to `true`) means "nothing reported yet" — this
  // instance's own ref always starts fresh on mount, but the parent's state
  // (e.g. `ChatShell`'s Send-disabled flag) may be stale from a previous
  // composer instance (a room/mode switch remounts via `key`), so the first
  // call after mount must always fire regardless of what it computes to.
  const wasEmptyRef = useRef<boolean | null>(null);

  function reportEmptyState(editorInstance: Editor) {
    const isEmpty = editorInstance.getText().trim().length === 0;
    if (isEmpty !== wasEmptyRef.current) {
      wasEmptyRef.current = isEmpty;
      onEmptyChange?.(isEmpty);
    }
  }
  menuOpenRef.current = menu.state.open;

  const membersRef = useRef<RoomMemberOption[]>([]);
  const roomsRef = useRef<RoomOption[]>([]);
  const draft = useRoomDraft(roomId);
  // Mirrors the `roomId` prop outside the room-fetch effect's own closure —
  // read at promise-resolution time (not effect-creation time) so a slow
  // response for a room this instance has since moved away from can be
  // told apart from the current one. `Composer` is normally remounted on a
  // real room switch (`ChatShell` keys it by room id), but this is a cheap
  // extra guard in case that invariant ever changes.
  const currentRoomIdRef = useRef(roomId);
  currentRoomIdRef.current = roomId;

  // Called on every keystroke and room switch (acceptance criterion 8) —
  // the `useEffect` below covers "room switch" by reading the seam's
  // current draft as the editor's initial content; `onUpdate` (further
  // down) covers "every keystroke".
  useEffect(() => {
    draft.getDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `draft` (useRoomDraft(roomId)) is a fresh object every render; including it would re-run this every render instead of only on an actual room switch
  }, [roomId]);

  useEffect(() => {
    // Cleared immediately (not just overwritten once the fetch resolves) —
    // otherwise the previous room's members stay in `membersRef` until this
    // request settles, and a slow response for a room the user has since
    // navigated away from can still land and overwrite the new room's list.
    // Both guarded by a room-id check on resolution for the same reason.
    membersRef.current = [];
    roomsRef.current = [];
    const requestedRoomId = roomId;

    getRoomMembers(roomId)
      .then((members) => {
        if (currentRoomIdRef.current !== requestedRoomId) return;
        membersRef.current = members.map((m) => ({
          userId: m.user_id,
          displayName: m.display_name,
        }));
      })
      .catch(logAndIgnore);
    listRooms()
      .then((rooms) => {
        if (currentRoomIdRef.current !== requestedRoomId) return;
        roomsRef.current = rooms
          .filter((room) => room.membership === "join")
          .map((room) => ({
            roomId: room.room_id,
            name: room.name,
            alias: null,
          }));
      })
      .catch(logAndIgnore);
  }, [roomId]);

  const extensions = useMemo(
    () => [
      StarterKit,
      UserMention.configure({
        suggestion: {
          char: "@",
          items: ({ query }: { query: string }) =>
            filterRoomMembers(query, membersRef.current).map((m) => ({
              id: m.userId,
              // `null`, not `m.userId`, when there's no real display name —
              // the bare id already carries its own `@` sigil, so falling
              // back to it here would double it up in the rendered pill
              // (see `mentionExtensions.ts`'s `pillText`). The popover's
              // display label still falls back to the id, below.
              label: m.displayName ?? null,
            })),
          render: createMenuBridgeRender(menu, (raw: { id: string; label: string | null }) => ({
            key: raw.id,
            label: raw.label ?? raw.id,
            sublabel: raw.id,
          })),
        },
      }),
      RoomMention.configure({
        suggestion: {
          char: "#",
          items: ({ query }: { query: string }) =>
            filterRooms(query, roomsRef.current).map((r) => ({
              id: r.roomId,
              label: r.name ?? r.alias ?? null,
            })),
          render: createMenuBridgeRender(menu, (raw: { id: string; label: string | null }) => ({
            key: raw.id,
            label: raw.label ?? raw.id,
          })),
        },
      }),
      createTextSuggestionExtension("slashCommand", "/", {
        // Position 1 is the very first character of the doc's first
        // paragraph — restricting to it means `/` only triggers the
        // command menu at the true start of the message, not mid-sentence
        // (e.g. "look /m"), where opening the menu would otherwise hijack
        // Enter for "select suggestion" instead of sending.
        allow: ({ range }) => range.from === 1,
        items: ({ query }: { query: string }) => filterSlashCommands(query),
        command: ({ editor, range, props }) => {
          const spec = props as ReturnType<typeof filterSlashCommands>[number];
          editor.chain().focus().insertContentAt(range, `/${spec.name} `).run();
        },
        render: createMenuBridgeRender(
          menu,
          (raw: ReturnType<typeof filterSlashCommands>[number]) => ({
            key: raw.name,
            label: raw.trigger,
            sublabel: raw.argsHint,
            leading: "/",
          }),
        ),
      }),
      createTextSuggestionExtension("emoji", ":", {
        items: ({ query }: { query: string }) => filterEmoji(query),
        command: ({ editor, range, props }) => {
          const opt = props as ReturnType<typeof filterEmoji>[number];
          editor.chain().focus().insertContentAt(range, opt.emoji).run();
        },
        render: createMenuBridgeRender(menu, (raw: ReturnType<typeof filterEmoji>[number]) => ({
          key: raw.shortcode,
          label: `:${raw.shortcode}:`,
          leading: raw.emoji,
        })),
      }),
      Placeholder.configure({ placeholder }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally created once: tiptap extensions need a stable identity (recreating resets editor state); live data is read via membersRef/roomsRef/the menu bridge inside each suggestion's items/render, not captured in this closure
    [],
  );

  const submitRef = useRef<() => void>(() => {});

  const editor = useEditor({
    extensions,
    content: mode === "edit" ? (initialHtml ?? "") : draft.getDraft(),
    editorProps: {
      attributes: {
        // axe's `aria-prohibited-attr` rule requires an explicit role
        // before it'll credit a `contenteditable` div with `aria-label` —
        // a plain `<div contenteditable>` has an implicit textbox role in
        // real browsers, but not one axe's static analysis infers on its
        // own, so it's spelled out here rather than relied on implicitly.
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": placeholder,
        // Not a native HTML placeholder (contenteditable has none) — kept
        // as a plain attribute so `page.getByPlaceholder(...)` locators
        // written against the old `<textarea>` composer keep working.
        // Placeholder extension (below) drives the actual visible text.
        placeholder,
        class:
          "max-h-30 min-h-6 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] text-foreground outline-none",
      },
      handleKeyDown: (_view, event) => {
        if (menuOpenRef.current) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            menu.moveActive(1);
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            menu.moveActive(-1);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            menu.close();
            return true;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            menu.selectActive();
            return true;
          }
          return false;
        }

        if (event.key === "Enter") {
          const action = resolveEnterKeyAction(event.shiftKey, false);
          if (action === "newline") return false;
          event.preventDefault();
          submitRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      // Only `send`/`reply` mode content belongs in the shared room draft —
      // writing edit-mode keystrokes here would overwrite whatever the user
      // had actually drafted for their next new message, which then
      // reappears (as the edited text) if they cancel the edit and the
      // composer remounts back into send mode.
      if (mode !== "edit") draft.setDraft(e.getHTML());
      onTypingInput();
      reportEmptyState(e);
    },
    onBlur: () => onBlur?.(),
  });

  // Reports the editor's initial content emptiness once it's created
  // (mount, or entering edit mode with pre-filled `initialHtml`) — `onUpdate`
  // above only fires on subsequent keystrokes, so without this the parent
  // would default to "empty" even when edit mode starts with existing text.
  useEffect(() => {
    if (editor) reportEmptyState(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-check when the editor instance itself changes (e.g. remount into a new mode/room); `reportEmptyState`/`onEmptyChange` are stable enough in practice and including them would re-run this on every render
  }, [editor]);

  function submit() {
    if (!editor) return;
    const rawPlainText = resolveInlineShortcodes(editor.getText()).trim();
    if (!rawPlainText) return;

    // Slash-command args need each `@mention` resolved to its real Matrix id
    // (`@alice:example.org`), not its display label (`Alice`) — `getText()`
    // above renders mentions by label, which `UserId::parse` on the Rust
    // side would then reject. `textBetween`'s `leafText` hook substitutes
    // the mention node's `id` attr for exactly this parsing pass; the
    // regular send path doesn't need it since `m.mentions` is populated
    // separately via `collectMentionIds`.
    const commandText =
      mode === "send" ? resolveInlineShortcodes(textWithMentionIds(editor)) : rawPlainText;
    const slash = mode === "send" ? parseSlashCommand(commandText.trim()) : null;
    if (slash) {
      onSlashCommand(slash);
      // `clearContent(false)` skips emitting `onUpdate` — clearing after a
      // send/command isn't the user typing, so it shouldn't re-trigger
      // `onTypingInput` and send a spurious `typing: true` right after
      // ChatShell already told the server `typing: false` for this send.
      editor.commands.clearContent(false);
      draft.setDraft("");
      reportEmptyState(editor);
      return;
    }

    // A message that's genuinely meant to start with `/` (not a command)
    // is typed as `//...` (see `parseSlashCommand`'s doc comment) — only
    // unescape it here, once we know it isn't resolving to a real command,
    // so the literal `/` survives instead of being sent as `//`.
    const plainText = unescapeLiteralSlash(rawPlainText);
    const html = resolveInlineShortcodes(editor.getHTML().replace(/^((?:<[^>]+>)*)\/\//, "$1/"));

    const mentionIds = collectMentionIds(editor);
    const content = serializeComposerContent(html, plainText, mentionIds);
    onSubmit(content);
    editor.commands.clearContent(false);
    draft.setDraft("");
    reportEmptyState(editor);
  }
  submitRef.current = submit;

  useImperativeHandle(ref, () => ({ submit: () => submitRef.current() }), []);

  useEffect(() => {
    function onEsc(event: KeyboardEvent) {
      if (event.key === "Escape" && !menuOpenRef.current) onEscape();
    }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onEscape]);

  return (
    <div className="flex flex-1 flex-col gap-1">
      <FormattingToolbar editor={editor} />
      <EditorContent editor={editor} />
      {menu.state.open && (
        <AutocompletePopover
          items={menu.state.items}
          activeIndex={menu.state.activeIndex}
          onSelect={menu.selectIndex}
          position={menu.state.position}
        />
      )}
    </div>
  );
});
