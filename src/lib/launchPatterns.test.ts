import { describe, expect, it } from "vitest";
import { classifyLaunchPattern, type LaunchPatternPoint } from "./launchPatterns";

function samples(prices: readonly number[], gapMs = 10_000): LaunchPatternPoint[] {
  return prices.map((priceUsd, index) => ({
    observedAtMs: Date.UTC(2026, 8, 5, 12) + index * gapMs,
    priceUsd,
    volume5mUsd: 100_000 + index * 2_000,
    buyRatio: 0.7,
    liquidityUsd: 200_000,
  }));
}

describe("launch pattern heuristics", () => {
  it("recognizes an orderly breakout with several advances and expanding volume", () => {
    const result = classifyLaunchPattern(samples([1, 1.01, 1.02, 1.03]));
    expect(result.pattern).toBe("breakout");
    expect(result.detail).toContain("heuristic");
  });

  it("recognizes a shallow pullback that reclaims half the retreat", () => {
    const result = classifyLaunchPattern(samples([1, 1.04, 1.02, 1.03]));
    expect(result.pattern).toBe("pullback-reclaim");
    expect(result.detail).toContain("heuristic");
  });

  it("retains the pullback label when recovery also exceeds the prior peak", () => {
    expect(classifyLaunchPattern(samples([1, 1.02, 1.04, 1.03, 1.045])).pattern)
      .toBe("pullback-reclaim");
  });

  it("does not mistake a single late vertical spike for an orderly breakout", () => {
    expect(classifyLaunchPattern(samples([1, 1.001, 1.002, 1.09])).pattern).toBeNull();
    expect(classifyLaunchPattern(samples([1, 1, 1, 1.06])).pattern).toBeNull();
  });

  it("rejects deep pullbacks and recoveries that have not reclaimed half", () => {
    expect(classifyLaunchPattern(samples([1, 1.1, 1.04, 1.08])).pattern).toBeNull();
    expect(classifyLaunchPattern(samples([1, 1.04, 1.02, 1.025])).pattern).toBeNull();
    expect(classifyLaunchPattern(samples([1, 0.98, 0.96, 0.97])).pattern).toBeNull();
  });

  it("rejects liquidity collapse even if liquidity later recovers", () => {
    const points = samples([1, 1.01, 1.02, 1.03]);
    points[1].liquidityUsd = 189_000;
    expect(classifyLaunchPattern(points).detail).toContain("liquidity");
    expect(classifyLaunchPattern(points).pattern).toBeNull();
  });

  it("requires five percent volume expansion and rejects a fading final sample", () => {
    const points = samples([1, 1.01, 1.02, 1.03]);
    points[3].volume5mUsd = 104_999;
    expect(classifyLaunchPattern(points).pattern).toBeNull();
    points[2].volume5mUsd = 110_000;
    points[3].volume5mUsd = 106_000;
    expect(classifyLaunchPattern(points).pattern).toBeNull();
  });

  it("requires sustained buy pressure throughout the observation window", () => {
    const points = samples([1, 1.01, 1.02, 1.03]);
    points[3].buyRatio = 0.64;
    expect(classifyLaunchPattern(points).pattern).toBeNull();
    points[3].buyRatio = 0.7;
    points[1].buyRatio = 0.49;
    expect(classifyLaunchPattern(points).pattern).toBeNull();
  });

  it("accepts the exact liquidity, volume, and buy-share boundary", () => {
    const points = samples([1, 1.01, 1.02, 1.03]);
    points[3].liquidityUsd = 190_000;
    points[3].volume5mUsd = 105_000;
    points[3].buyRatio = 0.65;
    expect(classifyLaunchPattern(points).pattern).toBe("breakout");
  });

  it("waits for at least four samples spanning thirty seconds", () => {
    expect(classifyLaunchPattern([]).pattern).toBeNull();
    expect(classifyLaunchPattern(samples([1, 1.01, 1.02], 15_000)).pattern).toBeNull();
    expect(classifyLaunchPattern(samples([1, 1.01, 1.02, 1.03], 9_000)).pattern).toBeNull();
  });

  it("rejects duplicate or regressing provider timestamps and sparse samples", () => {
    const points = samples([1, 1.01, 1.02, 1.03]);
    points[2].observedAtMs = points[1].observedAtMs;
    expect(classifyLaunchPattern(points).detail).toContain("timestamps");
    expect(classifyLaunchPattern(points).pattern).toBeNull();
    points[2].observedAtMs -= 1;
    expect(classifyLaunchPattern(points).pattern).toBeNull();
    const sparse = samples([1, 1.01, 1.02, 1.03], 21_000);
    expect(classifyLaunchPattern(sparse).detail).toContain("sparse");
    expect(classifyLaunchPattern(sparse).pattern).toBeNull();
  });

  it.each(["priceUsd", "volume5mUsd", "buyRatio", "liquidityUsd", "observedAtMs"] as const)(
    "rejects nonfinite %s",
    (key) => {
      const points = samples([1, 1.01, 1.02, 1.03]);
      points[1][key] = Number.NaN;
      expect(classifyLaunchPattern(points).pattern).toBeNull();
    },
  );

  it("handles tiny token prices without changing the pattern", () => {
    const points = samples([1, 1.01, 1.02, 1.03]);
    points.forEach((point) => { point.priceUsd *= 1e-12; });
    expect(classifyLaunchPattern(points).pattern).toBe("breakout");
  });

  it("uses only the trailing seventy-five seconds of ordered history", () => {
    const points = samples([3, 1, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07]);
    expect(classifyLaunchPattern(points).pattern).toBe("breakout");
  });
});
