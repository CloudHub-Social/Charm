import { useState } from "react";
import packageJson from "../../../package.json";
import { formatBuildIdForDisplay, getBuildId, getBuildSourceRef } from "@/lib/buildId";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const REPO_URL = "https://github.com/CloudHub-Social/Charm";

/**
 * Copyable build identifier (Spec 24). Displays a friendlier rendering of
 * the canonical id — e.g. `0.4.2 (sha-a1b2c3d)`, `0.4.2-pr187 (sha-a1b2c3d)`,
 * `0.4.2-nightly (sha-a1b2c3d)`, or `0.4.2-dev` for a local build with no
 * CI-supplied id — but copies the raw canonical id (`buildId`), since that's
 * the exact string a reporter needs to paste into an issue/feedback form.
 */
function BuildIdControl({ buildId }: { buildId: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(buildId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, unsupported context) —
      // this is a convenience affordance, not worth surfacing an error for.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded text-sm text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
      aria-label={`Copy build identifier ${buildId}`}
    >
      {copied ? "Copied" : formatBuildIdForDisplay(buildId)}
    </button>
  );
}

/** Static app metadata — version, build id, source, and revision-pinned legal links. No telemetry/update-check UI (out of scope for Spec 18's IA rework). */
export function AboutPanel() {
  const buildId = getBuildId();
  const sourceRef = getBuildSourceRef(buildId);
  const licenseUrl = `${REPO_URL}/blob/${sourceRef}/LICENSE`;
  const thirdPartyNoticesUrl = `${REPO_URL}/blob/${sourceRef}/THIRD_PARTY_NOTICES.md`;

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">About</h1>
      <SettingsCard>
        <SettingTile
          title="Version"
          control={<span className="text-sm text-muted-foreground">{packageJson.version}</span>}
        />
        <SettingTile title="Build" control={<BuildIdControl buildId={buildId} />} />
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
        <SettingTile
          title="License"
          control={
            <a
              href={licenseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-foreground underline"
            >
              Apache-2.0
            </a>
          }
        />
        <SettingTile
          title="Third-party"
          control={
            <a
              href={thirdPartyNoticesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-foreground underline"
            >
              Notices
            </a>
          }
        />
      </SettingsCard>
    </div>
  );
}
