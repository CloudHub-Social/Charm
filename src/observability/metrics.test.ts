import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import { recordCount, recordDistribution, recordGauge } from "./metrics";

vi.mock("@sentry/react", () => ({
  getClient: vi.fn(),
  metrics: {
    count: vi.fn(),
    gauge: vi.fn(),
    distribution: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("metrics", () => {
  it("is a no-op when there is no Sentry client", () => {
    vi.mocked(Sentry.getClient).mockReturnValue(undefined);

    recordCount("test.count");
    recordGauge("test.gauge", 1);
    recordDistribution("test.distribution", 1);

    expect(Sentry.metrics.count).not.toHaveBeenCalled();
    expect(Sentry.metrics.gauge).not.toHaveBeenCalled();
    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
  });

  it("is a no-op when the Sentry client is disabled", () => {
    vi.mocked(Sentry.getClient).mockReturnValue({
      getOptions: () => ({ enabled: false }),
    } as ReturnType<typeof Sentry.getClient>);

    recordCount("test.count");

    expect(Sentry.metrics.count).not.toHaveBeenCalled();
  });

  it("forwards count/gauge/distribution calls when enabled", () => {
    vi.mocked(Sentry.getClient).mockReturnValue({
      getOptions: () => ({ enabled: true }),
    } as ReturnType<typeof Sentry.getClient>);

    recordCount("test.count", 2, { outcome: "success" });
    recordGauge("test.gauge", 42, { unit: "millisecond" });
    recordDistribution("test.distribution", 7, { attributes: { command: "foo" } });

    expect(Sentry.metrics.count).toHaveBeenCalledWith("test.count", 2, {
      attributes: { outcome: "success" },
    });
    expect(Sentry.metrics.gauge).toHaveBeenCalledWith("test.gauge", 42, { unit: "millisecond" });
    expect(Sentry.metrics.distribution).toHaveBeenCalledWith("test.distribution", 7, {
      attributes: { command: "foo" },
    });
  });
});
