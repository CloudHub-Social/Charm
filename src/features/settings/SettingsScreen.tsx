import { useAtom } from "jotai";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccountPanel } from "./AccountPanel";
import { AppearancePanel } from "./AppearancePanel";
import { DevicesPanel } from "./DevicesPanel";
import { GeneralPanel } from "./GeneralPanel";
import { NotificationsPanel } from "./NotificationsPanel";
import { settingsOpenAtom, type SettingsSection } from "./settingsAtoms";

interface SettingsScreenProps {
  onLoggedOut: () => void;
}

const SECTIONS: { value: SettingsSection; label: string }[] = [
  { value: "account", label: "Account" },
  { value: "general", label: "General" },
  { value: "notifications", label: "Notifications" },
  { value: "devices", label: "Devices" },
  { value: "appearance", label: "Appearance" },
];

/** Full-screen overlay opened from the app-chrome entry point; renders over `RoomsScreen`, not routed. */
export function SettingsScreen({ onLoggedOut }: SettingsScreenProps) {
  const [section, setSection] = useAtom(settingsOpenAtom);

  if (!section) return null;

  return (
    <div className="fixed inset-0 z-40 flex bg-background">
      <Tabs
        orientation="vertical"
        value={section}
        onValueChange={(value) => setSection(value as SettingsSection)}
        className="flex w-full"
      >
        <div className="flex w-60 shrink-0 flex-col border-r border-border p-4">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-base font-bold text-foreground">Settings</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close settings"
              onClick={() => setSection(null)}
            >
              <XIcon />
            </Button>
          </div>
          <TabsList
            variant="line"
            className="h-auto flex-col items-stretch gap-1 bg-transparent p-0"
          >
            {SECTIONS.map((s) => (
              <TabsTrigger key={s.value} value={s.value} className="justify-start">
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <TabsContent value="account">
            <AccountPanel onLoggedOut={onLoggedOut} />
          </TabsContent>
          <TabsContent value="general">
            <GeneralPanel />
          </TabsContent>
          <TabsContent value="notifications">
            <NotificationsPanel />
          </TabsContent>
          <TabsContent value="devices">
            <DevicesPanel />
          </TabsContent>
          <TabsContent value="appearance">
            <AppearancePanel />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
