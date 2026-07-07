import packageJson from "../../../package.json";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const REPO_URL = "https://github.com/CloudHub-Social/Charm";

/** Static app metadata — version and repo link. No telemetry/update-check UI (out of scope for Spec 18's IA rework). */
export function AboutPanel() {
  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">About</h1>
      <SettingsCard>
        <SettingTile
          title="Version"
          control={<span className="text-sm text-muted-foreground">{packageJson.version}</span>}
        />
        <SettingTile
          title="Source"
          control={
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-foreground underline"
            >
              GitHub
            </a>
          }
        />
      </SettingsCard>
    </div>
  );
}
