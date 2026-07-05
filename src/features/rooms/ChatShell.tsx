import { useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Paperclip, Send } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  getTimelinePage,
  onTimelineUpdate,
  onUploadProgress,
  sendAttachment,
  sendMessage,
  type RoomMessageSummary,
  type RoomSummary,
} from "@/lib/matrix";
import { MediaMessage } from "./media/MediaMessage";
import { avatarColor, displayName, initials } from "./roomDisplay";

interface ChatShellProps {
  room: RoomSummary | null;
  currentUserId: string;
}

function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(timestampMs),
  );
}

interface PendingUpload {
  txnId: string;
  filename: string;
  sent: number;
  total: number;
  failed: boolean;
}

export function ChatShell({ room, currentUserId }: ChatShellProps) {
  const [messages, setMessages] = useState<RoomMessageSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!room) {
      setMessages([]);
      return;
    }
    setLoading(true);
    getTimelinePage(room.room_id)
      .then((page) => setMessages(page.messages.toReversed()))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [room]);

  useEffect(() => {
    if (!room) return undefined;
    const unlisten = onTimelineUpdate((update) => {
      if (update.room_id !== room.room_id) return;
      setMessages((prev) => {
        // Real events superseding our optimistic echoes (same sender + body).
        const withoutMatchedOptimistic = prev.filter((m) => {
          if (!m.event_id.startsWith("local-")) return true;
          return !update.messages.some((um) => um.sender === m.sender && um.body === m.body);
        });
        const existingIds = new Set(withoutMatchedOptimistic.map((m) => m.event_id));
        const newOnes = update.messages.filter((m) => !existingIds.has(m.event_id));
        return [...withoutMatchedOptimistic, ...newOnes];
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [room]);

  useEffect(() => {
    const unlisten = onUploadProgress((progress) => {
      setUploads((prev) => {
        const existing = prev.find((u) => u.txnId === progress.txn_id);
        if (!existing) return prev;
        const done = progress.sent >= progress.total && progress.total > 0;
        if (done) {
          return prev.filter((u) => u.txnId !== progress.txn_id);
        }
        return prev.map((u) =>
          u.txnId === progress.txn_id ? { ...u, sent: progress.sent, total: progress.total } : u,
        );
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  if (!room) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a room to start chatting
      </div>
    );
  }

  const body = draft.trim();

  async function handleSend() {
    if (!body || !room) return;
    setDraft("");
    // Optimistic local echo — no live timeline:update push exists yet, so we
    // append here rather than waiting on a refetch that could race the send.
    const optimistic: RoomMessageSummary = {
      event_id: `local-${Date.now()}`,
      sender: currentUserId,
      body,
      content: { type: "Text", body },
      timestamp_ms: Date.now(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      await sendMessage(room.room_id, body);
    } catch (err) {
      console.error(err);
      setMessages((prev) => prev.filter((m) => m.event_id !== optimistic.event_id));
    }
  }

  async function handleAttachFile(filePath: string) {
    if (!room) return;
    const filename = filePath.split(/[/\\]/).pop() ?? filePath;
    const txnId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setUploads((prev) => [...prev, { txnId, filename, sent: 0, total: 0, failed: false }]);
    try {
      await sendAttachment(room.room_id, filePath);
      setUploads((prev) => prev.filter((u) => u.txnId !== txnId));
    } catch (err) {
      console.error(err);
      setUploads((prev) => prev.map((u) => (u.txnId === txnId ? { ...u, failed: true } : u)));
    }
  }

  async function handleAttachClick() {
    const selected = await openFileDialog({ multiple: false });
    if (typeof selected === "string") {
      await handleAttachFile(selected);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    // Tauri's webview exposes dropped files' real filesystem paths via
    // `webkitGetAsEntry`-less File objects that still carry a `path` on
    // desktop; browsers' plain `File` has no path, so this only actually
    // triggers a send inside the Tauri webview, same as production runs in.
    const files = Array.from(event.dataTransfer.files) as (File & { path?: string })[];
    const file = files[0];
    if (file?.path) {
      handleAttachFile(file.path);
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files) as (File & { path?: string })[];
    const file = files.find((f) => f.type.startsWith("image/"));
    if (file?.path) {
      event.preventDefault();
      handleAttachFile(file.path);
    }
  }

  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="border-b border-border p-4 text-[15px] font-bold text-foreground">
        {displayName(room.room_id, room.name)}
      </div>

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-4">
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && messages.length === 0 && (
          <p className="text-sm text-muted-foreground">No messages yet</p>
        )}
        {messages.map((message, i) => {
          const own = message.sender === currentUserId;
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const sameSenderAsPrev = prev?.sender === message.sender;
          const sameSenderAsNext = next?.sender === message.sender;
          const showAvatar = !own && !sameSenderAsPrev;
          const showMeta = !sameSenderAsNext;

          return (
            <div
              key={message.event_id}
              className={cn(
                "flex max-w-120 gap-2",
                sameSenderAsPrev ? "mt-0.5" : "mt-3",
                own && "ml-auto flex-row-reverse",
              )}
            >
              {!own &&
                (showAvatar ? (
                  <Avatar size="sm">
                    <AvatarFallback
                      style={{ background: avatarColor(message.sender) }}
                      className="font-bold text-white"
                    >
                      {initials(message.sender, null)}
                    </AvatarFallback>
                  </Avatar>
                ) : (
                  <div className="w-6 shrink-0" />
                ))}
              <div className={cn("flex flex-col gap-0.5", own && "items-end")}>
                {showAvatar && (
                  <span className="text-sm font-semibold text-secondary-foreground">
                    {message.sender}
                  </span>
                )}
                {message.content.type === "Text" ? (
                  <div
                    className={cn(
                      "w-fit rounded-md px-3 py-2 text-[15px]",
                      own ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                    )}
                  >
                    {message.content.body}
                  </div>
                ) : (
                  <MediaMessage content={message.content} />
                )}
                {showMeta && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {formatTime(message.timestamp_ms)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {uploads.length > 0 && (
        <div className="flex flex-col gap-1 px-4 pb-2">
          {uploads.map((upload) => (
            <div
              key={upload.txnId}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-[13px]"
            >
              <span className="truncate text-foreground">{upload.filename}</span>
              {upload.failed ? (
                <span className="text-destructive-foreground">Upload failed</span>
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
      )}

      <div className="p-3">
        <div className="flex items-end gap-2 rounded-lg border border-border bg-card p-2">
          <button
            aria-label="Attach"
            onClick={handleAttachClick}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:cursor-not-allowed"
          >
            <Paperclip size={18} />
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={`Message ${displayName(room.room_id, room.name)}`}
            className="max-h-30 min-h-6 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            aria-label="Send"
            disabled={!body}
            onClick={handleSend}
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:bg-accent disabled:text-muted-foreground"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
