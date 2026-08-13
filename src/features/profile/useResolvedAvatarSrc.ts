import { useQuery } from "@tanstack/react-query";
import { resolveAvatar } from "@/lib/matrix";
import { toLoadableMediaUrl } from "@/lib/mediaUrl";

/** Resolve a bare Matrix `mxc://` profile/avatar URI for either Tauri or web. */
export function useResolvedAvatarSrc(mxcUrl: string | null | undefined) {
  const { data } = useQuery({
    queryKey: ["avatar", mxcUrl],
    queryFn: async () => {
      if (!mxcUrl) return null;
      const path = await resolveAvatar(mxcUrl);
      return path ? (toLoadableMediaUrl(path) ?? null) : null;
    },
    enabled: Boolean(mxcUrl),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
  return data ?? undefined;
}
