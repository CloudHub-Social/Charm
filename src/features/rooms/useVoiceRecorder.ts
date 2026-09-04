import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ChatVisibilityContext } from "@/features/shell/chatVisibility";
import type { VoiceMessageMetadata } from "@bindings/VoiceMessageMetadata";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DURATION_MS = 600_000;
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
    context: AudioContext;
    timer: ReturnType<typeof setInterval>;
  } | null>(null);
  const previewUrl = useRef<string | null>(null);
  const preparing = useRef<{ stream: MediaStream; context: AudioContext | null } | null>(null);

  const releaseCapture = useCallback(() => {
    const pending = preparing.current;
    preparing.current = null;
    pending?.stream.getTracks().forEach((track) => track.stop());
    if (pending?.context) void pending.context.close().catch(() => {});
    const capture = active.current;
    active.current = null;
    if (!capture) return;
    clearInterval(capture.timer);
    capture.stream.getTracks().forEach((track) => track.stop());
    if (capture.recorder.state !== "inactive") capture.recorder.stop();
    void capture.context.close().catch(() => {});
  }, []);

  const clearResources = useCallback(() => {
    epoch.current += 1;
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

  function stop() {
    if (active.current) {
      if (active.current.recorder.state !== "inactive") active.current.recorder.stop();
    } else discard(); // Pointer released before permission was granted.
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (epoch.current !== attempt) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      // Capture ownership begins before the next await: disposal must stop
      // the microphone even if the browser never resolves audio resume.
      preparing.current = { stream, context: null };
      context = new AudioContext();
      preparing.current.context = context;
      await context.resume();
      if (epoch.current !== attempt) {
        // The superseding discard/unmount already released these resources.
        return;
      }
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      const chunks: Blob[] = [];
      const amplitudes: number[] = [];
      const samples = new Float32Array(analyser.fftSize);
      let startedAt = 0;
      let bytes = 0;
      recorder.ondataavailable = (event) => {
        if (epoch.current !== attempt || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MAX_BYTES) {
          discard();
          setError("Recording exceeded the size limit. Please record a shorter message.");
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
        const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
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
        analyser.getFloatTimeDomainData(samples);
        const amplitude = Math.min(
          1,
          Math.max(0, ...Array.from(samples, (sample) => Math.abs(sample))),
        );
        if (amplitudes.length < 6000) amplitudes.push(Number.isFinite(amplitude) ? amplitude : 0);
        setLevel(Number.isFinite(amplitude) ? amplitude : 0);
        const elapsed = Math.round(performance.now() - startedAt);
        setElapsedMs(Math.min(MAX_DURATION_MS, elapsed));
        if (elapsed >= MAX_DURATION_MS && recorder.state !== "inactive") recorder.stop();
      }, 100);
      active.current = { recorder, stream, context, timer };
      preparing.current = null;
      startedAt = performance.now();
      recorder.start(250);
      setPhase("recording");
    } catch (cause) {
      if (epoch.current !== attempt) return;
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
