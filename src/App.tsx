import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LoginScreen } from "@/features/auth/LoginScreen";
import { OnboardingScreen } from "@/features/onboarding/OnboardingScreen";
import { useOnboardingGate } from "@/features/onboarding/useOnboardingGate";
import { RoomsScreen } from "@/features/rooms/RoomsScreen";
import { VerificationOverlay } from "@/features/verification/VerificationOverlay";
import { clearSettingsHash } from "@/features/settings/settingsAtoms";
import { watchDeepLinks } from "@/lib/deepLink";
import { onSessionInvalidated, tryRestoreSession, type LoginResponse } from "@/lib/matrix";
import { queryClient } from "@/providers";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { resetPrivacySettingsWriteQueue } from "@/features/settings/usePrivacySettings";
import { clearQuickSwitcherRecents } from "@/features/rooms/quickSwitcherRecents";
import { resetRoomSendQueueBarrier } from "@/features/rooms/useRoomSendQueueBarrier";
import { useApnsRefresh } from "@/features/push/useApnsRefresh";

interface AppProps {
  /** Resets any client state `App` itself doesn't own — e.g. `main.tsx`'s Jotai store, so account-scoped atoms (settings-open, per-room reply/edit drafts) don't survive into the next signed-in account. */
  onLoggedOut?: () => void;
  /** Initial value for the crash-recovery prompt's open state, owned here (not `RoomsScreen`) so a dismissal survives a logout/login cycle within the same process — see `RoomsScreen`'s `crashRecoveryPromptOpen` prop doc comment. */
  showCrashRecoveryPrompt?: boolean;
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
function App({ onLoggedOut, showCrashRecoveryPrompt = false }: AppProps) {
  const [session, setSession] = useState<LoginResponse | null>(null);
  useApnsRefresh(session?.user_id, session?.device_id);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [deepLinkRoomId, setDeepLinkRoomId] = useState<string | null>(null);
  const [crashRecoveryPromptOpen, setCrashRecoveryPromptOpen] = useState(showCrashRecoveryPrompt);
  const onboarding = useOnboardingGate(session?.user_id ?? null);
  const onLoggedOutRef = useRef(onLoggedOut);
  const sessionRef = useRef(session);
  onLoggedOutRef.current = onLoggedOut;
  sessionRef.current = session;

  const handleSignedIn = useCallback((nextSession: LoginResponse) => {
    sessionRef.current = nextSession;
    setSession(nextSession);
  }, []);

  const handleLoggedOut = useCallback(() => {
    if (sessionRef.current) clearQuickSwitcherRecents(sessionRef.current.user_id);
    sessionRef.current = null;
    queryClient.clear();
    resetPrivacySettingsWriteQueue();
    resetRoomSendQueueBarrier();
    clearSettingsHash();
    onLoggedOutRef.current?.();
    setSession(null);
  }, []);

  useEffect(() => {
    let active = true;
    let invalidated = false;
    let stopListening: (() => void) | undefined;

    setRestoring(true);
    setRestoreError(null);
    onSessionInvalidated(() => {
      invalidated = true;
      if (active) handleLoggedOut();
    })
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return null;
        }
        stopListening = unlisten;
        return tryRestoreSession();
      })
      .then((restoredSession) => {
        if (active && !invalidated) {
          sessionRef.current = restoredSession;
          setSession(restoredSession);
        }
      })
      .catch((cause) => {
        if (active && !invalidated) setRestoreError(String(cause));
      })
      .finally(() => {
        if (active) setRestoring(false);
      });

    return () => {
      active = false;
      stopListening?.();
    };
  }, [handleLoggedOut, restoreAttempt]);

  useEffect(() => {
    // Held here (above the login gate) so a deep link received before sign-in
    // completes is applied once RoomsScreen mounts, not dropped.
    const unlisten = watchDeepLinks(setDeepLinkRoomId);
    return () => {
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, []);

  if (restoring) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background" />;
  }

  if (restoreError) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-background p-6">
        <div className="max-w-sm space-y-4 text-center">
          <h1 className="text-lg font-semibold">Couldn’t restore your session</h1>
          <p className="text-sm text-muted-foreground">
            Charm couldn’t safely finish startup. Your saved local data has not been removed.
          </p>
          <Button onClick={() => setRestoreAttempt((attempt) => attempt + 1)}>Try again</Button>
        </div>
      </main>
    );
  }

  if (!session) {
    return <LoginScreen onSignedIn={handleSignedIn} />;
  }

  if (onboarding.status === "loading") {
    // Blank rather than `RoomsScreen`: showing rooms here would fire
    // `listRooms()`/mount its listeners only to immediately unmount once the
    // gate resolves to "pending" — a flicker plus wasted IPC calls on every
    // login, not just new accounts.
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background" />;
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
      crashRecoveryPromptOpen={crashRecoveryPromptOpen}
      onDismissCrashRecoveryPrompt={() => setCrashRecoveryPromptOpen(false)}
      onLoggedOut={() => {
        // A native invalidation may replace this session before the initiating
        // settings command settles. Its old callback must not reset a new login.
        if (sessionRef.current === session) handleLoggedOut();
      }}
    />
  );
}

export default App;
