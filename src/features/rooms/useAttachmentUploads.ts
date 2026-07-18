import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { stripExifOnUploadAtom } from "@/features/appearance/atoms";
import { useFlag } from "@/featureFlags";
import { cancelAttachmentUpload, getMediaConfig, onUploadProgress, sendAttachment } from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";
import { logAndIgnore } from "@/lib/logAndIgnore";
import type { PendingUpload } from "./UploadTray";

export function attachmentUploadPayload(file: File & { path?: string }): string | File | null {
  if (isWebBuild()) {
    return file;
  }
  return file.path ?? null;
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileSize(file: string | File): number | null {
  return typeof file === "string" ? null : file.size;
}

export function useAttachmentUploads(roomId: string | null) {
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const mediaSendPolishEnabled = useFlag("media_send_polish");
  const stripExifOnUpload = useAtomValue(stripExifOnUploadAtom);
  const [maxUploadBytes, setMaxUploadBytes] = useState<number | null>(null);

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
    if (!roomId) return;
    const filename = typeof file === "string" ? (file.split(/[/\\]/).pop() ?? file) : file.name;
    const txnId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const size = fileSize(file);
    if (mediaSendPolishEnabled && maxUploadBytes != null && size != null && size > maxUploadBytes) {
      setUploads((prev) => [
        ...prev,
        {
          txnId,
          filename,
          sent: 0,
          total: 0,
          failed: true,
          errorMessage: `Too large — this server's limit is ${formatMebibytes(maxUploadBytes)}`,
        },
      ]);
      return;
    }

    setUploads((prev) => [...prev, { txnId, filename, sent: 0, total: 0, failed: false }]);
    try {
      await sendAttachment(
        roomId,
        file,
        txnId,
        caption,
        mediaSendPolishEnabled ? stripExifOnUpload : false,
      );
      setUploads((prev) => prev.filter((u) => u.txnId !== txnId));
    } catch (err) {
      console.error(err);
      setUploads((prev) =>
        prev.map((u) => (u.txnId === txnId ? { ...u, failed: true, errorMessage: undefined } : u)),
      );
    }
  }

  function dismissUpload(txnId: string) {
    setUploads((prev) => {
      const upload = prev.find((u) => u.txnId === txnId);
      if (upload && !upload.failed) {
        cancelAttachmentUpload(txnId).catch(logAndIgnore);
      }
      return prev.filter((u) => u.txnId !== txnId);
    });
  }

  return { uploads, handleAttachFile, dismissUpload };
}
