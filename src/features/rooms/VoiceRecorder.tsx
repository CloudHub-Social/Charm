import { useEffect, useRef, useState } from "react";
import type { VoiceMessageMetadata } from "@bindings/VoiceMessageMetadata";
import { useVoiceRecorder } from "./useVoiceRecorder";

interface VoiceRecorderProps {
  mobile: boolean;
  onSend: (file: File, metadata: VoiceMessageMetadata) => Promise<boolean>;
  onClearFailedUpload: (file: File) => void;
  onCaptureChange?: (capturing: boolean) => void;
}

export function VoiceRecorder({
  mobile,
  onSend,
  onClearFailedUpload,
  onCaptureChange,
}: VoiceRecorderProps) {
  const recorder = useVoiceRecorder();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const sendingRef = useRef(false);
  const mounted = useRef(true);
  const previewAudio = useRef<HTMLAudioElement>(null);
  const pointer = useRef<{ id: number; x: number; cancelled: boolean } | null>(null);
  const suppressPointerClick = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const capturing = recorder.phase === "recording" || recorder.phase === "requesting";
  useEffect(() => {
    onCaptureChange?.(capturing);
    return () => onCaptureChange?.(false);
  }, [capturing, onCaptureChange]);
  useEffect(() => {
    if (!recorder.preview) return;
    function pauseCoveredPreview() {
      if (document.querySelector('[role="dialog"]')) previewAudio.current?.pause();
    }
    pauseCoveredPreview();
    const observer = new MutationObserver(pauseCoveredPreview);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [recorder.preview]);
  const seconds = Math.floor(recorder.elapsedMs / 1000);
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const buttonClass = "min-h-11 rounded-md px-3 text-sm hover:bg-accent disabled:opacity-50";

  async function send() {
    if (!recorder.preview || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(false);
    onClearFailedUpload(recorder.preview.file);
    try {
      const sent = await onSend(recorder.preview.file, recorder.preview.metadata);
      if (!mounted.current) return;
      if (sent) recorder.discard();
      else setSendError(true);
    } catch {
      if (mounted.current) setSendError(true);
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  }

  function cancelInterruptedPointerCapture(pointerId: number) {
    if (pointer.current?.id !== pointerId) return;
    if (!pointer.current.cancelled) {
      // A browser may cancel pointer capture while its microphone permission
      // sheet is open. Preserve that in-flight request exactly like a normal
      // release; `stop()` records the user's intent and lets the recorder
      // discard a late grant without invalidating the permission result.
      if (recorder.phase === "requesting") recorder.stop();
      else recorder.discard();
    }
    pointer.current = null;
  }

  return (
    <section aria-label="Voice message" className="mt-2 rounded-lg border border-border p-2">
      <div className="flex flex-wrap items-center gap-2">
        {recorder.phase !== "preview" && (
          <button
            type="button"
            className={buttonClass}
            style={{ touchAction: "none" }}
            aria-label={capturing ? "Stop recording" : "Record voice message"}
            onClick={(event) => {
              // Touch/pen use hold-to-record. Keyboard and mouse retain an
              // accessible start/stop action on every screen size.
              if (event.detail !== 0 && suppressPointerClick.current) {
                suppressPointerClick.current = false;
                return;
              }
              if (capturing) recorder.stop();
              else void recorder.start();
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary || pointer.current) return;
              suppressPointerClick.current = false;
              if (!mobile || event.pointerType === "mouse") return;
              pointer.current = { id: event.pointerId, x: event.clientX, cancelled: false };
              event.currentTarget.setPointerCapture(event.pointerId);
              void recorder.start();
            }}
            onPointerMove={(event) => {
              if (pointer.current?.id !== event.pointerId) return;
              if (!pointer.current.cancelled && pointer.current.x - event.clientX >= 80) {
                pointer.current.cancelled = true;
                recorder.discard();
              }
            }}
            onPointerUp={(event) => {
              if (pointer.current?.id !== event.pointerId) return;
              if (!pointer.current.cancelled) recorder.stop();
              pointer.current = null;
              suppressPointerClick.current = true;
            }}
            onPointerCancel={(event) => {
              cancelInterruptedPointerCapture(event.pointerId);
            }}
            onLostPointerCapture={(event) => {
              cancelInterruptedPointerCapture(event.pointerId);
            }}
          >
            {recorder.phase === "requesting"
              ? "Waiting for microphone…"
              : capturing
                ? "Stop recording"
                : mobile
                  ? "Hold to record"
                  : "Record voice message"}
          </button>
        )}
        {capturing && (
          <>
            <span aria-label="Recording duration">{duration}</span>
            <meter aria-label="Microphone level" min={0} max={1} value={recorder.level} />
            {mobile && <span className="text-xs text-muted-foreground">Slide left to discard</span>}
          </>
        )}
        {recorder.preview && (
          <>
            <audio
              ref={previewAudio}
              controls
              preload="metadata"
              src={recorder.preview.url}
              aria-label="Voice message preview"
            >
              {/* As with received voice audio, no transcript is generated or uploaded. */}
              <track kind="captions" />
            </audio>
            <span>{duration}</span>
            <button
              type="button"
              className={buttonClass}
              disabled={sending}
              onClick={() => void send()}
            >
              {sending ? "Sending voice message…" : "Send voice message"}
            </button>
          </>
        )}
        {recorder.phase !== "idle" && (
          <button
            type="button"
            className={buttonClass}
            disabled={sending}
            onClick={() => {
              if (recorder.preview) onClearFailedUpload(recorder.preview.file);
              recorder.discard();
              setSendError(false);
            }}
          >
            Discard recording
          </button>
        )}
      </div>
      {recorder.error && <p role="alert">{recorder.error}</p>}
      {sendError && <p role="alert">Voice message was not sent. Retry or discard the recording.</p>}
    </section>
  );
}
