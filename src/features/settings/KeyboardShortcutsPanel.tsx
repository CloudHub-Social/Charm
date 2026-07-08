import { SettingsCard, SettingTile } from "./components/SettingsCard";

const COMPOSER_SHORTCUTS = [
  { keys: "Enter", description: "Send message" },
  { keys: "Shift + Enter", description: "Insert a newline" },
  { keys: "↑ / ↓", description: "Move through the @mention/emoji autocomplete menu" },
  { keys: "Escape", description: "Close the autocomplete menu, or cancel an edit/reply" },
];

const MEDIA_SHORTCUTS = [
  { keys: "← / →", description: "Previous/next image in the lightbox" },
  { keys: "Escape", description: "Close the lightbox" },
];

/** Documents shortcuts that already exist in `Composer`/`Lightbox` — this panel doesn't add new bindings, just surfaces them (Spec 18). */
export function KeyboardShortcutsPanel() {
  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">Keyboard Shortcuts</h1>
      <SettingsCard heading="Composer">
        {COMPOSER_SHORTCUTS.map((s) => (
          <SettingTile
            key={s.keys}
            title={s.description}
            control={
              <kbd className="rounded border border-border px-1.5 py-0.5 text-xs">{s.keys}</kbd>
            }
          />
        ))}
      </SettingsCard>
      <SettingsCard heading="Media viewer">
        {MEDIA_SHORTCUTS.map((s) => (
          <SettingTile
            key={s.keys}
            title={s.description}
            control={
              <kbd className="rounded border border-border px-1.5 py-0.5 text-xs">{s.keys}</kbd>
            }
          />
        ))}
      </SettingsCard>
    </div>
  );
}
