import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ChatVisibilityContext } from "@/features/shell/chatVisibility";
import type { VoiceMessageMetadata } from "@bindings/VoiceMessageMetadata";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DURATION_MS = 600_000;
const AUTO_STOP_HEADROOM_MS = 1_000;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];

export function useVoiceRecorder() {
  const chatVisible = useContext(ChatVisibilityContext);
  const [phase, setPhase] = useState<"idle" | "requesting" | "recording" | "preview">("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    file: File;
    url: string;
    metadata: VoiceMessageMetadata;
  } | null>(null);
  const epoch = useRef(0);
  const active = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    context: AudioContext | null;
    timer: ReturnType<typeof setInterval>;
    durationTimer: ReturnType<typeof setTimeout>;
    requestStop: () => void;
  } | null>(null);
  const previewUrl = useRef<string | null>(null);
  const preparing = useRef<{
    stream: MediaStream | null;
    context: AudioContext | null;
  } | null>(null);
  const stopRequestedDuringPermission = useRef(false);

  const releaseCapture = useCallback(() => {
    const pending = preparing.current;
    preparing.current = null;
    pending?.stream?.getTracks().forEach((track) => track.stop());
    if (pending?.context) void pending.context.close().catch(() => {});
    const capture = active.current;
    active.current = null;
    if (!capture) return;
    clearInterval(capture.timer);
    clearTimeout(capture.durationTimer);
    capture.stream.getTracks().forEach((track) => track.stop());
    if (capture.recorder.state !== "inactive") capture.recorder.stop();
    if (capture.context) void capture.context.close().catch(() => {});
  }, []);

  const clearResources = useCallback(() => {
    epoch.current += 1;
    stopRequestedDuringPermission.current = false;
    releaseCapture();
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
  }, [releaseCapture]);

  function discard() {
    clearResources();
    setPreview(null);
    setPhase("idle");
    setElapsedMs(0);
    setLevel(0);
    setError(null);
  }

  useEffect(() => () => clearResources(), [clearResources]);

  useEffect(() => {
    if (chatVisible || (phase !== "requesting" && phase !== "recording")) return;
    clearResources();
    setPreview(null);
    setPhase("idle");
    setElapsedMs(0);
    setLevel(0);
    setError("Recording was discarded when the chat was hidden.");
  }, [chatVisible, phase, clearResources]);

  useEffect(() => {
    function abandonBackgroundCapture() {
      if (phase !== "requesting" && phase !== "recording") return;
      clearResources();
      setPreview(null);
      setPhase("idle");
      setElapsedMs(0);
      setLevel(0);
      setError("Recording was discarded when Charm went into the background.");
    }
    function visibilityChanged() {
      if (document.hidden) abandonBackgroundCapture();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", abandonBackgroundCapture);
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", abandonBackgroundCapture);
    };
  }, [phase, clearResources]);

  useEffect(() => {
    if (phase !== "requesting" && phase !== "recording") return;
    function abandonDialogCoveredCapture() {
      if (!document.querySelector('[role="dialog"]')) return;
      clearResources();
      setPreview(null);
      setPhase("idle");
      setElapsedMs(0);
      setLevel(0);
      setError("Recording was discarded when a dialog opened over the chat.");
    }
    abandonDialogCoveredCapture();
    const observer = new MutationObserver(abandonDialogCoveredCapture);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [phase, clearResources]);

  function stop() {
    if (active.current) {
      active.current.requestStop();
    } else if (preparing.current || phase === "requesting") {
      // Releasing a mobile hold must not invalidate the in-flight permission
      // result. A denial still needs to reach the user; a grant is released
      // immediately with an actionable prompt to hold again.
      stopRequestedDuringPermission.current = true;
    }
  }

  async function start() {
    if (active.current || phase === "requesting") return;
    discard();
    const attempt = epoch.current;
    setPhase("requesting");
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
        throw new Error("unsupported");
      const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("unsupported");
      // Safari/iOS requires Web Audio activation in the initiating gesture.
      // Invoke resume before awaiting a potentially interactive permission
      // prompt; metering is best-effort and must never block MediaRecorder.
      try {
        context = new AudioContext();
        void context.resume().catch(() => {});
      } catch {
        // Metering is best-effort. MediaRecorder can still capture and emit
        // a valid voice message when Web Audio is unavailable or exhausted.
        context = null;
      }
      preparing.current = { stream: null, context };
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (epoch.current !== attempt) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const pending = preparing.current;
      if (!pending || pending.context !== context) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      pending.stream = stream;
      if (stopRequestedDuringPermission.current) {
        stopRequestedDuringPermission.current = false;
        releaseCapture();
        setPhase("idle");
        setError("Microphone access is ready. Hold again to record.");
        return;
      }
      let analyser: AnalyserNode | null = null;
      if (context) {
        try {
          analyser = context.createAnalyser();
          analyser.fftSize = 256;
          context.createMediaStreamSource(stream).connect(analyser);
        } catch {
          void context.close().catch(() => {});
          context = null;
          pending.context = null;
          analyser = null;
        }
      }
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      const chunks: Blob[] = [];
      const amplitudes: number[] = [];
      const samples = new Float32Array(analyser?.fftSize ?? 1);
      let startedAt = 0;
      let stoppedAt: number | null = null;
      function requestStop(requestedAt = performance.now()) {
        if (recorder.state === "inactive") return;
        stoppedAt = requestedAt;
        recorder.stop();
      }
      let bytes = 0;
      recorder.ondataavailable = (event) => {
        if (epoch.current !== attempt || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MAX_BYTES) {
          // Leave the MediaRecorder callback before stopping it. The standard
          // queues the final dataavailable/stop sequence, and this boundary
          // avoids asking Safari/WebKit to transition the recorder while it
          // is still delivering a chunk.
          queueMicrotask(() => {
            if (epoch.current !== attempt) return;
            discard();
            setError("Recording exceeded the size limit. Please record a shorter message.");
          });
          return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (epoch.current !== attempt) return;
        discard();
        setError("Recording failed. Please check microphone access and try again.");
      };
      recorder.onstop = () => {
        if (epoch.current !== attempt) return;
        const durationMs = Math.max(1, Math.round((stoppedAt ?? performance.now()) - startedAt));
        releaseCapture();
        if (durationMs > MAX_DURATION_MS) {
          discard();
          setError("Recording exceeded the duration limit. Please record a shorter message.");
          return;
        }
        if (!bytes) {
          setPhase("idle");
          setError("No audio was recorded. Please try again.");
          return;
        }
        const count = Math.min(120, Math.max(1, amplitudes.length));
        const waveform = Array.from({ length: count }, (_, index) => {
          const from = Math.floor((index * amplitudes.length) / count);
          const to = Math.max(from + 1, Math.floor(((index + 1) * amplitudes.length) / count));
          return Math.max(0, ...amplitudes.slice(from, to));
        });
        const extension = mimeType.startsWith("audio/mp4")
          ? "m4a"
          : mimeType.startsWith("audio/ogg")
            ? "ogg"
            : "webm";
        const file = new File(chunks, `Voice message.${extension}`, {
          type: recorder.mimeType || mimeType,
        });
        const url = URL.createObjectURL(file);
        previewUrl.current = url;
        setPreview({ file, url, metadata: { duration_ms: durationMs, waveform } });
        setElapsedMs(durationMs);
        setLevel(0);
        setPhase("preview");
      };
      const timer = setInterval(() => {
        if (epoch.current !== attempt) return;
        analyser?.getFloatTimeDomainData(samples);
        const amplitude = analyser
          ? Math.min(1, Math.max(0, ...Array.from(samples, (sample) => Math.abs(sample))))
          : 0;
        if (amplitudes.length < 6000) amplitudes.push(Number.isFinite(amplitude) ? amplitude : 0);
        setLevel(Number.isFinite(amplitude) ? amplitude : 0);
        const elapsed = Math.round(performance.now() - startedAt);
        setElapsedMs(Math.min(MAX_DURATION_MS, elapsed));
      }, 100);
      preparing.current = null;
      startedAt = performance.now();
      // Ask the recorder to stop slightly before the hard cap. Browser timer
      // callbacks can drift, and requestStop deliberately records the actual
      // callback time so a materially stalled page is still rejected below.
      const durationTimer = setTimeout(
        () => requestStop(),
        MAX_DURATION_MS - AUTO_STOP_HEADROOM_MS,
      );
      active.current = { recorder, stream, context, timer, durationTimer, requestStop };
      recorder.start(250);
      setPhase("recording");
    } catch (cause) {
      if (epoch.current !== attempt) return;
      stopRequestedDuringPermission.current = false;
      releaseCapture();
      setPhase("idle");
      setError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Microphone access was denied. Allow it in your device or browser settings to record."
          : "Audio recording is unavailable. Check microphone access and try again.",
      );
    }
  }

  return { phase, elapsedMs, level, error, preview, start, stop, discard };
}
