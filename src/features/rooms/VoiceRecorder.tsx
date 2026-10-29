import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import type { VoiceMessageMetadata } from "@bindings/VoiceMessageMetadata";
import { useVoiceRecorder } from "./useVoiceRecorder";

interface VoiceRecorderProps {
  mobile: boolean;
  /** Composer places this accessory inside its existing shell, never in a second panel. */
  presentation?: "panel" | "composer";
  /** External text/upload send ownership; never starts capture or sends while busy. */
  disabled?: boolean;
  onStart?: () => boolean;
  canSend?: () => boolean;
  /** Includes preview and send, so the integrator can retain but suspend the text editor. */
  onBusyChange?: (busy: boolean) => void;
  onSend: (file: File, metadata: VoiceMessageMetadata) => Promise<boolean>;
  onClearFailedUpload: (file: File) => void;
  onCaptureChange?: (capturing: boolean) => void;
}

export function VoiceRecorder({
  mobile,
  presentation = "panel",
  disabled = false,
  onStart,
  canSend,
  onBusyChange,
  onSend,
  onClearFailedUpload,
  onCaptureChange,
}: VoiceRecorderProps) {
  const recorder = useVoiceRecorder();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const sendingRef = useRef(false);
  const mounted = useRef(true);
  const startAttempt = useRef(0);
  const previewAudio = useRef<HTMLAudioElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);
  const restoreIdleFocus = useRef(false);
  useEffect(() => {
    if (recorder.phase === "idle" && restoreIdleFocus.current) {
      restoreIdleFocus.current = false;
      recordButton.current?.focus();
    }
  }, [recorder.phase]);
  const pointer = useRef<{ id: number; x: number; cancelled: boolean } | null>(null);
  const suppressPointerClick = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      startAttempt.current += 1;
    };
  }, []);
  const capturing = recorder.phase === "recording" || recorder.phase === "requesting";
  const busy = recorder.phase !== "idle" || sending;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
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
  const buttonClass =
    "min-h-11 min-w-11 rounded-md px-3 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";

  async function startRecording() {
    const attempt = ++startAttempt.current;
    const started = await recorder.start();
    // Unsupported/denied capture can finish in the initiating event batch.
    // Release the synchronous claim even if no busy render was committed.
    if (started === false && mounted.current && startAttempt.current === attempt)
      onBusyChange?.(false);
  }

  async function send() {
    if (!recorder.preview || sendingRef.current || disabled || canSend?.() === false) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(false);
    try {
      previewAudio.current?.pause();
      onClearFailedUpload(recorder.preview.file);
      const sent = await onSend(recorder.preview.file, recorder.preview.metadata);
      if (!mounted.current) return;
      if (sent) {
        restoreIdleFocus.current = true;
        recorder.discard();
      } else setSendError(true);
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
    suppressPointerClick.current = true;
  }

  return (
    <section
      aria-label="Voice message"
      aria-busy={sending}
      className={
        presentation === "composer"
          ? `min-w-0 max-w-full ${busy ? "basis-full" : "shrink-0"}`
          : "mt-2 rounded-lg border border-border p-2"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {recorder.phase !== "preview" && (
          <button
            ref={recordButton}
            type="button"
            className={buttonClass}
            disabled={disabled && !capturing}
            title={
              capturing
                ? "Stop recording"
                : mobile
                  ? "Hold to record; slide left to discard"
                  : "Record voice message"
            }
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
              else if (!disabled && onStart?.() !== false) void startRecording();
            }}
            onPointerDown={(event) => {
              if (disabled || capturing) return;
              if (event.button !== 0 || !event.isPrimary || pointer.current) return;
              suppressPointerClick.current = false;
              if (event.pointerType === "mouse") return;
              if (onStart?.() === false) return;
              pointer.current = { id: event.pointerId, x: event.clientX, cancelled: false };
              event.currentTarget.setPointerCapture(event.pointerId);
              void startRecording();
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
            {presentation === "composer" && recorder.phase === "idle" ? (
              <Mic aria-hidden="true" size={20} />
            ) : recorder.phase === "requesting" ? (
              "Waiting for microphone…"
            ) : capturing ? (
              "Stop recording"
            ) : mobile ? (
              "Hold to record"
            ) : (
              "Record voice message"
            )}
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
              className="max-w-full min-w-0"
              aria-label="Voice message preview"
            >
              {/* As with received voice audio, no transcript is generated or uploaded. */}
              <track kind="captions" />
            </audio>
            <span>{duration}</span>
            <button
              type="button"
              className={buttonClass}
              disabled={sending || disabled}
              onClick={() => void send()}
            >
              {sending
                ? "Sending voice message…"
                : sendError
                  ? "Retry voice message"
                  : "Send voice message"}
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
              restoreIdleFocus.current = true;
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
