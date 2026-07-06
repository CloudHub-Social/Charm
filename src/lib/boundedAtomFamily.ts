import { atomFamily } from "jotai/utils";
import type { Atom } from "jotai";

// `jotai/utils` re-exports the `atomFamily` value but not its `AtomFamily`
// type, so this mirrors the shape rather than reaching into jotai's
// internal `jotai/vanilla/utils/atomFamily` module path.
interface AtomFamily<Param, AtomType> {
  (param: Param): AtomType;
  getParams(): Iterable<Param>;
  remove(param: Param): void;
  setShouldRemove(shouldRemove: ((createdAt: number, param: Param) => boolean) | null): void;
  unstable_listen(
    callback: (event: { type: "CREATE" | "REMOVE"; param: Param; atom: AtomType }) => void,
  ): () => void;
}

/**
 * Wraps jotai's `atomFamily` so the number of distinct keys it tracks is
 * capped at `maxSize`, evicting the oldest-created entry once a new key
 * would exceed it. Without this, an atomFamily keyed by something that grows
 * over a session (every user id seen, every room visited) adds one entry per
 * key and never releases any of them — a real, if slow, memory leak in a
 * long-running desktop session.
 *
 * This isn't a true LRU: eviction order is *creation* order (oldest key
 * first), not last-access order — `atomFamily` has no public way to bump a
 * key's position without destroying and recreating its atom, which would
 * also throw away its current value. A generous `maxSize` makes this an
 * acceptable tradeoff: it turns "unbounded" into "bounded", even though an
 * actively-used-but-old entry could in principle be evicted before a
 * long-idle one.
 */
export function boundedAtomFamily<Param, AtomType extends Atom<unknown>>(
  initializeAtom: (param: Param) => AtomType,
  maxSize: number,
  areEqual?: (a: Param, b: Param) => boolean,
): AtomFamily<Param, AtomType> {
  const family = atomFamily(initializeAtom, areEqual);
  const isSameParam = areEqual ?? ((a: Param, b: Param) => a === b);

  const bounded = ((param: Param) => {
    const result = family(param);

    // `getParams()` is backed by a `Map`, which iterates in insertion order —
    // the earliest-yielded keys are the oldest-created ones.
    const params = Array.from(family.getParams());
    const excess = params.length - maxSize;
    if (excess > 0) {
      for (const staleParam of params.slice(0, excess)) {
        // Never evict the key that was just requested, even if it was
        // somehow already the oldest (e.g. `maxSize` is 0).
        if (!isSameParam(staleParam, param)) {
          family.remove(staleParam);
        }
      }
    }

    return result;
  }) as AtomFamily<Param, AtomType>;

  bounded.getParams = () => family.getParams();
  bounded.remove = (param) => family.remove(param);
  bounded.setShouldRemove = (shouldRemove) => family.setShouldRemove(shouldRemove);
  bounded.unstable_listen = (callback) => family.unstable_listen(callback);

  return bounded;
}
