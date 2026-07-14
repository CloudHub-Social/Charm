import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

type Feature = {
  slug: string;
  snapshot: { suite: "e2e"; name: string };
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const snapshotRoot = path.resolve(
  repoRoot,
  process.env.FEATURE_DOC_E2E_DIR ?? ".artifacts/sentry-e2e-snapshots",
);
const manifest = JSON.parse(
  await readFile(path.join(repoRoot, "docs-site/src/data/feature-gallery.json"), "utf8"),
) as { features: Feature[] };

test.describe("committed feature documentation", () => {
  for (const feature of manifest.features) {
    test(`${feature.slug} matches its E2E journey`, async () => {
      const actual = await readFile(path.join(snapshotRoot, `${feature.snapshot.name}.png`));

      // Lucide SVG edges can vary by a few antialiased pixels between otherwise
      // identical Chromium captures. One hundred pixels is 0.011% of a 1280x720
      // snapshot: enough for that raster noise, but far below a visible UI change.
      expect(actual).toMatchSnapshot({
        name: `${feature.slug}.png`,
        maxDiffPixels: 100,
      });
    });
  }
});
