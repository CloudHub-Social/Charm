import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getPrivacySettings, setPrivacySettings, type PrivacySettings } from "@/lib/matrix";

const PRIVACY_SETTINGS_QUERY_KEY = ["privacySettings"] as const;

/** Spec 40's privacy toggles: read receipts, typing indicators, appear-offline, and auto-idle timeout. */
export function usePrivacySettings() {
  return useQuery({
    queryKey: PRIVACY_SETTINGS_QUERY_KEY,
    queryFn: getPrivacySettings,
  });
}

/**
 * A single mutation that writes the *whole* settings object — mirrors the
 * Rust command shape (`set_privacy_settings` takes the full `PrivacySettings`
 * struct, not a per-field setter) so a caller always mutates off the latest
 * cached snapshot rather than racing partial updates against each other.
 */
export function useSetPrivacySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: PrivacySettings) => setPrivacySettings(settings),
    onSuccess: (_, settings) => {
      queryClient.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, settings);
    },
  });
}
