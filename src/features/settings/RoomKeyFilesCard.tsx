import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
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

export function RoomKeyFilesCard() {
  const [mode, setMode] = useState<TransferMode | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const transfer = useMutation({
    mutationFn: async () => {
      if (mode === "export") return exportRoomKeys(passphrase);
      if (mode === "import") return importRoomKeys(passphrase);
      throw new Error("Choose an import or export operation.");
    },
    onSuccess: (summary) => {
      if (!summary.completed) return;
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
    },
  });

  function openDialog(nextMode: TransferMode) {
    transfer.reset();
    setResult(null);
    setMode(nextMode);
  }

  function closeDialog() {
    setMode(null);
    setPassphrase("");
    setConfirmation("");
    transfer.reset();
  }

  const passphraseIsValid = passphrase.length >= 8;
  const canSubmit =
    passphraseIsValid && mode !== null && (mode === "import" || confirmation === passphrase);

  return (
    <>
      <SettingsCard heading="Room key files">
        <SettingTile>
          <p className="mb-3 text-sm text-muted-foreground">
            Import or export encrypted Matrix room keys for manual backup or migration. These files
            do not replace account recovery or device verification.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => openDialog("import")}>
              Import keys
            </Button>
            <Button size="sm" variant="outline" onClick={() => openDialog("export")}>
              Export keys
            </Button>
          </div>
          {result && <output className="mt-3 block text-sm text-muted-foreground">{result}</output>}
        </SettingTile>
      </SettingsCard>

      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent>
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
            {transfer.isError && (
              <p className="text-sm text-destructive">{String(transfer.error)}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={closeDialog} disabled={transfer.isPending}>
              Cancel
            </Button>
            <Button onClick={() => transfer.mutate()} disabled={!canSubmit || transfer.isPending}>
              {transfer.isPending
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
    </>
  );
}
