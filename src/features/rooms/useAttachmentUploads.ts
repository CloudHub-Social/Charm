import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { stripExifOnUploadAtom } from "@/features/appearance/atoms";
import { useFlag } from "@/featureFlags";
import {
  cancelAttachmentUpload,
  getFileSize,
  getMediaConfig,
  onUploadProgress,
  sendAttachment,
} from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";
import { logAndIgnore } from "@/lib/logAndIgnore";
import type { PendingUpload } from "./UploadTray";

export function attachmentUploadPayload(file: File & { path?: string }): string | File | null {
  if (isWebBuild()) {
    return file;
  }
  return file.path ?? null;
}

export function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes("Files");
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** `file` is a filesystem path string for a native desktop attachment (no
 * `.size` of its own — see `getFileSize`'s doc comment), or a browser `File`
 * for web, which already carries its size. */
async function fileSize(file: string | File): Promise<number | null> {
  if (typeof file !== "string") return file.size;
  try {
    return await getFileSize(file);
  } catch {
    return null;
  }
}

export function useAttachmentUploads(
  roomId: string | null,
  mutationsBlockedRef?: RefObject<boolean>,
) {
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const mediaSendPolishEnabled = useFlag("media_send_polish");
  const stripExifOnUpload = useAtomValue(stripExifOnUploadAtom);
  const [maxUploadBytes, setMaxUploadBytes] = useState<number | null>(null);
  // Read by handleAttachFile after its own `await`s to check whether the
  // room changed out from under it while it was suspended — a plain `roomId`
  // closure over a stale render wouldn't see a room switch that happened
  // mid-preflight.
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;
  // Web-only: lets dismissUpload actually abort the in-flight `fetch`
  // streaming the multipart body, not just notify the server-side
  // cancellation token — see sendAttachment's `signal` param doc comment.
  // Desktop needs no equivalent map; its cancellation is entirely
  // server-side (`cancel_attachment_upload`'s `tokio::select!`).
  const uploadAbortControllers = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    if (!mediaSendPolishEnabled) return;
    let cancelled = false;
    getMediaConfig()
      .then((bytes) => {
        if (!cancelled) setMaxUploadBytes(bytes);
      })
      .catch(logAndIgnore);
    return () => {
      cancelled = true;
    };
  }, [mediaSendPolishEnabled]);

  useEffect(() => {
    setUploads([]);
  }, [roomId]);

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
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, []);

  async function handleAttachFile(file: string | File, caption?: string) {
    if (!roomId || mutationsBlockedRef?.current) return;
    const filename = typeof file === "string" ? (file.split(/[/\\]/).pop() ?? file) : file.name;
    const txnId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Fall back to a direct fetch rather than `null` when the mount-time
    // effect hasn't resolved yet — otherwise the very first attachment
    // (picked immediately after opening a room, or while the config request
    // is slow) skips the pre-flight entirely and fails opaquely server-side
    // instead of showing the friendly limit warning below.
    const limit = mediaSendPolishEnabled
      ? (maxUploadBytes ?? (await getMediaConfig().catch(() => null)))
      : null;
    if (roomIdRef.current !== roomId || mutationsBlockedRef?.current) return;
    const size = limit != null ? await fileSize(file) : null;
    if (roomIdRef.current !== roomId || mutationsBlockedRef?.current) return;
    if (limit != null && size != null && size > limit) {
      setUploads((prev) => [
        ...prev,
        {
          txnId,
          filename,
          sent: 0,
          total: 0,
          failed: true,
          errorMessage: `Too large — this server's limit is ${formatMebibytes(limit)}`,
        },
      ]);
      return;
    }

    // This is the last synchronous point before the upload starts. A
    // tombstone received during either awaited preflight therefore cannot
    // create an upload row or reach the native/web transport.
    if (mutationsBlockedRef?.current) return;
    setUploads((prev) => [...prev, { txnId, filename, sent: 0, total: 0, failed: false }]);
    const abortController = isWebBuild() ? new AbortController() : undefined;
    if (abortController) uploadAbortControllers.current.set(txnId, abortController);
    try {
      await sendAttachment(
        roomId,
        file,
        txnId,
        caption,
        mediaSendPolishEnabled ? stripExifOnUpload : false,
        abortController?.signal,
      );
      setUploads((prev) => prev.filter((u) => u.txnId !== txnId));
    } catch (err) {
      // A dismissed-while-uploading row is already gone from `uploads` (see
      // dismissUpload) — its abort landing here as a rejected fetch isn't a
      // failure to surface, just this request unwinding.
      if (abortController?.signal.aborted) return;
      console.error(err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setUploads((prev) =>
        prev.map((u) => (u.txnId === txnId ? { ...u, failed: true, errorMessage } : u)),
      );
    } finally {
      uploadAbortControllers.current.delete(txnId);
    }
  }

  const dismissUpload = useCallback((txnId: string) => {
    setUploads((prev) => {
      const upload = prev.find((u) => u.txnId === txnId);
      if (upload && !upload.failed) {
        cancelAttachmentUpload(txnId).catch(logAndIgnore);
        uploadAbortControllers.current.get(txnId)?.abort();
      }
      return prev.filter((u) => u.txnId !== txnId);
    });
  }, []);

  return { uploads, handleAttachFile, dismissUpload };
}
