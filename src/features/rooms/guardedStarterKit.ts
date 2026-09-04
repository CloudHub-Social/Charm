import { InputRule, PasteRule } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

/** Keep the maintained rules, but evaluate rollout permission at input time. */
export function guardedStarterKit(enabled: () => boolean) {
  return StarterKit.extend({
    addExtensions() {
      return (this.parent?.() ?? []).map((extension) => {
        if (!["strike", "codeBlock"].includes(extension.name)) return extension;
        return extension.extend({
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
      });
    },
  });
}
