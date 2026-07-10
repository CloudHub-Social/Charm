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

export function useRecoveryStatus(enabled = true) {
  return useQuery({
    queryKey: RECOVERY_STATUS_QUERY_KEY,
    queryFn: recoveryStatus,
    enabled,
  });
}

export function useRecoverFromKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (recoveryKey: string) => recoverFromKey(recoveryKey),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RECOVERY_STATUS_QUERY_KEY }),
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
