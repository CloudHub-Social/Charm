import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/providers";
import { getOwnProfile, onSelfProfileUpdate } from "@/lib/matrix";

const OWN_PROFILE_QUERY_KEY = ["own-profile"];

/**
 * The signed-in user's own profile (display name, avatar, presence) — backs
 * the room-list header chip. Invalidated on `profile:self`, pushed when an
 * out-of-band edit (e.g. from another client) changes the signed-in user's
 * display name/avatar; see `profiles.rs`'s module doc comment for why that's
 * the only signal available (Matrix has no dedicated account-wide
 * "your profile changed" sync event).
 */
export function useOwnProfile() {
  useEffect(() => {
    const unlisten = onSelfProfileUpdate(() => {
      queryClient.invalidateQueries({ queryKey: OWN_PROFILE_QUERY_KEY });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, []);

  return useQuery({
    queryKey: OWN_PROFILE_QUERY_KEY,
    queryFn: getOwnProfile,
  });
}
