import { InputRule, PasteRule } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

/** Keep the maintained rules, but evaluate rollout permission at input time. */
export function guardedStarterKit(enabled: () => boolean) {
  return StarterKit.extend({
    addExtensions() {
      return (this.parent?.() ?? []).map((extension) => {
        if (!["strike", "codeBlock"].includes(extension.name)) return extension;
        const guarded = extension.extend({
          addKeyboardShortcuts() {
            return Object.fromEntries(
              Object.entries(this.parent?.() ?? {}).map(([key, command]) => [
                key,
                (props: Parameters<typeof command>[0]) => enabled() && command(props),
              ]),
            );
          },
          addInputRules() {
            return (this.parent?.() ?? []).map(
              (rule) =>
                new InputRule({
                  find: rule.find,
                  undoable: rule.undoable,
                  handler: (props) => (enabled() ? rule.handler(props) : null),
                }),
            );
          },
          addPasteRules() {
            return (this.parent?.() ?? []).map(
              (rule) =>
                new PasteRule({
                  find: rule.find,
                  handler: (props) => (enabled() ? rule.handler(props) : null),
                }),
            );
          },
        });
        // A disabled formatting feature must not keep expanding an existing
        // marked range when text is inserted at its boundary. Stored-mark
        // cleanup handles keyboard input; a non-inclusive mark also covers
        // paste transactions, which do not inherit storedMarks. Keep this in
        // a second extension layer so it does not narrow the guarded methods'
        // TipTap `this.parent` type to the mark-only config.
        return extension.name === "strike" ? guarded.extend({ inclusive: false }) : guarded;
      });
    },
  });
}
