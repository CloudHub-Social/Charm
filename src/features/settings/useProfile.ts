import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getProfile, removeAvatar, setAvatar, setDisplayName } from "@/lib/matrix";

const PROFILE_QUERY_KEY = ["profile"] as const;

export function useProfile() {
  return useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: getProfile,
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
    mutationFn: (filePath: string) => setAvatar(filePath),
    onSuccess: invalidate,
  });
  const clearAvatar = useMutation({
    mutationFn: () => removeAvatar(),
    onSuccess: invalidate,
  });

  return { updateDisplayName, updateAvatar, clearAvatar };
}
