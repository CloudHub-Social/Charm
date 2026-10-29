import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

/** One account/room owns a composer. Acquire before async preflight or draft clearing. */
export function useComposerSendGate(scope: string, mutationsBlocked: RefObject<boolean>) {
  const [, refresh] = useState(0);
  const owner = useMemo(() => ({ active: true, voice: false, external: false }), [scope]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const gate = useMemo(() => {
    const current = () => owner.active && currentOwner.current === owner;
    const notify = () => {
      if (current()) refresh((value) => value + 1);
    };
    const canSubmit = () =>
      current() && !mutationsBlocked.current && !owner.voice && !owner.external;
    const canSendVoice = () => current() && !mutationsBlocked.current && !owner.external;
    return {
      canSubmit,
      canSendVoice,
      isCurrent: current,
      startExternal() {
        if (!canSubmit()) return null;
        owner.external = true;
        notify();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          owner.external = false;
          notify();
        };
      },
      startVoice() {
        if (!canSendVoice() || owner.voice) return false;
        owner.voice = true;
        notify();
        return true;
      },
      updateVoice(busy: boolean) {
        if (!current()) return;
        owner.voice = busy;
        notify();
      },
    };
  }, [owner, mutationsBlocked]);
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  return { ...gate, voiceBusy: owner.voice, externalBusy: owner.external };
}
