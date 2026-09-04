import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useFeatureFlagPersistenceSettled, useFlag } from "@/featureFlags";
import { isWebBuild, platformTag, preloadPlatformTag } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { exportRoomKeys, importRoomKeys } from "@/lib/matrix";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

type TransferMode = "export" | "import";
const TransferContext = createContext<{
  openDialog: (mode: TransferMode) => void;
  transferEnabled: boolean;
} | null>(null);

async function resolveNativePlatform() {
  await preloadPlatformTag();
  return platformTag();
}

export function RoomKeyFilesSessionProvider({
  children,
  resolvePlatform = resolveNativePlatform,
}: {
  children: ReactNode;
  resolvePlatform?: () => Promise<string>;
}) {
  const enabled = useFlag("crypto_key_files");
  const settled = useFeatureFlagPersistenceSettled("crypto_key_files");
  const nativeEnabled = !isWebBuild() && enabled && settled;
  const [transferEnabled, setTransferEnabled] = useState(false);
  useEffect(() => {
    if (!nativeEnabled) {
      setTransferEnabled(false);
      return;
    }
    let active = true;
    void resolvePlatform()
      .then((platform) => {
        if (active) setTransferEnabled(["macos", "windows", "linux", "ios"].includes(platform));
      })
      .catch(() => {
        if (active) setTransferEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [nativeEnabled, resolvePlatform]);
  return (
    <RoomKeyFilesProvider enabled={nativeEnabled} transferEnabled={transferEnabled}>
      {children}
    </RoomKeyFilesProvider>
  );
}

export function RoomKeyFilesProvider({
  children,
  enabled,
  transferEnabled = true,
}: {
  children: ReactNode;
  enabled: boolean;
  transferEnabled?: boolean;
}) {
  const [mode, setMode] = useState<TransferMode | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function startTransfer() {
    if (!enabled || !transferEnabled || inFlight.current || !canSubmit || !mode) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const summary =
        mode === "export" ? await exportRoomKeys(passphrase) : await importRoomKeys(passphrase);
      if (!summary.completed) {
        closeDialog();
        return;
      }
      if (
        "imported_count" in summary &&
        typeof summary.imported_count === "number" &&
        "total_count" in summary &&
        typeof summary.total_count === "number"
      ) {
        setResult(`Imported ${summary.imported_count} of ${summary.total_count} room keys.`);
      } else {
        setResult("Encrypted room keys exported successfully.");
      }
      closeDialog();
    } catch {
      setError("Room key transfer failed. Check the file and passphrase, then retry.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function openDialog(nextMode: TransferMode) {
    if (!enabled || !transferEnabled || inFlight.current) return;
    setError(null);
    setResult(null);
    setMode(nextMode);
  }

  function closeDialog() {
    setMode(null);
    setPassphrase("");
    setConfirmation("");
    setError(null);
  }

  const passphraseIsValid =
    new TextEncoder().encode(passphrase).length <= 1024 &&
    (mode === "import" || Array.from(passphrase).length >= 8);
  const canSubmit =
    passphraseIsValid && mode !== null && (mode === "import" || confirmation === passphrase);

  return (
    <TransferContext.Provider value={{ openDialog, transferEnabled }}>
      {children}

      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open && !inFlight.current) closeDialog();
        }}
      >
        <DialogContent
          showCloseButton={!pending}
          onEscapeKeyDown={(event) => {
            if (inFlight.current) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (inFlight.current) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === "export" ? "Export room keys" : "Import room keys"}</DialogTitle>
            <DialogDescription>
              {mode === "export"
                ? "Choose a passphrase with at least 8 characters. You will need it to import this file later."
                : "Enter the passphrase used when this encrypted room-key file was exported."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="room-key-file-passphrase">Passphrase</Label>
              <Input
                id="room-key-file-passphrase"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </div>
            {mode === "export" && (
              <div>
                <Label htmlFor="room-key-file-confirmation">Confirm passphrase</Label>
                <Input
                  id="room-key-file-confirmation"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={closeDialog} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={() => void startTransfer()}
              disabled={!enabled || !canSubmit || pending}
            >
              {pending
                ? mode === "export"
                  ? "Exporting…"
                  : "Importing…"
                : mode === "export"
                  ? "Choose destination"
                  : "Choose file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={result !== null}
        onOpenChange={(open) => {
          if (!open) setResult(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Room key transfer complete</DialogTitle>
            <DialogDescription>Keep exported files and their passphrase safe.</DialogDescription>
          </DialogHeader>
          <output>{result}</output>
          <DialogFooter>
            <Button onClick={() => setResult(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TransferContext.Provider>
  );
}

export function RoomKeyFilesCard({
  enabled = true,
  transferEnabled,
}: {
  enabled?: boolean;
  transferEnabled?: boolean;
}) {
  const transfer = useContext(TransferContext);
  if (!enabled || !transfer) return null;
  const canTransfer = transferEnabled ?? transfer.transferEnabled;
  if (!canTransfer) return null;
  return (
    <SettingsCard heading="Room key files">
      <SettingTile>
        <p className="mb-3 text-sm text-muted-foreground">
          Import or export encrypted Matrix room keys for manual backup or migration. These files
          do not replace account recovery or device verification.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => transfer.openDialog("import")}>
            Import keys
          </Button>
          <Button size="sm" variant="outline" onClick={() => transfer.openDialog("export")}>
            Export keys
          </Button>
        </div>
      </SettingTile>
    </SettingsCard>
  );
}
