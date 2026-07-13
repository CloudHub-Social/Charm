import { isTauri } from "@/lib/platform";
import { BOOTSTRAP_TIMEOUT_MS } from "./instrument";

/**
 * Whether the previous run of the app didn't shut down cleanly (crash, OOM
 * kill, forced quit) — backed by a marker file the Rust side writes at
 * startup and removes on a clean `RunEvent::Exit` (see
 * `take_previous_session_crash_flag`/`had_unclean_previous_session` in
 * `src-tauri/src/lib.rs`).
 *
 * This is a coarse yes/no signal only, with no stack trace or event payload
 * attached — a real crash report for the *same* incident would require
 * Sentry to already have been initialized (and consent already granted)
 * before the crash happened, which by definition isn't guaranteed here. Its
 * purpose is narrower: let the app notice, after the fact, that something
 * went wrong last time and nudge the user toward turning on crash reporting
 * for next time — never to fabricate or silently transmit a report for the
 * crash that already happened.
 *
 * Always `false` outside Tauri (the web build has no native process to crash
 * independently of the browser tab).
 *
 * Bounded by {@link BOOTSTRAP_TIMEOUT_MS}, same reasoning as
 * `bootstrapSentryWithTimeout`: `main.tsx` awaits this alongside that call
 * before its first render, so a hung `had_unclean_previous_session` IPC
 * round-trip must not be able to block React from ever mounting the way a
 * hung settings read could before that timeout existed — see the 2026-07-13
 * blank-page-on-launch investigation this mirrors.
 */
export async function checkUncleanPreviousSession(
  timeoutMs: number = BOOTSTRAP_TIMEOUT_MS,
): Promise<boolean> {
  if (!isTauri()) return false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const check = invoke<boolean>("had_unclean_previous_session").catch(() => false);
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
