import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getPrivacySettings, setPrivacySettings, type PrivacySettings } from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";

const PRIVACY_SETTINGS_QUERY_KEY = ["privacySettings"] as const;

// Review fix: two privacy toggles in quick succession each send a *full*
// settings snapshot (see `useSetPrivacySettings`'s own doc comment for why
// that's the Rust command's shape) — the optimistic cache write makes the
// second snapshot include the first change, but that's only a client-side
// guarantee. Both IPC calls are still independently in flight, and if the
// older one's request reaches/acquires Rust's `PRIVACY_PREFS_LOCK` *after*
// the newer one, its stale full snapshot gets saved last, silently
// dropping whatever the newer toggle added. Serializing here — queuing
// each write behind the previous one's settlement, not just its start —
// means the second IPC call can never begin (and so can never finish)
// before the first one already has, so persisted writes land in the same
// order they were issued.
let privacySettingsWriteQueue: Promise<void> = Promise.resolve();
// Review fix: a queued write captures no notion of *which account* it was
// meant for — `setPrivacySettings` resolves the active account fresh, on
// the Rust side, whenever it actually runs. If the account logs out (and a
// different one logs in) while a write is still queued behind an earlier
// one, that queued write would otherwise execute against the new account,
// saving the old account's full settings snapshot (and forcing its
// `appear_offline` choice) onto it. Bumping this on logout makes every
// write enqueued before that point a no-op once its turn comes, instead of
// actually calling into Rust.
let privacySettingsWriteGeneration = 0;
// Review fix: with rapid successive toggles, an earlier mutation's
// `onSuccess`/`onError` can settle *after* a later mutation's `onMutate`
// has already put a newer full snapshot into the cache — without this,
// the earlier one would blindly overwrite that newer snapshot with its
// own (now-stale) settings, and a subsequent toggle reading the cache in
// `usePatchPrivacySettings` would then send yet another full snapshot
// that silently drops the still-in-flight newer change. Module-level (not
// a `useRef`) so it stays correct even if more than one component
// happened to call `useSetPrivacySettings`/`usePatchPrivacySettings` at
// once — matches `privacySettingsWriteGeneration`'s own scope. Also
// bumped by `resetPrivacySettingsWriteQueue` below, for the same logout
// scenario that function's own write-generation bump handles.
let latestPrivacyMutationId = 0;
// Review fix (P2): `onError`'s rollback used to restore whatever `onMutate`
// captured as `previous` — but with two toggles queued before either IPC
// write settles, the second mutation's `onMutate` runs *after* the first
// mutation's own optimistic cache write, so its `previous` is that
// still-unconfirmed first snapshot, not anything Rust has actually
// persisted. If both writes then fail, rolling back to that snapshot left
// the UI showing e.g. `hide_read_receipts: true` while Rust enforcement
// still read the old file on disk — a privacy setting that looked applied
// but wasn't. Tracks the last snapshot actually confirmed by a successful
// mutation (or the initial fetch) separately, so a rollback always lands on
// real persisted state, not a still-in-flight optimistic layer. Module-level
// for the same multi-caller-safety reason as the write queue/generation
// above.
let lastConfirmedPrivacySettings: PrivacySettings | undefined;
// Review fix (P2): `resetPrivacySettingsWriteQueue`'s write-generation check
// (used by the query's `queryFn` below) only guards against a *canceled*
// query resolving after a logout/account-switch. It doesn't help the
// narrower, same-account case this pair exists for: `onMutate` cancels an
// in-flight `getPrivacySettings()` refetch via `queryClient.cancelQueries`,
// but that only aborts React Query's own bookkeeping for it — the
// underlying Tauri invoke keeps running regardless, and its `queryFn` body
// (including the `lastConfirmedPrivacySettings` write below) executes to
// completion either way. If that stale refetch resolves *after* the
// mutation has already recorded its own newer, real Rust-confirmed write,
// it would move `lastConfirmedPrivacySettings` backward to the older
// persisted data, and a later failed toggle's `onError` rollback would then
// restore that stale snapshot. `nextConfirmationSeq`/`latestConfirmedSeq`
// give every fetch/mutation attempt (query or mutation) an ordinal at the
// moment it *starts*; a confirmation only wins if nothing that started
// later has already confirmed, which handles both this race and the
// original generation-based one (see `beginConfirmationAttempt`/
// `recordConfirmedIfNewest` below) — sequential mutations still both get to
// record (each starts *after* the previous one, since they're serialized by
// `privacySettingsWriteQueue`), but a stale operation that started earlier
// than whatever already confirmed never wins.
let nextConfirmationSeq = 0;
let latestConfirmedSeq = 0;

