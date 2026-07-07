import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAccountData,
  getLocalOnboardingFlag,
  listRooms,
  setAccountData,
  setLocalOnboardingFlag,
} from "@/lib/matrix";
import { ONBOARDING_ACCOUNT_DATA_TYPE, type OnboardingAccountData } from "./onboardingAccountData";

export type OnboardingStatus = "loading" | "pending" | "done";

/**
 * Pure precedence rule from Spec 12: `done` if the account has any joined
 * room, or either persistence layer already recorded completion — `pending`
 * only when all three say "new". Biased fail-safe toward *not* re-showing
 * onboarding to someone who already dismissed it, at the cost of a rare
 * false "done" (see the module doc / Spec 12's R1).
 */
export function deriveOnboardingStatus(input: {
  roomCount: number;
  localFlag: boolean;
  accountDataPresent: boolean;
}): Exclude<OnboardingStatus, "loading"> {
  if (input.roomCount > 0 || input.localFlag || input.accountDataPresent) {
    return "done";
  }
  return "pending";
}

/**
 * Gates `App.tsx`'s onboarding branch (see its module doc comment). Computes
 * `status` once per signed-in session from room count + the two persisted
 * "already onboarded" flags, and exposes `complete()` for `OnboardingScreen`
 * to call on skip/finish — which writes both flags and flips the atom to
 * `"done"` so `App` re-renders into `RoomsScreen` without a page reload.
 */
export function useOnboardingGate(userId: string | null) {
  const [status, setStatus] = useState<OnboardingStatus>("loading");
  // The single source of truth for "which signed-in account is this hook
  // instance currently evaluating" — read by `complete` (below) so a write
  // triggered for one account can't land against a *different* one if the
  // user logs out and back in again while that write is still in flight
  // (`complete` is memoized on `userId`, but its promise chain, once
  // started, keeps running after this component re-renders for a new
  // account; only checking this ref, not the closed-over `userId`, catches
  // that).
  const activeUserIdRef = useRef(userId);

  useEffect(() => {
    activeUserIdRef.current = userId;

    if (!userId) {
      setStatus("loading");
      return undefined;
    }

    let cancelled = false;

    async function evaluate() {
      setStatus("loading");
      try {
        const rooms = await listRooms();
        if (rooms.length > 0) {
          if (!cancelled) setStatus("done");
          // Opportunistic write so a later launch (e.g. after this account's
          // rooms are later left) short-circuits on the flag alone, without
          // re-deriving from room count.
          void writeCompletionFlags();
          return;
        }

        const [localFlag, accountData] = await Promise.all([
          getLocalOnboardingFlag().catch(() => false),
          getAccountData(ONBOARDING_ACCOUNT_DATA_TYPE).catch(() => null),
        ]);

        if (cancelled) return;
        setStatus(
          deriveOnboardingStatus({
            roomCount: rooms.length,
            localFlag,
            accountDataPresent: accountData !== null,
          }),
        );
      } catch (err) {
        // A hard failure to even list rooms (offline first launch, etc.)
        // must not hard-block a real user behind a permanent "loading" —
        // and per the fail-safe bias above, defaulting to "done" is the
        // safer wrong answer for a returning user than showing the
        // orientation screen again ever could be for a new one.
        console.error("useOnboardingGate: failed to evaluate onboarding status", err);
        if (!cancelled) setStatus("done");
      }
    }

    evaluate();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-evaluate only when the signed-in account changes, not on every render
  }, [userId]);

  const complete = useCallback(async () => {
    if (activeUserIdRef.current !== userId) return;
    await writeCompletionFlags();
    if (activeUserIdRef.current !== userId) return;
    setStatus("done");
  }, [userId]);

  return { status, complete };
}

/**
 * Writes both persistence layers per Spec 12's acceptance criterion 9: the
 * local flag is written even if the account-data write fails (network,
 * homeserver rejecting it, etc.) so the app never re-onboards this device on
 * next launch regardless.
 */
async function writeCompletionFlags(): Promise<void> {
  const content: OnboardingAccountData = { completed_at: Date.now(), version: 1 };
  await Promise.allSettled([
    setAccountData(ONBOARDING_ACCOUNT_DATA_TYPE, content),
    setLocalOnboardingFlag(),
  ]);
}
