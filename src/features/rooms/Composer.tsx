import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { getRoomMembers, listRooms } from "@/lib/matrix";
import type { AutocompleteItem } from "./AutocompletePopover";
import { AutocompletePopover } from "./AutocompletePopover";
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
import { parseSlashCommand, type ParsedSlashCommand } from "./slashCommands";
import { useRoomDraft } from "./useRoomDraft";

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
}

/** Lets a parent (the Send button in `ChatShell`) trigger the same submit path as Enter. */
export interface ComposerHandle {
  submit: () => void;
}

function rectToPosition(rect: DOMRect | null | undefined): { top: number; left: number } {
  if (!rect) return { top: 0, left: 0 };
  return { top: rect.bottom + 4, left: rect.left };
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
      const position = rectToPosition(props.clientRect?.());
      menu.open(props.items.map(toItem), position, (index: number) => {
        const item = props.items[index];
        if (item !== undefined) props.command(item);
      });
    },
    onUpdate: (props: SuggestionProps<T>) => {
      const position = rectToPosition(props.clientRect?.());
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
  options: Pick<SuggestionOptions, "items" | "command" | "render">,
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
 * Shared rich-text composer for send/edit/reply (`mode`), driven by TipTap —
 * see the spec's "library decision" for why. All four autocomplete triggers
 * (`@`/`#`/`/`/`:`) go through the same `suggestion` mechanism and render
 * into one {@link AutocompletePopover} via {@link useSuggestionMenu}.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { roomId, mode, initialHtml, placeholder, onSubmit, onSlashCommand, onEscape, onTypingInput },
  ref,
) {
  const menu = useSuggestionMenu();
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu.state.open;

  const membersRef = useRef<RoomMemberOption[]>([]);
  const roomsRef = useRef<RoomOption[]>([]);
  const draft = useRoomDraft(roomId);

  // Called on every keystroke and room switch (acceptance criterion 8) —
  // the `useEffect` below covers "room switch" by reading the seam's
  // current draft as the editor's initial content; `onUpdate` (further
  // down) covers "every keystroke".
  useEffect(() => {
    draft.getDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  useEffect(() => {
    getRoomMembers(roomId)
      .then((members) => {
        membersRef.current = members.map((m) => ({
          userId: m.user_id,
          displayName: m.display_name,
        }));
      })
      .catch(console.error);
    listRooms()
      .then((rooms) => {
        roomsRef.current = rooms.map((r) => ({
          roomId: r.room_id,
          name: r.name,
          alias: null,
        }));
      })
      .catch(console.error);
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
              label: m.displayName ?? m.userId,
            })),
          render: createMenuBridgeRender(menu, (raw: { id: string; label: string }) => ({
            key: raw.id,
            label: raw.label,
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
              label: r.name ?? r.alias ?? r.roomId,
            })),
          render: createMenuBridgeRender(menu, (raw: { id: string; label: string }) => ({
            key: raw.id,
            label: raw.label,
          })),
        },
      }),
      createTextSuggestionExtension("slashCommand", "/", {
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
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const submitRef = useRef<() => void>(() => {});

  const editor = useEditor({
    extensions,
    content: mode === "edit" ? (initialHtml ?? "") : draft.getDraft(),
    editorProps: {
      attributes: {
        "aria-label": placeholder,
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
      draft.setDraft(e.getHTML());
      onTypingInput();
    },
  });

  function submit() {
    if (!editor) return;
    const plainText = resolveInlineShortcodes(editor.getText()).trim();
    if (!plainText) return;

    const slash = mode === "send" ? parseSlashCommand(plainText) : null;
    if (slash) {
      onSlashCommand(slash);
      editor.commands.clearContent();
      draft.setDraft("");
      return;
    }

    const mentionIds = collectMentionIds(editor);
    const content = serializeComposerContent(editor.getHTML(), plainText, mentionIds);
    onSubmit(content);
    editor.commands.clearContent();
    draft.setDraft("");
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
