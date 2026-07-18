import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getPrivacySettings, setPrivacySettings, type PrivacySettings } from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";

const PRIVACY_SETTINGS_QUERY_KEY = ["privacySettings"] as const;

/**
 * Spec 40's privacy toggles: read receipts, typing indicators, appear-offline,
 * and auto-idle timeout.
 *
 * Review fix: the web companion build has no `invokeWeb` case for
 * `get_privacy_settings` (Tauri-only IPC, same reasoning as
 * Focus/General/Notifications) — this used to fire unconditionally
 * regardless of build target, throwing an `UnsupportedCommand` into the
 * console on the web build every time a caller (e.g. `RoomsScreen`'s
 * auto-idle wiring) rendered. `enabled` lets a caller add its own gate (e.g.
 * a feature flag) on top; the web-build check applies unconditionally
 * either way, since the command simply doesn't exist there.
 */
export function usePrivacySettings(enabled = true) {
  return useQuery({
    queryKey: PRIVACY_SETTINGS_QUERY_KEY,
    queryFn: getPrivacySettings,
    enabled: enabled && !isWebBuild(),
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
    // Optimistic, synchronous cache write — see `usePatchPrivacySettings`'s
    // doc comment for why this matters for back-to-back toggles.
    onMutate: (settings) => {
      // Review fix: this used to only ever write the optimistic value and
      // never roll it back — if `set_privacy_settings` failed (IPC/disk/
      // client error), the cache (and this hook's own `useIdlePresence`
      // consumer, and the Privacy panel's toggles) kept showing the
      // unsaved value while Rust enforcement still read the old
      // persisted file, so a user could believe receipts/typing were
      // hidden while they were still being sent. Snapshot the previous
      // value here so `onError` can restore it.
      //
      // Deliberately synchronous (not `async`, no awaited
      // `cancelQueries` before the write) — `usePatchPrivacySettings`'s own
      // doc comment depends on this write landing before the *next*
      // synchronous `fireEvent`/click in the same tick can read the cache,
      // for back-to-back toggles. An awaited `cancelQueries` first would
      // push this write a microtask later, reopening that exact race.
      const previous = queryClient.getQueryData<PrivacySettings>(PRIVACY_SETTINGS_QUERY_KEY);
      queryClient.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, settings);
      return { previous };
    },
    onError: (_err, _settings, context) => {
      if (context?.previous) {
        queryClient.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, context.previous);
      }
    },
    onSuccess: (_, settings) => {
      queryClient.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, settings);
    },
    // Review fix: reconciles with the server's actual persisted state
    // either way — a failed mutation's `onError` rollback restores the
    // last-known-good *client* snapshot, but this is what confirms it
    // still matches what Rust actually has on disk (e.g. if the IPC call
    // itself succeeded but this hook never got the response).
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PRIVACY_SETTINGS_QUERY_KEY });
    },
  });
}

/**
 * Merges `patch` onto the *freshest* cached settings and mutates — for a
 * caller (e.g. `PrivacyPanel`) that patches one field per toggle click.
 *
 * Review fix: a caller that instead closed over the `settings` object
 * returned by `usePrivacySettings()` and spread `{ ...settings, ...patch }`
 * itself was reading a value captured at the start of the current render.
 * If a user toggled two switches in quick succession — fast enough that the
 * first mutation's cache write hadn't triggered a re-render yet — the second
 * toggle's `settings` closure was still the *pre-first-toggle* snapshot,
 * so its `{ ...settings, ...patch }` silently discarded the first toggle's
 * change when it landed. Reading `queryClient.getQueryData` at call time
 * (rather than through React's render cycle) always sees the first
 * mutation's `onMutate` write, which runs synchronously before this
 * mutation's own network request is even issued.
 */
export function usePatchPrivacySettings() {
  const queryClient = useQueryClient();
  const setSettings = useSetPrivacySettings();
  return (patch: Partial<PrivacySettings>) => {
    const current = queryClient.getQueryData<PrivacySettings>(PRIVACY_SETTINGS_QUERY_KEY);
    if (!current) return;
    setSettings.mutate({ ...current, ...patch });
  };
}