/** Reserves this fetch/mutation attempt's ordinal — call once, right when it starts. */
function beginConfirmationAttempt(): number {
  nextConfirmationSeq += 1;
  return nextConfirmationSeq;
}

/**
 * Records `settings` as the last-confirmed snapshot only if no attempt that
 * started *after* `seq` has already confirmed — see `nextConfirmationSeq`'s
 * own doc comment.
 */
function recordConfirmedIfNewest(seq: number, settings: PrivacySettings): void {
  if (seq < latestConfirmedSeq) return;
  latestConfirmedSeq = seq;
  lastConfirmedPrivacySettings = settings;
}

export function resetPrivacySettingsWriteQueue(): void {
  privacySettingsWriteGeneration += 1;
  privacySettingsWriteQueue = Promise.resolve();
  // Review fix: an account switch must not let the outgoing account's
  // confirmed snapshot leak into the incoming account's cache as an
  // `onError` rollback target before its own fetch has populated one.
  lastConfirmedPrivacySettings = undefined;
  // Bumps `latestConfirmedSeq` past every attempt started before this
  // point, so a stale in-flight fetch/mutation from the outgoing account
  // can never win `recordConfirmedIfNewest`'s check even if nothing else
  // confirms in the meantime.
  latestConfirmedSeq = beginConfirmationAttempt();
  // Review fix: bumping the write generation alone only stops the queued
  // write's *IPC call* — `serializedSetPrivacySettings` still resolves
  // successfully (just without calling into Rust), so the mutation's own
  // `onSuccess` still fires. Without also invalidating
  // `latestPrivacyMutationId` here, that `onSuccess` would still pass its
  // own "am I still the latest mutation" check and write the old account's
  // settings snapshot into the cache — right after `queryClient.clear()`
  // ran for the same logout, undoing it for whatever account signs in
  // next. Bumping this too makes every mutation issued before this reset a
  // no-op on both fronts: no IPC call, and no cache write either.
  latestPrivacyMutationId += 1;
}
function serializedSetPrivacySettings(settings: PrivacySettings): Promise<void> {
  const generation = privacySettingsWriteGeneration;
  const run = privacySettingsWriteQueue.then(() => {
    if (generation !== privacySettingsWriteGeneration) return undefined;
    return setPrivacySettings(settings);
  });
  // Swallowed here (not on `run`, which the caller still awaits/rejects
  // normally) purely so one failed write doesn't permanently wedge the
  // queue for every later call.
  privacySettingsWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Spec 40's privacy toggles: read receipts, typing indicators, appear-offline,
 * and auto-idle timeout.
 *
 * Review fix: the web companion build has no `invokeWeb` case for
 * `get_privacy_settings` (Tauri-only IPC, same reasoning as
 * Focus/General/Notifications) — this used to fire unconditionally
 * regardless of build target, throwing an `UnsupportedCommand` into the
 * console on the web build every time a caller (e.g. `RoomsScreen`'s
 * auto-idle wiring) rendered. `enabled` lets a caller add its own gate (e.g.
 * a feature flag) on top; the web-build check applies unconditionally
 * either way, since the command simply doesn't exist there.
 */
export function usePrivacySettings(enabled = true) {
  return useQuery({
    queryKey: PRIVACY_SETTINGS_QUERY_KEY,
    // Every successful fetch is real, server-confirmed state — keeps
    // `lastConfirmedPrivacySettings` current for `useSetPrivacySettings`'s
    // `onError` rollback, not just its own mutation successes.
    //
    // Review fix (P2): gated via `recordConfirmedIfNewest` — not recorded
    // unconditionally, and not just on the write generation. This fetch
    // might be canceled (`useSetPrivacySettings.onMutate`'s
    // `cancelQueries`) without its underlying Tauri invoke actually
    // aborting, or might simply be an outgoing account's request still in
    // flight across a logout — either way, if a *later-started* mutation
    // or fetch has already confirmed something newer by the time this one
    // resolves, this one must not move `lastConfirmedPrivacySettings`
    // backward. See `nextConfirmationSeq`'s own doc comment.
    queryFn: async () => {
      const seq = beginConfirmationAttempt();
      const settings = await getPrivacySettings();
      recordConfirmedIfNewest(seq, settings);
      return settings;
    },
    enabled: enabled && !isWebBuild(),
  });
}

/**
 * A single mutation that writes the *whole* settings object — mirrors the
 * Rust command shape (`set_privacy_settings` takes the full `PrivacySettings`
 * struct, not a per-field setter) so a caller always mutates off the latest
 * cached snapshot rather than racing partial updates against each other.
 */
export function useSetPrivacySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: PrivacySettings) => serializedSetPrivacySettings(settings),
    // Optimistic, synchronous cache write — see `usePatchPrivacySettings`'s
    // doc comment for why this matters for back-to-back toggles.
    onMutate: (settings) => {
      // Review fix: this used to only ever write the optimistic value and
      // never roll it back — if `set_privacy_settings` failed (IPC/disk/
      // client error), the cache (and this hook's own `useIdlePresence`
      // consumer, and the Privacy panel's toggles) kept showing the
      // unsaved value while Rust enforcement still read the old
      // persisted file, so a user could believe receipts/typing were
      // hidden while they were still being sent. Snapshot the previous
      // value here so `onError` can restore it.
      //
      // Deliberately synchronous (not `async`) — `usePatchPrivacySettings`'s
      // own doc comment depends on this write landing before the *next*
      // synchronous `fireEvent`/click in the same tick can read the cache,
      // for back-to-back toggles. `cancelQueries` below is fire-and-forget
      // (its own promise isn't awaited) rather than gating the write behind
      // it — `QueryClient.cancelQueries` calls each matching query's own
      // `.cancel()` synchronously before ever returning a promise (only the
      // *settlement* of those cancellations is async), so the abort signal
      // for an in-flight refetch is already sent by the time `setQueryData`
      // runs on the next line; awaiting it first would only add a
      // needless microtask delay, reopening the exact race this stays
      // synchronous to avoid.
      //
      // Review fix: without this, a refetch already in flight when this
      // mutation starts (e.g. from an earlier `invalidateQueries`, or a
      // window-focus refetch) could resolve *after* this optimistic write
      // and silently overwrite it with the older persisted snapshot —
      // exactly the same class of race `onSettled`'s own latest-mutation
      // guard handles for a refetch triggered *after* this mutation, just
      // for one already running *before* it.
      void queryClient.cancelQueries({ queryKey: PRIVACY_SETTINGS_QUERY_KEY });
      const previous = queryClient.getQueryData<PrivacySettings>(PRIVACY_SETTINGS_QUERY_KEY);
      queryClient.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, settings);
      const mutationId = ++latestPrivacyMutationId;
      // Captured so `onSuccess` can tell a real Rust-confirmed write apart
      // from `resetPrivacySettingsWriteQueue`'s cancellation — see that
      // review-fix comment on `onSuccess` below.
      const generation = privacySettingsWriteGeneration;
      // Reserves this mutation attempt's ordinal for `recordConfirmedIfNewest`
      // — see `nextConfirmationSeq`'s own doc comment.
      const confirmationSeq = beginConfirmationAttempt();
      return { previous, mutationId, generation, confirmationSeq };
    },
    onError: (_err, _settings, context) => {
      // Only the still-latest mutation gets to roll back — an older
      // mutation's failure settling after a newer one has already
      // optimistically written its own snapshot must not stomp on it.
      if (context?.mutationId !== latestPrivacyMutationId) return;
      // Review fix (P2): rolls back to the last *confirmed* snapshot, not
      // `context.previous` — see `lastConfirmedPrivacySettings`'s own doc
      // comment. Falls back to `context.previous` only if nothing has ever
      // been confirmed yet (e.g. the very first load also failed), so a
      // rollback still restores *something* rather than leaving the cache
      // with no data at all.
      const rollback = lastConfirmedPrivacySettings ?? context?.previous;
      if (rollback) {
        queryClient.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, rollback);
      }
    },
    onSuccess: (_, settings, context) => {
      // Review fix (P2): recorded *before* the latest-mutation guard below,
      // not after — an older mutation succeeding while a newer one is still
      // queued is a real, Rust-confirmed write regardless of whether it's
      // still "the latest" one. Gating this update on that check too meant
      // an older mutation's success never updated `lastConfirmedPrivacySettings`
      // at all: if the newer (queued-behind) mutation then failed, `onError`
      // rolled back to the pre-*first*-mutation snapshot instead of that
      // first mutation's already-persisted result, and a subsequent toggle
      // reading the stale rolled-back cache could resend a full settings
      // object that silently cleared what Rust had actually just saved.
      //
      // Review fix (P2): gated on `context.generation` still matching the
      // *current* write generation, though — `resetPrivacySettingsWriteQueue`
      // (called on logout/account-switch) makes `serializedSetPrivacySettings`
      // resolve successfully *without* ever calling into Rust, for any write
      // still queued behind the reset. React Query still treats that as a
      // successful mutation, so without this check a canceled old-account
      // write would get recorded as confirmed, and a later failed mutation
      // (for the *new* account) could then roll the UI back to settings that
      // were never actually persisted for either account.
      //
      // Review fix (P2): also routed through `recordConfirmedIfNewest`
      // (`context.confirmationSeq`) rather than an unconditional write — a
      // canceled query fetch that started *before* this mutation could still
      // resolve after it (its underlying Tauri invoke isn't actually
      // aborted just because `cancelQueries` marked it canceled) and would
      // otherwise move `lastConfirmedPrivacySettings` backward to stale
      // data. See `nextConfirmationSeq`'s own doc comment.
      if (context?.generation === privacySettingsWriteGeneration) {
        recordConfirmedIfNewest(context.confirmationSeq, settings);
      }
      if (context?.mutationId !== latestPrivacyMutationId) return;
      queryClient.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, settings);
    },
    // Review fix: reconciles with the server's actual persisted state
    // either way — a failed mutation's `onError` rollback restores the
    // last-known-good *client* snapshot, but this is what confirms it
    // still matches what Rust actually has on disk (e.g. if the IPC call
    // itself succeeded but this hook never got the response).
    //
    // Review fix: gated on the same "am I still the latest mutation" check
    // as `onError`/`onSuccess` above — writes are serialized
    // (`serializedSetPrivacySettings`), so with two toggles queued in quick
    // succession the *older* one's IPC call still settles first. Refetching
    // unconditionally here raced the newer mutation's own optimistic write:
    // the older mutation's `onSettled` could invalidate and refetch while
    // the newer write was still queued (not yet applied on the Rust side),
    // pulling back a first-only persisted snapshot that overwrote the
    // already-cached combined snapshot. A third toggle before the second
    // settled would then read that stale cache in
    // `usePatchPrivacySettings` and send a full snapshot that silently
    // dropped the second change. Only the latest mutation's settlement gets
    // to trigger a refetch — an older one settling after a newer optimistic
    // write now leaves that newer write alone, matching `onError`/
    // `onSuccess`.
    onSettled: (_data, _error, _settings, context) => {
      if (context?.mutationId !== latestPrivacyMutationId) return;
      void queryClient.invalidateQueries({ queryKey: PRIVACY_SETTINGS_QUERY_KEY });
    },
  });
}

/**
 * Merges `patch` onto the *freshest* cached settings and mutates — for a
 * caller (e.g. `PrivacyPanel`) that patches one field per toggle click.
 *
 * Review fix: a caller that instead closed over the `settings` object
 * returned by `usePrivacySettings()` and spread `{ ...settings, ...patch }`
 * itself was reading a value captured at the start of the current render.
 * If a user toggled two switches in quick succession — fast enough that the
 * first mutation's cache write hadn't triggered a re-render yet — the second
 * toggle's `settings` closure was still the *pre-first-toggle* snapshot,
 * so its `{ ...settings, ...patch }` silently discarded the first toggle's
 * change when it landed. Reading `queryClient.getQueryData` at call time
 * (rather than through React's render cycle) always sees the first
 * mutation's `onMutate` write, which runs synchronously before this
 * mutation's own network request is even issued.
 */
export function usePatchPrivacySettings() {
  const queryClient = useQueryClient();
  const setSettings = useSetPrivacySettings();
  return (patch: Partial<PrivacySettings>) => {
    const current = queryClient.getQueryData<PrivacySettings>(PRIVACY_SETTINGS_QUERY_KEY);
    if (!current) return;
    setSettings.mutate({ ...current, ...patch });
  };
}
