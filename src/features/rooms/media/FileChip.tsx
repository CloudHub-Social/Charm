import { Download, File as FileIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { humanFileSize } from "./humanFileSize";
import { useMediaSource } from "./useMediaSource";

interface FileChipProps {
  filename: string;
  mime?: string | null;
  size?: number | null;
  source: string;
  className?: string;
}

/** Generic-file attachment rendered as a download chip: filename + size, click to open/save. */
export function FileChip({ filename, size, source, className }: FileChipProps) {
  const { data: href, isLoading } = useMediaSource(source);

  return (
    <a
      href={href}
      download={filename}
      aria-label={`Download ${filename}`}
      className={cn(
        "flex max-w-80 items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[15px] text-foreground hover:bg-accent",
        !href && "pointer-events-none opacity-70",
        className,
      )}
    >
      <FileIcon size={18} className="shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{filename}</div>
        {size != null && (
          <div className="text-[11px] text-muted-foreground">{humanFileSize(size)}</div>
        )}
      </div>
      {isLoading ? (
        <Loader2 size={16} className="shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Download size={16} className="shrink-0 text-muted-foreground" />
      )}
    </a>
  );
}
