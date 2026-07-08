import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cancelQrLogin,
  onQrLoginProgress,
  startQrLogin,
  submitQrCheckCode,
  type LoginResponse,
  type QrLoginProgressEvent,
} from "@/lib/matrix";
import { parseCheckCode, sanitizeCheckCodeInput } from "./qrCheckCode";
import { logAndIgnore } from "@/lib/logAndIgnore";

interface QrLoginScreenProps {
  homeserverUrl: string;
  onSignedIn: (session: LoginResponse) => void;
  onCancel: () => void;
}

type Stage =
  | { kind: "starting" }
  | { kind: "qr_ready"; qrCodeBytes: number[] }
  | { kind: "waiting_for_check_code" }
  | { kind: "waiting_for_approval" }
  | { kind: "syncing_secrets" }
  | { kind: "error"; message: string };

/**
 * MSC4108 scan-to-sign-in: Charm generates and displays a QR code, an
 * already-signed-in device scans it, and — after both sides confirm a
 * short check code shown here — grants this device a session. Only works
 * against a homeserver whose auth is delegated to Matrix Authentication
 * Service; plain password/SSO homeservers don't support this flow, so
 * `start_qr_login`'s own error surfaces here if that's not the case.
 */
export function QrLoginScreen({ homeserverUrl, onSignedIn, onCancel }: QrLoginScreenProps) {
  const [stage, setStage] = useState<Stage>({ kind: "starting" });
  const [checkCode, setCheckCode] = useState("");
  const [submittingCheckCode, setSubmittingCheckCode] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Guards against acting on progress events delivered after this screen
  // unmounted (e.g. the user navigated away right as the other device
  // approved) — there's nothing to update at that point.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // Registers the listener BEFORE starting the login attempt: since
    // onQrLoginProgress itself returns a promise, starting the attempt first
    // can let the Rust side emit "qr_ready" during the gap before the
    // listener is actually attached, leaving the screen stuck on "Generating
    // QR code…" forever.
    const unlistenPromise = onQrLoginProgress((event: QrLoginProgressEvent) => {
      if (!mountedRef.current) return;
      switch (event.state) {
        case "qr_ready":
          setStage({ kind: "qr_ready", qrCodeBytes: event.qr_code_bytes });
          break;
        case "waiting_for_check_code":
          setStage({ kind: "waiting_for_check_code" });
          break;
        case "waiting_for_approval":
          setStage({ kind: "waiting_for_approval" });
          break;
        case "syncing_secrets":
          setStage({ kind: "syncing_secrets" });
          break;
        case "done":
          // The Rust side only emits "done" after it has already persisted
          // and adopted the session (see qr_login.rs's comment on
          // QrLoginProgressEvent::Done) — using the session carried on the
          // event directly, rather than re-fetching via try_restore_session,
          // avoids racing that adoption or building a second redundant
          // client/sync loop on top of it.
          onSignedIn(event.session);
          break;
        case "cancelled":
          setStage({ kind: "error", message: event.reason });
          break;
        case "error":
          setStage({ kind: "error", message: event.message });
          break;
      }
    });

    unlistenPromise.then(() => {
      if (mountedRef.current) {
        startQrLogin(homeserverUrl).catch((err: unknown) => {
          if (mountedRef.current) setStage({ kind: "error", message: String(err) });
        });
      }
    });

    return () => {
      mountedRef.current = false;
      // Chained on the promise (not a variable set once it resolves): if
      // unmount happens before onQrLoginProgress itself resolves, the
      // listener would otherwise never get unregistered and would keep
      // firing into a gone component for the rest of the app's lifetime.
      unlistenPromise.then((fn) => fn());
      // Releases the Rust-side background task if the user navigates away
      // without pressing Cancel — otherwise it keeps running (and could
      // still adopt a session) after this screen is gone.
      cancelQrLogin().catch(logAndIgnore);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount, homeserverUrl is fixed for the life of this screen
  }, []);

  useEffect(() => {
    if (stage.kind !== "qr_ready" || !canvasRef.current) return;
    // Byte-mode segment, not a string: qr_code_bytes is the raw MSC4108
    // rendezvous payload and isn't necessarily valid UTF-8 — encoding it as
    // text would corrupt it.
    QRCode.toCanvas(
      canvasRef.current,
      [{ data: new Uint8Array(stage.qrCodeBytes), mode: "byte" }],
      {
        width: 240,
        margin: 1,
      },
    ).catch((err: unknown) => setStage({ kind: "error", message: String(err) }));
  }, [stage]);

  function handleCancel() {
    cancelQrLogin().catch(logAndIgnore);
    onCancel();
  }

  async function handleSubmitCheckCode(e: React.FormEvent) {
    e.preventDefault();
    const code = parseCheckCode(checkCode);
    if (code === null) return;
    setSubmittingCheckCode(true);
    try {
      await submitQrCheckCode(code);
      setStage({ kind: "waiting_for_approval" });
    } catch (err) {
      setStage({ kind: "error", message: String(err) });
    } finally {
      setSubmittingCheckCode(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {stage.kind === "starting" && (
        <div className="flex flex-col items-center gap-2 py-8">
          <Loader2 className="animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Generating QR code…</p>
        </div>
      )}

      {stage.kind === "qr_ready" && (
        <>
          <canvas ref={canvasRef} className="rounded-lg border border-border" />
          <p className="text-center text-sm text-muted-foreground">
            Scan this with another device you're already signed in on
          </p>
        </>
      )}

      {stage.kind === "waiting_for_check_code" && (
        <form onSubmit={handleSubmitCheckCode} className="flex w-full flex-col gap-3">
          <p className="text-center text-sm text-muted-foreground">
            Enter the code shown on your other device
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="check-code">Check code</Label>
            <Input
              id="check-code"
              inputMode="numeric"
              value={checkCode}
              onChange={(e) => setCheckCode(sanitizeCheckCodeInput(e.currentTarget.value))}
              placeholder="00"
              disabled={submittingCheckCode}
            />
          </div>
          <Button type="submit" disabled={submittingCheckCode || checkCode === ""}>
            {submittingCheckCode && <Loader2 className="animate-spin" />}
            Confirm
          </Button>
        </form>
      )}

      {stage.kind === "waiting_for_approval" && (
        <div className="flex flex-col items-center gap-2 py-8">
          <Loader2 className="animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Waiting for approval on your other device…
          </p>
        </div>
      )}

      {stage.kind === "syncing_secrets" && (
        <div className="flex flex-col items-center gap-2 py-8">
          <Loader2 className="animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Syncing encryption keys…</p>
        </div>
      )}

      {stage.kind === "error" && (
        <p className="text-center text-sm text-destructive">{stage.message}</p>
      )}

      <Button type="button" variant="outline" onClick={handleCancel} className="w-full">
        Cancel
      </Button>
    </div>
  );
}
