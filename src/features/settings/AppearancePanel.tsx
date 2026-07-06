/**
 * No controls here by design — theming lives in Spec 09. This is just the
 * nav item's cross-link, per Spec 08's non-goals.
 */
export function AppearancePanel() {
  return (
    <div className="max-w-md">
      <h2 className="mb-2 text-lg font-bold text-foreground">Appearance</h2>
      <p className="text-sm text-muted-foreground">
        Theme and appearance controls aren't available yet — they'll land alongside Charm's theming
        support.
      </p>
    </div>
  );
}
