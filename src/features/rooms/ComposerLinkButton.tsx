import { useId, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Link } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/** Native URL parsing; reject executable, relative, and credential-bearing links. */
export function composerLinkUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!["https:", "http:", "mailto:", "tel:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function ComposerLinkButton({ editor }: { editor: Editor | null }) {
  const inputId = useId();
  const [href, setHref] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    editor: Editor;
    from: number;
    to: number;
    doc: Editor["state"]["doc"];
  } | null>(null);

  return (
    <Dialog open={selection !== null} onOpenChange={(open) => !open && setSelection(null)}>
      <button
        type="button"
        aria-label="Insert link"
        disabled={!editor}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (!editor) return;
          setHref(String(editor.getAttributes("link").href ?? ""));
          setError(null);
          setSelection({
            editor,
            from: editor.state.selection.from,
            to: editor.state.selection.to,
            doc: editor.state.doc,
          });
        }}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Link size={16} />
      </button>
      <DialogContent
        onKeyDown={(event) => {
          // Dismiss only this nested dialog, not the composer's unsaved edit.
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        <DialogTitle>Insert link</DialogTitle>
        <DialogDescription>
          Link the selected text, or insert the address at the cursor.
        </DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const url = composerLinkUrl(href);
            if (!url) {
              setError(
                "Enter a full http, https, mailto, or tel address without login credentials.",
              );
              return;
            }
            if (
              !editor ||
              !selection ||
              editor !== selection.editor ||
              editor.isDestroyed ||
              !editor.state.doc.eq(selection.doc)
            ) {
              setError("The message changed. Close this dialog and select the text again.");
              return;
            }
            const chain = editor
              .chain()
              .focus()
              .setTextSelection({ from: selection.from, to: selection.to });
            if (selection.from === selection.to) {
              chain
                .insertContent({
                  type: "text",
                  text: url,
                  marks: [{ type: "link", attrs: { href: url } }],
                })
                .run();
            } else {
              chain.setLink({ href: url }).run();
            }
            setSelection(null);
          }}
          className="space-y-3"
        >
          <label htmlFor={inputId}>Link address</label>
          <Input
            id={inputId}
            value={href}
            onChange={(event) => setHref(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {error && <p role="alert">{error}</p>}
          <Button type="submit">Apply link</Button>
          <Button type="button" variant="outline" onClick={() => setSelection(null)}>
            Cancel
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
