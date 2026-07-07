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
        const [rooms, localFlag] = await Promise.all([
          listRooms(),
          // A failed read here must bias toward `done`, same as the outer
          // catch below — coercing it to `false` would instead bias toward
          // `pending` (re-showing onboarding) on a transient filesystem
          // error, exactly backwards from Spec 12's fail-safe intent.
          getLocalOnboardingFlag().catch(() => true),
        ]);
        if (cancelled) return;

        if (rooms.length > 0) {
          setStatus("done");
          // Opportunistic write so a later launch (e.g. after this account's
          // rooms are later left) short-circuits on the flag alone, without
          // re-deriving from room count — but skip it when the local flag is
          // already set, so a returning user's every launch doesn't perform
          // a redundant account-data PUT to the homeserver. Guarded the same
          // way as `complete()`: this fire-and-forget write's IPC calls
          // resolve against whichever account is *currently* signed in, so
          // without the `userId` check a fast logout-then-login-as-someone-
          // else could land this account's onboarding flags on the new one.
          if (!localFlag) {
            void writeCompletionFlags(() => activeUserIdRef.current === userId);
          }
          return;
        }

        if (localFlag) {
          setStatus("done");
          return;
        }

        const accountData = await getAccountData(ONBOARDING_ACCOUNT_DATA_TYPE).catch(
          // Same fail-safe bias as the local-flag read above: a failed
          // account-data fetch is treated as "present" (any non-null value
          // works — `deriveOnboardingStatus` only checks for `null`).
          () => true,
        );
        if (cancelled) return;

        const accountDataPresent = accountData !== null;
        if (accountDataPresent && activeUserIdRef.current === userId) {
          // Backfill the local flag: `list_rooms` and the local flag are
          // both local-store reads, but this check needed the homeserver —
          // without this, a later offline/slow launch on this same device
          // (where the account-data round trip can't complete) would have
          // nothing local to short-circuit on and would re-show onboarding
          // despite it already being done on another device. Guarded against
          // an account switch during the `getAccountData` await, same
          // rationale as the opportunistic write above.
          void setLocalOnboardingFlag();
        }

        setStatus(
          deriveOnboardingStatus({
            roomCount: rooms.length,
            localFlag,
            accountDataPresent,
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
    await writeCompletionFlags(() => activeUserIdRef.current === userId);
    if (activeUserIdRef.current !== userId) return;
    setStatus("done");
  }, [userId]);

  return { status, complete };
}

/**
 * Writes both persistence layers per Spec 12's acceptance criterion 9 — but
 * only *waits* on the local flag, a fast local file write. The account-data
 * write is a homeserver round trip that can be slow or fail outright while
 * offline; firing it in the background rather than awaiting it means
 * `complete()`'s caller (`OnboardingScreen`'s skip/finish handlers) isn't
 * stranded on the onboarding surface for as long as that request takes. A
 * background failure is still fine: the local flag alone already satisfies
 * "don't re-onboard this device," and if this device also has this account
 * signed in elsewhere, the flag re-derives from account data anyway.
 *
 * `isStillActive` is re-checked right before the (fast, but still async)
 * local write — every call site passes a closure over its own
 * `activeUserIdRef`/`userId` pair so a since-switched-away account's stale
 * completion can never land on whichever account is now signed in (the
 * underlying IPC commands resolve against the *currently* active client,
 * not whichever account's JS closure happened to call them).
 */
async function writeCompletionFlags(isStillActive: () => boolean): Promise<void> {
  if (!isStillActive()) return;
  const content: OnboardingAccountData = { completed_at: Date.now(), version: 1 };
  setAccountData(ONBOARDING_ACCOUNT_DATA_TYPE, content).catch((err: unknown) => {
    console.error("useOnboardingGate: failed to write the onboarding account-data flag", err);
  });
  if (!isStillActive()) return;
  await setLocalOnboardingFlag().catch((err: unknown) => {
    console.error("useOnboardingGate: failed to write the local onboarding flag", err);
  });
}
