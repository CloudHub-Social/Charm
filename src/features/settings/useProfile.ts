import { convertFileSrc } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAccountDeactivateUrl,
  getProfile,
  removeAvatar,
  resolveAvatar,
  setAvatar,
  setDisplayName,
} from "@/lib/matrix";

const PROFILE_QUERY_KEY = ["profile"] as const;

export function useProfile() {
  return useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: getProfile,
  });
}

/** `null` when there's no OIDC account-management URL to offer — see the Rust command's doc comment. */
export function useAccountDeactivateUrl() {
  return useQuery({
    queryKey: ["accountDeactivateUrl"],
    queryFn: getAccountDeactivateUrl,
  });
}

/**
 * Resolves a profile's `avatar_url` (a bare `mxc://` URI) to a
 * webview-loadable source, same pattern as `rooms/media/useMediaSource`.
 * `undefined` while resolving or when there's no avatar to resolve.
 */
export function useResolvedAvatarSrc(mxcUrl: string | null | undefined) {
  const { data } = useQuery({
    queryKey: ["avatar", mxcUrl],
    queryFn: async () => {
      if (!mxcUrl) return null;
      const path = await resolveAvatar(mxcUrl);
      return path ? convertFileSrc(path) : null;
    },
    enabled: Boolean(mxcUrl),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
  return data ?? undefined;
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });

  const updateDisplayName = useMutation({
    mutationFn: (displayName: string | null) => setDisplayName(displayName),
    onSuccess: invalidate,
  });
  const updateAvatar = useMutation({
    mutationFn: (filePath: string) => setAvatar(filePath),
    onSuccess: invalidate,
  });
  const clearAvatar = useMutation({
    mutationFn: () => removeAvatar(),
    onSuccess: invalidate,
  });

  return { updateDisplayName, updateAvatar, clearAvatar };
}
