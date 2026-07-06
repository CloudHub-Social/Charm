import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  crossSigningStatus,
  deleteDevice,
  getCrossSigningResetUrl,
  listDevices,
  onSasUpdate,
  requestDeviceVerification,
} from "@/lib/matrix";

const DEVICES_QUERY_KEY = ["devices"] as const;
const CROSS_SIGNING_STATUS_QUERY_KEY = ["crossSigningStatus"] as const;
const CROSS_SIGNING_RESET_URL_QUERY_KEY = ["crossSigningResetUrl"] as const;

export function useDevices() {
  return useQuery({
    queryKey: DEVICES_QUERY_KEY,
    queryFn: listDevices,
  });
}

export function useCrossSigningStatus() {
  return useQuery({
    queryKey: CROSS_SIGNING_STATUS_QUERY_KEY,
    queryFn: crossSigningStatus,
  });
}

/** `null` when there's no OIDC account-management URL to offer a "Reset" link for. */
export function useCrossSigningResetUrl() {
  return useQuery({
    queryKey: CROSS_SIGNING_RESET_URL_QUERY_KEY,
    queryFn: getCrossSigningResetUrl,
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
