import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/providers";
import { getOwnProfile, onSelfProfileUpdate } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { useFlag } from "@/featureFlags";

const OWN_PROFILE_QUERY_KEY = ["own-profile"] as const;

/**
 * The signed-in user's own profile (display name, avatar, presence) — backs
 * the room-list header chip. Invalidated on `profile:self`, pushed when an
 * out-of-band edit (e.g. from another client) changes the signed-in user's
 * display name/avatar; see `profiles.rs`'s module doc comment for why that's
 * the only signal available (Matrix has no dedicated account-wide
 * "your profile changed" sync event).
 */
export function useOwnProfile() {
  const avatarPresenceVisualsEnabled = useFlag("avatar_presence_visuals");
  useEffect(() => {
    const unlisten = onSelfProfileUpdate(() => {
      queryClient.invalidateQueries({ queryKey: OWN_PROFILE_QUERY_KEY });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, []);

  return useQuery({
    queryKey: [...OWN_PROFILE_QUERY_KEY, avatarPresenceVisualsEnabled],
    queryFn: () => getOwnProfile(avatarPresenceVisualsEnabled),
  });
}
