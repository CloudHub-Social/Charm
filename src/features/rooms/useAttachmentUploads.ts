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
import type { VoiceMessageMetadata } from "@bindings/VoiceMessageMetadata";

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
  // Lets dismissUpload actually abort the web `fetch`
  // streaming the multipart body, not just notify the server-side
  // cancellation token — see sendAttachment's `signal` param doc comment.
  // Native recorded blobs also use the signal to cancel their in-memory
  // conversion before invoking IPC. Native uploads themselves are cancelled
  // server-side (`cancel_attachment_upload`'s `tokio::select!`).
  const uploadAbortControllers = useRef<Map<string, AbortController>>(new Map());
  const failedVoiceUploads = useRef<WeakMap<File, string>>(new WeakMap());
  const ownerGeneration = useRef(0);
  const ownerDisposed = useRef(false);

  useEffect(() => {
    ownerDisposed.current = false;
    const controllers = uploadAbortControllers.current;
    return () => {
      ownerDisposed.current = true;
      ownerGeneration.current += 1;
      for (const [txnId, controller] of controllers) {
        controller.abort();
        cancelAttachmentUpload(txnId).catch(logAndIgnore);
      }
      controllers.clear();
    };
  }, []);

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

  async function handleAttachFile(
    file: string | File,
    caption?: string,
    voice?: VoiceMessageMetadata,
  ): Promise<boolean> {
    if (!roomId || ownerDisposed.current || mutationsBlockedRef?.current) return false;
    const generation = ownerGeneration.current;
    const ownerIsCurrent = () =>
      generation === ownerGeneration.current &&
      roomIdRef.current === roomId &&
      !mutationsBlockedRef?.current;
    const filename = typeof file === "string" ? (file.split(/[/\\]/).pop() ?? file) : file.name;
    const txnId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (voice && file instanceof File) {
      const previousTxnId = failedVoiceUploads.current.get(file);
      if (previousTxnId) {
        setUploads((prev) => prev.filter((upload) => upload.txnId !== previousTxnId));
        failedVoiceUploads.current.delete(file);
      }
    }

    // Fall back to a direct fetch rather than `null` when the mount-time
    // effect hasn't resolved yet — otherwise the very first attachment
    // (picked immediately after opening a room, or while the config request
    // is slow) skips the pre-flight entirely and fails opaquely server-side
    // instead of showing the friendly limit warning below.
    const limit = mediaSendPolishEnabled
      ? (maxUploadBytes ?? (await getMediaConfig().catch(() => null)))
      : null;
    if (!ownerIsCurrent()) return false;
    const size = limit != null ? await fileSize(file) : null;
    if (!ownerIsCurrent()) return false;
    if (limit != null && size != null && size > limit) {
      if (voice && file instanceof File) failedVoiceUploads.current.set(file, txnId);
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
      return false;
    }

    // This is the last synchronous point before the upload starts. A
    // tombstone received during either awaited preflight therefore cannot
    // create an upload row or reach the native/web transport.
    if (mutationsBlockedRef?.current) return false;
    setUploads((prev) => [...prev, { txnId, filename, sent: 0, total: 0, failed: false }]);
    const abortController = isWebBuild() || voice ? new AbortController() : undefined;
    if (abortController) uploadAbortControllers.current.set(txnId, abortController);
    try {
      await sendAttachment(
        roomId,
        file,
        txnId,
        caption,
        mediaSendPolishEnabled ? stripExifOnUpload : false,
        abortController?.signal,
        voice,
      );
      if (generation !== ownerGeneration.current) return false;
      setUploads((prev) => prev.filter((u) => u.txnId !== txnId));
      return true;
    } catch (err) {
      // A dismissed-while-uploading row is already gone from `uploads` (see
      // dismissUpload) — its abort landing here as a rejected fetch isn't a
      // failure to surface, just this request unwinding.
      if (abortController?.signal.aborted || generation !== ownerGeneration.current) return false;
      console.error(err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setUploads((prev) =>
        prev.map((u) => (u.txnId === txnId ? { ...u, failed: true, errorMessage } : u)),
      );
      if (voice && file instanceof File) failedVoiceUploads.current.set(file, txnId);
      return false;
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

  const dismissFailedUploadForFile = useCallback((file: File) => {
    const txnId = failedVoiceUploads.current.get(file);
    if (!txnId) return;
    failedVoiceUploads.current.delete(file);
    setUploads((prev) => prev.filter((upload) => upload.txnId !== txnId));
  }, []);

  return { uploads, handleAttachFile, dismissUpload, dismissFailedUploadForFile };
}
