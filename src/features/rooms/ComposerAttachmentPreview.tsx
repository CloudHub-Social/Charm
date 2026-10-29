import { X } from "lucide-react";

interface ComposerAttachmentPreviewProps {
  filename: string;
  caption: string;
  disabled: boolean;
  onCaptionChange: (caption: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A retained staged file; the owning composer checks send permission again on confirmation. */
export function ComposerAttachmentPreview({
  filename,
  caption,
  disabled,
  onCaptionChange,
  onConfirm,
  onCancel,
}: ComposerAttachmentPreviewProps) {
  return (
    <div className="flex flex-col gap-2 px-4 pb-2">
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[13px]">
        <span className="truncate text-foreground">{filename}</span>
        <input
          type="text"
          value={caption}
          onChange={(event) => onCaptionChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onConfirm();
            } else if (event.key === "Escape") onCancel();
          }}
          placeholder="Add a caption (optional)"
          aria-label="Attachment caption"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-foreground outline-none focus:border-primary-solid"
        />
        <button
          type="button"
          aria-label="Send attachment"
          onClick={onConfirm}
          disabled={disabled}
          className="shrink-0 rounded bg-primary-solid px-2.5 py-1 text-primary-foreground hover:opacity-90"
        >
          Send
        </button>
        <button
          type="button"
          aria-label="Cancel attachment"
          onClick={onCancel}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
