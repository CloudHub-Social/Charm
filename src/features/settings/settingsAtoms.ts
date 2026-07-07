import { atom } from "jotai";

export type SettingsSection = "account" | "notifications" | "devices" | "appearance" | "general";

/** `null` when the settings shell is closed. Set by the app-chrome entry point; cleared by `SettingsScreen`'s close control. */
export const settingsOpenAtom = atom<SettingsSection | null>(null);
