import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RoomDetails } from "@/lib/matrix";
import { checkRoomAliasAvailable } from "@/lib/matrix";
import { useProfile } from "@/features/settings/useProfile";
import { useRoomAdminActions } from "./useRoomAdminActions";
import { useRoomAliases } from "./useRoomAliases";

interface PermissionGateProps {
  allowed: boolean;
  reason?: string;
  children: React.ReactNode;
}

/** Local copy of `RoomSettingsForm`'s disabled-with-tooltip gate — see that file for the pattern's rationale. */
function PermissionGate({ allowed, reason, children }: PermissionGateProps) {
  if (allowed) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <span className="inline-flex" tabIndex={0}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason ?? "You need a higher power level to do this"}</TooltipContent>
    </Tooltip>
  );
}

const NONE_VALUE = "__none__";

interface RoomAliasManagementProps {
  details: RoomDetails;
}

/**
 * Spec 32 room alias management: list/add/remove server-published (room
 * directory) aliases, and set/clear the `m.room.canonical_alias`. Rendered in
 * `RoomSettingsForm`'s General tab, gated by `room_alias_management` — see
 * `RoomSettingsForm.tsx`'s call site for the flag check.
 *
 * Power-level gating reuses `details.can.set_canonical_alias` for the whole
 * surface (add/remove/canonical-select), not a separate directory-publish
 * check — see that field's doc comment in `room_admin.rs` for why Matrix has
 * no distinct power-level requirement for directory publish/unpublish.
 */
export function RoomAliasManagement({ details }: RoomAliasManagementProps) {
  const actions = useRoomAdminActions(details.room_id);
  const { data: aliases, isLoading, isError } = useRoomAliases(details.room_id);
  const { data: profile } = useProfile();
  const [newAlias, setNewAlias] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const canManage = details.can.set_canonical_alias;

  // The user only types the local part; server name is the signed-in user's
  // own homeserver, not the room's origin server — a local alias can only be
  // published on the server the alias-create/directory endpoints actually
  // hit, which is the user's own homeserver, and those can differ for a
  // federated room.
  const serverName = profile?.user_id.split(":").slice(1).join(":") ?? "";

  async function handleAddAlias() {
    const localPart = newAlias.trim().replace(/^#/, "");
    if (!localPart) return;
    const alias = `#${localPart}:${serverName}`;
    setAddError(null);

    // Pre-check availability so a taken alias surfaces as "already in use"
    // up front — advisory only (a TOCTOU race is possible), so
    // `add_room_alias`'s own conflict error below is still authoritative.
    setCheckingAvailability(true);
    let available: boolean;
    try {
      available = await checkRoomAliasAvailable(alias);
    } catch (error) {
      setCheckingAvailability(false);
      setAddError(error instanceof Error ? error.message : "Couldn't check alias availability");
      return;
    }
    setCheckingAvailability(false);
    if (!available) {
      setAddError("That alias is already in use");
      return;
    }

    actions.addAlias.mutate(alias, {
      onSuccess: () => setNewAlias(""),
      onError: (error) => setAddError(error.message),
    });
  }

  function handleRemoveAlias(alias: string) {
    actions.removeAlias.mutate(alias, {
      onSuccess: () => {
        // If the removed alias was canonical or alt, clear it out of that
        // state too — `remove_room_alias` only unpublishes from the
        // directory, it doesn't touch `m.room.canonical_alias` (see
        // `remove_room_alias`'s doc comment in `room_admin.rs`).
        if (details.canonical_alias === alias) {
          actions.setCanonicalAlias.mutate(null, {
            onError: (error) =>
              setAddError(`Alias removed, but couldn't clear it as canonical: ${error.message}`),
          });
        } else if (details.alt_aliases.includes(alias)) {
          actions.removeAltAlias.mutate(alias, {
            onError: (error) =>
              setAddError(
                `Alias removed, but couldn't clear it from alt aliases: ${error.message}`,
              ),
          });
        }
      },
      onError: (error) => setAddError(error.message),
    });
  }

  const canonicalOptions = [
    details.canonical_alias,
    ...(aliases ?? []),
    ...details.alt_aliases,
  ].filter((alias, index, all): alias is string => alias !== null && all.indexOf(alias) === index);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Canonical alias</Label>
        <PermissionGate allowed={canManage}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={!canManage || actions.setCanonicalAlias.isPending}
              >
                {details.canonical_alias ?? "None"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup
                value={details.canonical_alias ?? NONE_VALUE}
                onValueChange={(value) => {
                  // Disabling the trigger while a mutation is pending (above)
                  // prevents overlapping calls from racing on stale
                  // `alt_aliases` state server-side — see room_admin.rs.
                  if (actions.setCanonicalAlias.isPending) return;
                  actions.setCanonicalAlias.mutate(value === NONE_VALUE ? null : value, {
                    onError: (error) => setAddError(error.message),
                  });
                }}
              >
                <DropdownMenuRadioItem value={NONE_VALUE}>None</DropdownMenuRadioItem>
                {canonicalOptions.map((alias) => (
                  <DropdownMenuRadioItem key={alias} value={alias}>
                    {alias}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </PermissionGate>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Published addresses</Label>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {isError && <p className="text-sm text-destructive">Couldn't load room addresses.</p>}
        {aliases && aliases.length === 0 && (
          <p className="text-sm text-muted-foreground">No published addresses yet.</p>
        )}
        {aliases && aliases.length > 0 && (
          <ul className="flex flex-col gap-1">
            {aliases.map((alias) => (
              <li key={alias} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{alias}</span>
                <PermissionGate allowed={canManage}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canManage}
                    onClick={() => handleRemoveAlias(alias)}
                  >
                    Remove
                  </Button>
                </PermissionGate>
              </li>
            ))}
          </ul>
        )}

        <PermissionGate allowed={canManage}>
          <div className="flex gap-2">
            <div className="flex flex-1 items-center gap-1">
              <span className="text-sm text-muted-foreground">#</span>
              <Input
                aria-label="New alias local part"
                value={newAlias}
                disabled={!canManage}
                onChange={(e) => setNewAlias(e.target.value)}
                placeholder="alias"
                className="flex-1"
              />
              <span className="truncate text-sm text-muted-foreground">:{serverName}</span>
            </div>
            <Button
              size="sm"
              disabled={
                !canManage ||
                !newAlias.trim() ||
                !serverName ||
                checkingAvailability ||
                actions.addAlias.isPending
              }
              onClick={handleAddAlias}
            >
              {checkingAvailability ? "Checking…" : "Add"}
            </Button>
          </div>
        </PermissionGate>
        {addError && <p className="text-sm text-destructive">{addError}</p>}
      </div>
    </div>
  );
}
