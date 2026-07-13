import { useEffect, useState } from "react";
import { LoginScreen } from "@/features/auth/LoginScreen";
import { OnboardingScreen } from "@/features/onboarding/OnboardingScreen";
import { useOnboardingGate } from "@/features/onboarding/useOnboardingGate";
import { RoomsScreen } from "@/features/rooms/RoomsScreen";
import { VerificationOverlay } from "@/features/verification/VerificationOverlay";
import { clearSettingsHash } from "@/features/settings/settingsAtoms";
import { watchDeepLinks } from "@/lib/deepLink";
import { tryRestoreSession, type LoginResponse } from "@/lib/matrix";
import { queryClient } from "@/providers";
import { logAndIgnore } from "@/lib/logAndIgnore";

interface AppProps {
  /** Resets any client state `App` itself doesn't own — e.g. `main.tsx`'s Jotai store, so account-scoped atoms (settings-open, per-room reply/edit drafts) don't survive into the next signed-in account. */
  onLoggedOut?: () => void;
}

/**
 * Branches `restoring -> !session -> onboarding-pending -> RoomsScreen`. The
 * onboarding branch (Spec 12) sits between session and rooms as its own
 * full-surface screen, not a modal inside `RoomsScreen` — so it renders
 * before the room-list machinery mounts, and so the deep-link hold below
 * (`deepLinkRoomId`) stays untouched: a link arriving mid-onboarding stays
 * held here and is only consumed by `RoomsScreen` once onboarding
 * completes.
 */
function App({ onLoggedOut }: AppProps) {
  const [session, setSession] = useState<LoginResponse | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [deepLinkRoomId, setDeepLinkRoomId] = useState<string | null>(null);
  const onboarding = useOnboardingGate(session?.user_id ?? null);

  useEffect(() => {
    tryRestoreSession()
      .then(setSession)
      .catch(logAndIgnore)
      .finally(() => setRestoring(false));
  }, []);

  useEffect(() => {
    // Held here (above the login gate) so a deep link received before sign-in
    // completes is applied once RoomsScreen mounts, not dropped.
    const unlisten = watchDeepLinks(setDeepLinkRoomId);
    return () => {
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, []);

  if (restoring) {
    return <div className="flex min-h-screen items-center justify-center bg-background" />;
  }

  if (!session) {
    return <LoginScreen onSignedIn={setSession} />;
  }

  if (onboarding.status === "loading") {
    // Blank rather than `RoomsScreen`: showing rooms here would fire
    // `listRooms()`/mount its listeners only to immediately unmount once the
    // gate resolves to "pending" — a flicker plus wasted IPC calls on every
    // login, not just new accounts.
    return <div className="flex min-h-screen items-center justify-center bg-background" />;
  }

  if (onboarding.status === "pending") {
    return (
      <>
        <OnboardingScreen onDone={onboarding.complete} />
        <VerificationOverlay />
      </>
    );
  }

  return (
    <RoomsScreen
      currentUserId={session.user_id}
      deepLinkRoomId={deepLinkRoomId}
      onDeepLinkConsumed={() => setDeepLinkRoomId(null)}
      onLoggedOut={() => {
        // Clears every account-scoped cache entry (profile, devices,
        // notification settings, room list, ...) so a subsequent sign-in as
        // a *different* account in the same app session never shows stale
        // data from this one before its own queries have refetched.
        queryClient.clear();
        // Logout/deactivate unmount SettingsScreen directly rather than via
        // closeSettings, so a lingering `#/settings/<section>` hash would
        // otherwise make the next sign-in's `useSettingsHashSync` reopen
        // settings straight away.
        clearSettingsHash();
        onLoggedOut?.();
        setSession(null);
      }}
    />
  );
}

export default App;
