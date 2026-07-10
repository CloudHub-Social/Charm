import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  crossSigningStatus,
  deleteDevice,
  getCrossSigningResetUrl,
  getDeviceDeleteUrl,
  listDevices,
  onSasUpdate,
  recoverFromKey,
  recoveryStatus,
  requestDeviceVerification,
} from "@/lib/matrix";

export const DEVICES_QUERY_KEY = ["devices"] as const;
export const CROSS_SIGNING_STATUS_QUERY_KEY = ["crossSigningStatus"] as const;
const CROSS_SIGNING_RESET_URL_QUERY_KEY = ["crossSigningResetUrl"] as const;
export const RECOVERY_STATUS_QUERY_KEY = ["recoveryStatus"] as const;

export function useDevices(enabled = true) {
  return useQuery({
    queryKey: DEVICES_QUERY_KEY,
    queryFn: listDevices,
    enabled,
  });
}

export function useCrossSigningStatus(enabled = true) {
  return useQuery({
    queryKey: CROSS_SIGNING_STATUS_QUERY_KEY,
    queryFn: crossSigningStatus,
    enabled,
  });
}

/** `null` when there's no OIDC account-management URL to offer a "Reset" link for. */
export function useCrossSigningResetUrl(enabled = true) {
  return useQuery({
    queryKey: CROSS_SIGNING_RESET_URL_QUERY_KEY,
    queryFn: getCrossSigningResetUrl,
    enabled,
  });
}

/**
 * Polls rather than fetching once: the initial `/sync` that populates
 * secret-storage account data runs asynchronously after login/session
 * restore, and nothing currently pushes an event when the SDK's
 * `recovery().state()` changes (no WebSocket/Tauri-event plumbing for this
 * yet — a deliberate scope cut, see the recovery-key-restore PR description).
 * Without polling, a Devices panel that mounted while this was still
 * `"unknown"` — or another session enabling recovery while this one stays
 * open — could leave the Recovery card hidden for the rest of that mount,
 * since the app's default `QueryClient` also disables focus refetching (see
 * `providers.tsx`). The underlying check is a cheap local SDK read (Tauri)
 * or a trivial GET (web), not a heavy operation, so this stays cheap even at
 * a fairly tight interval.
 */
export function useRecoveryStatus(enabled = true) {
  return useQuery({
    queryKey: RECOVERY_STATUS_QUERY_KEY,
    queryFn: recoveryStatus,
    enabled,
    refetchInterval: 10_000,
  });
}

export function useRecoverFromKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (recoveryKey: string) => recoverFromKey(recoveryKey),
    // A successful recover() imports cross-signing secrets too (see
    // recover_from_key_impl's doc comment) and can mark this device verified
    // — not just the backup key — so both the Cross-signing tile's status
    // and the current device's verified badge (from the cached `listDevices`
    // result) need invalidating alongside recovery's own, or they can keep
    // showing stale state until an unrelated refresh happens to occur.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: RECOVERY_STATUS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: CROSS_SIGNING_STATUS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_KEY }),
      ]),
  });
}

/**
 * `null` when there's no OIDC account-management URL for revoking this
 * device — see the Rust command's doc comment. Only fetched when `enabled`
 * (the session itself is OAuth-managed): `delete_device`'s password-only UIA
 * retry already works fine for a plain password/SSO session, so there's no
 * reason to make this extra round trip there.
 */
export function useDeviceDeleteUrl(deviceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["deviceDeleteUrl", deviceId],
    queryFn: () => getDeviceDeleteUrl(deviceId),
    enabled,
  });
}

export function useDeviceActions() {
  const queryClient = useQueryClient();
  const invalidateDevices = () => queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
  const invalidateCrossSigning = () =>
    queryClient.invalidateQueries({ queryKey: CROSS_SIGNING_STATUS_QUERY_KEY });

  const revoke = useMutation({
    mutationFn: ({ deviceId, password }: { deviceId: string; password?: string }) =>
      deleteDevice(deviceId, password),
    onSuccess: invalidateDevices,
  });
  const verify = useMutation({
    mutationFn: (deviceId: string) => requestDeviceVerification(deviceId),
    // Watch this specific flow to its terminal state so the trust badge
    // updates as soon as the SAS exchange finishes, without touching
    // `VerificationOverlay` (which drives the actual emoji-comparison UI).
    onSuccess: async (flowId) => {
      const unlisten = await onSasUpdate(flowId, (update) => {
        if (update.state !== "done" && update.state !== "cancelled") return;
        if (update.state === "done") {
          invalidateDevices();
          invalidateCrossSigning();
        }
        unlisten();
      });
    },
  });

  return { revoke, verify, invalidateDevices, invalidateCrossSigning };
}
