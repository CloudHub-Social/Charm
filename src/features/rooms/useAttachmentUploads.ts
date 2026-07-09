import { useEffect, useState } from "react";
import { onUploadProgress, sendAttachment } from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";
import { logAndIgnore } from "@/lib/logAndIgnore";
import type { PendingUpload } from "./UploadTray";

export function attachmentUploadPayload(file: File & { path?: string }): string | File | null {
  if (isWebBuild()) {
    return file;
  }
  return file.path ?? null;
}

export function useAttachmentUploads(roomId: string | null) {
  const [uploads, setUploads] = useState<PendingUpload[]>([]);

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

  async function handleAttachFile(file: string | File) {
    if (!roomId) return;
    const filename = typeof file === "string" ? (file.split(/[/\\]/).pop() ?? file) : file.name;
    const txnId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setUploads((prev) => [...prev, { txnId, filename, sent: 0, total: 0, failed: false }]);
    try {
      await sendAttachment(roomId, file, txnId);
      setUploads((prev) => prev.filter((u) => u.txnId !== txnId));
    } catch (err) {
      console.error(err);
      setUploads((prev) => prev.map((u) => (u.txnId === txnId ? { ...u, failed: true } : u)));
    }
  }

  function dismissUpload(txnId: string) {
    setUploads((prev) => prev.filter((u) => u.txnId !== txnId));
  }

  return { uploads, handleAttachFile, dismissUpload };
}
