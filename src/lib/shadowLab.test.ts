import { describe, expect, it } from "vitest";
import type { MarketToken } from "../types";
import { observationsAt } from "./paperRuntime";
import {
  createShadowLabState,
  loadShadowLabState,
  runShadowLabCycle,
  saveShadowLabState,
  shadowPolicyMetrics,
  type ShadowStorage,
} from "./shadowLab";

function token(overrides: Partial<MarketToken> = {}): MarketToken {
  return {
    mint: "DemoMint99111111111111111111111111111111",
    symbol: "TEST",
    name: "Test",
    ageSeconds: 3600,
    priceUsd: 1,
    change5mPct: 2,
    liquidityUsd: 300_000,
    volume5mUsd: 150_000,
    buyRatio: 0.65,
    buys5m: 40,
    sells5m: 20,
    traders5m: 100,
    organicBuyers5m: 12,
    organicScore: 50,
    riskLevel: "Medium",
    modelScore: 0.75,
    safety: { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, topTenHolderPct: 20, liquidityLocked: true, priceImpactPct: 0.2, transferTaxPct: 0, verified: true },
    source: "test",
    updatedAt: new Date(1_750_000_000_000).toISOString(),
    ...overrides,
  };
}

class MemoryStorage implements ShadowStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

describe("shadow strategy lab", () => {
  it("evaluates policies on the same observation without touching the user account", () => {
    const now = 1_750_000_000_000;
    const lab = createShadowLabState(400, now);
    const next = runShadowLabCycle(lab, observationsAt([token()], now), now);
    expect(next.policies.find((policy) => policy.id === "conservative")?.engineState.positions).toHaveLength(1);
    expect(next.policies.find((policy) => policy.id === "liquidity-first")?.engineState.positions).toHaveLength(0);
    expect(next.policies.find((policy) => policy.id === "baseline-control")?.engineState.positions).toHaveLength(1);
  });

  it("persists compact policy state and calculates comparable metrics", () => {
    const storage = new MemoryStorage();
    const now = 1_750_000_000_000;
    const lab = runShadowLabCycle(createShadowLabState(400, now), observationsAt([token()], now), now);
    expect(saveShadowLabState(lab, storage)).toBe(true);
    const loaded = loadShadowLabState(400, storage, now + 1);
    expect(loaded.policies).toHaveLength(5);
    expect(shadowPolicyMetrics(loaded, observationsAt([token()], now), now)).toHaveLength(5);
  });

  it("runs launch flow only after price and volume acceleration have both warmed", () => {
    const now = 1_750_000_000_000;
    const observation = {
      ...observationsAt([token({
        ageSeconds: 120,
        priceUsd: 1.01,
        change5mPct: 8,
        liquidityUsd: 25_000,
        volume5mUsd: 12_000,
        buyRatio: 0.82,
        buys5m: 40,
        sells5m: 8,
        traders5m: 30,
        organicBuyers5m: 7,
        riskLevel: "Medium",
      })], now)[0],
      shortMomentumPct: 1,
      shortMomentumWindowMs: 30_000,
      shortVolumeGrowthPct: 12,
      shortVolumeWindowMs: 30_000,
    };
    const next = runShadowLabCycle(createShadowLabState(400, now), [observation], now);
    expect(next.policies.find((policy) => policy.id === "launch-flow")?.engineState.positions).toHaveLength(1);
  });

  it("runs the pump scalp as a separate shadow policy after short-momentum warmup", () => {
    const now = 1_750_000_000_000;
    const observation = {
      ...observationsAt([token({
        ageSeconds: 600,
        priceUsd: 1.01,
        change5mPct: 10,
        liquidityUsd: 200_000,
        volume5mUsd: 120_000,
        buyRatio: 0.7,
        buys5m: 80,
        sells5m: 34,
        traders5m: 100,
        organicBuyers5m: 20,
      })], now)[0],
      shortMomentumPct: 1,
      shortMomentumWindowMs: 30_000,
    };
    const next = runShadowLabCycle(createShadowLabState(400, now), [observation], now);
    expect(next.policies.find((policy) => policy.id === "pump-scalp")?.engineState.positions).toHaveLength(1);
  });

  it("migrates the three v1 policy ledgers and adds the newer momentum shadows", () => {
    const storage = new MemoryStorage();
    const now = 1_750_000_000_000;
    const current = createShadowLabState(400, now);
    const legacy = {
      ...current,
      version: 1,
      policies: current.policies.filter((policy) => policy.id !== "pump-scalp" && policy.id !== "launch-flow"),
    };
    storage.setItem("pulseforge.shadow-lab-v1", JSON.stringify(legacy));
    const migrated = loadShadowLabState(400, storage, now + 1);
    expect(migrated.version).toBe(3);
    expect(migrated.policies.map((policy) => policy.id)).toEqual([
      "conservative", "liquidity-first", "pump-scalp", "launch-flow", "baseline-control",
    ]);
    expect(migrated.policies.find((policy) => policy.id === "pump-scalp")?.startedAtMs).toBe(now + 1);
    expect(migrated.policies.find((policy) => policy.id === "launch-flow")?.startedAtMs).toBe(now + 1);
  });
});
