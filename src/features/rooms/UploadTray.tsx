import { X } from "lucide-react";

export interface PendingUpload {
  txnId: string;
  filename: string;
  sent: number;
  total: number;
  failed: boolean;
}

interface UploadTrayProps {
  uploads: PendingUpload[];
  onDismiss: (txnId: string) => void;
}

/** Renders the in-flight/failed attachment uploads below the message list. */
export function UploadTray({ uploads, onDismiss }: UploadTrayProps) {
  if (uploads.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 px-4 pb-2">
      {uploads.map((upload) => (
        <div
          key={upload.txnId}
          className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-[13px]"
        >
          <span className="truncate text-foreground">{upload.filename}</span>
          {upload.failed ? (
            <>
              <span className="text-destructive-foreground">Upload failed</span>
              <button
                type="button"
                aria-label={`Dismiss failed upload ${upload.filename}`}
                onClick={() => onDismiss(upload.txnId)}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
              >
                <X size={14} />
              </button>
            </>
          ) : (
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary transition-[width]"
                style={{
                  width:
                    upload.total > 0
                      ? `${Math.min(100, (upload.sent / upload.total) * 100)}%`
                      : "10%",
                }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
