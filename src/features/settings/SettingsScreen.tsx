import { lazy, Suspense } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdaptiveLayout } from "@/features/shell/useAdaptiveLayout";
import { AboutPanel } from "./AboutPanel";
import { AccountPanel } from "./AccountPanel";
import { AppearancePanel } from "./AppearancePanel";
import { DesktopPanel } from "./DesktopPanel";
import { GeneralPanel } from "./GeneralPanel";
import { KeyboardShortcutsPanel } from "./KeyboardShortcutsPanel";
import { ObservabilityPanel } from "./ObservabilityPanel";
import type { SettingsSection } from "./settingsAtoms";
import { useIsDesktopPlatform } from "./useIsDesktopPlatform";
import { useSettingsNavigation } from "./useSettingsNavigation";
import { isWebBuild } from "@/lib/platform";

const DevicesPanel = lazy(() =>
  import("./DevicesPanel").then((mod) => ({ default: mod.DevicesPanel })),
);
const NotificationsPanel = lazy(() =>
  import("./NotificationsPanel").then((mod) => ({ default: mod.NotificationsPanel })),
);

interface SettingsScreenProps {
  onLoggedOut: () => void;
}

const SECTIONS: {
  value: SettingsSection;
  label: string;
  desktopOnly?: boolean;
  webUnsupported?: boolean;
}[] = [
  { value: "account", label: "Account" },
  { value: "general", label: "General" },
  { value: "notifications", label: "Notifications", webUnsupported: true },
  { value: "devices", label: "Devices", webUnsupported: true },
  { value: "appearance", label: "Appearance" },
  { value: "observability", label: "Observability" },
  { value: "desktop", label: "Desktop", desktopOnly: true },
  { value: "about", label: "About" },
  { value: "keyboard-shortcuts", label: "Keyboard Shortcuts" },
];

function SettingsBody({
  section,
  onSectionChange,
  onLoggedOut,
  mobile,
}: {
  section: SettingsSection;
  onSectionChange: (value: SettingsSection) => void;
  onLoggedOut: () => void;
  mobile: boolean;
}) {
  const showDesktopSection = useIsDesktopPlatform();
  const webBuild = isWebBuild();
  const sections = SECTIONS.filter(
    (s) => (!s.desktopOnly || showDesktopSection) && (!s.webUnsupported || !webBuild),
  );

  // A `#/settings/desktop` deep link (or a stale one from switching from
  // desktop to mobile width, or Tauri to a plain browser, without closing
  // settings first) would otherwise select a section with no matching tab
  // or content — Radix then renders nothing at all, leaving settings open
  // on a blank panel. Falling back to the first available section, same as
  // if nothing had been selected yet, always shows something real.
  const effectiveSection = sections.some((s) => s.value === section) ? section : sections[0].value;

  return (
    <Tabs
      orientation={mobile ? "horizontal" : "vertical"}
      value={effectiveSection}
      onValueChange={(value) => onSectionChange(value as SettingsSection)}
      className={mobile ? "flex h-full w-full flex-col" : "flex h-full w-full"}
    >
      {mobile ? (
        <TabsList
          variant="line"
          className="h-auto w-full shrink-0 justify-start gap-1 overflow-x-auto border-b border-border bg-transparent p-2"
        >
          {sections.map((s) => (
            <TabsTrigger key={s.value} value={s.value} className="shrink-0">
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      ) : (
        <div className="flex w-60 shrink-0 flex-col border-r border-border p-4">
          <span className="mb-4 text-base font-bold text-foreground">Settings</span>
          <TabsList
            variant="line"
            className="h-auto flex-col items-stretch gap-1 bg-transparent p-0"
          >
            {sections.map((s) => (
              <TabsTrigger key={s.value} value={s.value} className="justify-start">
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <TabsContent value="account">
          <AccountPanel onLoggedOut={onLoggedOut} />
        </TabsContent>
        <TabsContent value="general">
          <GeneralPanel />
        </TabsContent>
        {!webBuild && (
          <>
            <TabsContent value="notifications">
              <Suspense fallback={null}>
                <NotificationsPanel />
              </Suspense>
            </TabsContent>
            <TabsContent value="devices">
              <Suspense fallback={null}>
                <DevicesPanel />
              </Suspense>
            </TabsContent>
          </>
        )}
        <TabsContent value="appearance">
          <AppearancePanel />
        </TabsContent>
        <TabsContent value="observability">
          <ObservabilityPanel />
        </TabsContent>
        {showDesktopSection && (
          <TabsContent value="desktop">
            <DesktopPanel />
          </TabsContent>
        )}
        <TabsContent value="about">
          <AboutPanel />
        </TabsContent>
        <TabsContent value="keyboard-shortcuts">
          <KeyboardShortcutsPanel />
        </TabsContent>
      </div>
    </Tabs>
  );
}

/**
 * Settings' shell: a stable, deep-linkable location (`#/settings/<section>`,
 * see `useSettingsNavigation`) rendered in one of two modes matching Charm
 * 1.0's dual-mode single component — desktop shows a centered modal over a
 * frozen background, mobile shows a full page with a horizontal-scrolling
 * top nav instead of the desktop's fixed-width sidebar rail (which would
 * otherwise squeeze panel content on a phone-width viewport). Not routed via
 * a router (Charm 2.0 has none; see Spec 18) — a hash sync stands in for
 * that.
 */
export function SettingsScreen({ onLoggedOut }: SettingsScreenProps) {
  const { section, openSettings, closeSettings } = useSettingsNavigation();
  const layout = useAdaptiveLayout();

  if (!section) return null;

  if (layout === "mobile") {
    return (
      <div className="fixed inset-0 z-40 flex flex-col bg-background">
        <div className="flex shrink-0 items-center justify-between border-b border-border p-4">
          <span className="text-base font-bold text-foreground">Settings</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close settings"
            onClick={closeSettings}
          >
            <XIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <SettingsBody
            section={section}
            onSectionChange={openSettings}
            onLoggedOut={onLoggedOut}
            mobile
          />
        </div>
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent
        className="flex h-[36rem] max-h-[85vh] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close settings"
          className="absolute top-4 right-4"
          onClick={closeSettings}
        >
          <XIcon />
        </Button>
        <SettingsBody
          section={section}
          onSectionChange={openSettings}
          onLoggedOut={onLoggedOut}
          mobile={false}
        />
      </DialogContent>
    </Dialog>
  );
}
