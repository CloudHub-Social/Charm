import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAccountDeactivateUrl,
  getProfile,
  removeAvatar,
  setAvatar,
  setDisplayName,
} from "@/lib/matrix";
export { useResolvedAvatarSrc } from "@/features/profile/useResolvedAvatarSrc";

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

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });

  const updateDisplayName = useMutation({
    mutationFn: (displayName: string | null) => setDisplayName(displayName),
    onSuccess: invalidate,
  });
  const updateAvatar = useMutation({
    mutationFn: (filePath: string | File) => setAvatar(filePath),
    onSuccess: invalidate,
  });
  const clearAvatar = useMutation({
    mutationFn: () => removeAvatar(),
    onSuccess: invalidate,
  });

  return { updateDisplayName, updateAvatar, clearAvatar };
}
