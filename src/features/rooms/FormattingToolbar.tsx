import type { Editor } from "@tiptap/react";
import { Bold, Code, Italic, List, ListOrdered, Quote } from "lucide-react";
import { cn } from "@/lib/utils";

interface FormattingToolbarProps {
  editor: Editor | null;
}

interface ToolbarButtonSpec {
  key: string;
  label: string;
  icon: typeof Bold;
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

const BUTTONS: ToolbarButtonSpec[] = [
  {
    key: "bold",
    label: "Bold (Cmd+B)",
    icon: Bold,
    isActive: (e) => e.isActive("bold"),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    key: "italic",
    label: "Italic (Cmd+I)",
    icon: Italic,
    isActive: (e) => e.isActive("italic"),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    key: "code",
    label: "Inline code (Cmd+E)",
    icon: Code,
    isActive: (e) => e.isActive("code"),
    run: (e) => e.chain().focus().toggleCode().run(),
  },
  {
    key: "blockquote",
    label: "Block quote",
    icon: Quote,
    isActive: (e) => e.isActive("blockquote"),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    key: "bulletList",
    label: "Bulleted list",
    icon: List,
    isActive: (e) => e.isActive("bulletList"),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    key: "orderedList",
    label: "Numbered list",
    icon: ListOrdered,
    isActive: (e) => e.isActive("orderedList"),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
];

/** Bold/italic/code/quote/list toggle buttons bound to TipTap commands. */
export function FormattingToolbar({ editor }: FormattingToolbarProps) {
  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label="Formatting">
      {BUTTONS.map(({ key, label, icon: Icon, isActive, run }) => (
        <button
          key={key}
          type="button"
          aria-label={label}
          aria-pressed={editor ? isActive(editor) : false}
          disabled={!editor}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor && run(editor)}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
            editor && isActive(editor) && "bg-accent text-accent-foreground",
          )}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}
