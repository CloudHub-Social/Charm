import { useQuery } from "@tanstack/react-query";
import { get3pids } from "@/lib/matrix";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const MEDIUM_LABELS: Record<string, string> = {
  email: "Email",
  msisdn: "Phone",
};

/**
 * Read-only display of the account's confirmed email/phone 3PIDs (Spec 18)
 * — adding/removing a contact method goes through the homeserver's
 * verification-token flow, which is Day-2 (see Spec 18's non-goals; only
 * display is in scope here).
 */
export function ContactInformationCard() {
  const {
    data: threepids,
    isError,
    error,
  } = useQuery({
    queryKey: ["settings", "3pids"],
    queryFn: get3pids,
  });

  if (!isError && threepids && threepids.length === 0) return null;

  return (
    <SettingsCard heading="Contact Information">
      {isError ? (
        <SettingTile
          title={<span className="text-destructive">Couldn't load contact information</span>}
          description={String(error)}
        />
      ) : threepids ? (
        threepids.map((t) => (
          <SettingTile
            key={`${t.medium}:${t.address}`}
            title={t.address}
            description={MEDIUM_LABELS[t.medium] ?? t.medium}
          />
        ))
      ) : (
        <SettingTile title="Loading…" />
      )}
    </SettingsCard>
  );
}
