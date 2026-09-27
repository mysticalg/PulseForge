import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "../data/demo";
import type { MarketToken } from "../types";
import {
  conservativeSettingsForBudget,
  DEFAULT_PAPER_AUTOMATION_SETTINGS,
  launchFlowSettingsForBudget,
  launchRunnerSettingsForBudget,
  pumpScalpSettingsForBudget,
} from "./automationSettings";
import { createPaperEngineState, evaluateManualPaperEntry, evaluatePaperEntry } from "./paperEngine";
import { createPaperMomentumTracker, observationsAt, paperConfig } from "./paperRuntime";

function pumpToken(overrides: Partial<MarketToken> = {}): MarketToken {
  return {
    mint: "DemoMint88111111111111111111111111111111",
    symbol: "PUMP",
    name: "Pump test",
    ageSeconds: 600,
    priceUsd: 1,
    change5mPct: 10,
    liquidityUsd: 200_000,
    volume5mUsd: 120_000,
    buyRatio: 0.7,
    buys5m: 80,
    sells5m: 34,
    traders5m: 100,
    organicBuyers5m: 20,
    organicScore: 50,
    riskLevel: "Medium",
    modelScore: 0.1,
    safety: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      topTenHolderPct: 20,
      liquidityLocked: true,
      priceImpactPct: 0.2,
      transferTaxPct: 0,
      verified: true,
    },
    source: "test",
    updatedAt: new Date(Date.UTC(2026, 7, 21, 12)).toISOString(),
    ...overrides,
  };
}

describe("paper runtime policy", () => {
  it("does not turn repeated cached polls into new momentum evidence", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const tracker = createPaperMomentumTracker();
    observationsAt([pumpToken()], now, tracker);
    const repeated = observationsAt([pumpToken({ priceUsd: 1.01 })], now + 30_000, tracker)[0];
    expect(repeated.shortMomentumPct).toBeNull();
    expect(tracker.pointsByMint.get(repeated.mint)).toHaveLength(1);
    expect(repeated.launchPattern).toBeNull();
  });

  it("omits out-of-order provider rows instead of triggering exits at an old price", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const tracker = createPaperMomentumTracker();
    observationsAt([pumpToken({ priceUsd: 1.05, updatedAt: new Date(now + 10_000).toISOString() })], now + 10_000, tracker);
    expect(observationsAt([pumpToken({ priceUsd: 0.9 })], now + 15_000, tracker)).toEqual([]);
  });

  it("requires a measured orderly pattern for runner entries and leaves profit uncapped", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const tracker = createPaperMomentumTracker();
    const state = createPaperEngineState(400, now);
    const config = paperConfig(launchRunnerSettingsForBudget(400), state);
    let latest;
    for (let index = 0; index < 4; index += 1) {
      latest = observationsAt([pumpToken({
        priceUsd: 1 + index * 0.01,
        volume5mUsd: 120_000 + index * 3_000,
        updatedAt: new Date(now + index * 10_000).toISOString(),
      })], now + index * 10_000, tracker)[0];
    }
    expect(latest!.launchPattern).toBe("breakout");
    expect(evaluatePaperEntry(state, latest!, now + 30_000, config).eligible).toBe(true);
    expect(config.takeProfitPct).toBe(Infinity);
    expect(config.profitLockTriggerPct).toBe(Infinity);
    expect(config.maxHoldMs).toBe(45 * 60_000);
  });

  it("scales the conservative profile to a usable small-account order", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const state = createPaperEngineState(40, now);
    const settings = conservativeSettingsForBudget(40);
    const config = paperConfig(settings, state);
    expect(config.entryNotionalUsd).toBe(5);
    expect(config.dailyLossLimitPct).toBe(1);
    expect(config.minCashReserveUsd).toBe(30);
    expect(config.maxOpenPositions).toBe(5);
  });

  it("rejects one-sided 100% buy flow even with a high model score", () => {
    const now = Date.now();
    const token = createDemoSnapshot().tokens.find((candidate) => candidate.symbol === "GIGAOWL")!;
    const observation = observationsAt([{ ...token, buyRatio: 1, sells5m: 0, modelScore: 0.99 }], now)[0];
    const state = createPaperEngineState(400, now);
    const result = evaluatePaperEntry(state, observation, now, paperConfig(DEFAULT_PAPER_AUTOMATION_SETTINGS, state));
    expect(result.eligible).toBe(false);
    expect(result.blockers.join(" ")).toContain("Buy ratio is outside");
    expect(result.blockers).toContain("5m sell count is below 1");
  });

  it("warms a local 30-second momentum window before admitting a pump-scalp entry", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const tracker = createPaperMomentumTracker();
    const state = createPaperEngineState(400, now);
    const config = paperConfig(pumpScalpSettingsForBudget(400), state);
    const cold = observationsAt([pumpToken()], now, tracker)[0];
    expect(cold.shortMomentumPct).toBeNull();
    expect(evaluatePaperEntry(state, cold, now, config).blockers).toContain("Short-window momentum is still warming up");

    const warmed = observationsAt([pumpToken({ priceUsd: 1.01, updatedAt: new Date(now + 30_000).toISOString() })], now + 30_000, tracker)[0];
    expect(warmed.shortMomentumPct).toBeCloseTo(1, 6);
    expect(warmed.shortMomentumWindowMs).toBe(30_000);
    expect(evaluatePaperEntry(state, warmed, now + 30_000, config).eligible).toBe(true);
    expect(config.maxOpenPositions).toBe(4);
    expect(config.maxHoldMs).toBe(300_000);
    expect(config.takeProfitPct).toBe(6);
  });

  it("requires measured price and volume acceleration for launch-flow entries", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const tracker = createPaperMomentumTracker();
    const state = createPaperEngineState(400, now);
    const settings = launchFlowSettingsForBudget(400);
    const config = paperConfig(settings, state);
    const base = pumpToken({
      ageSeconds: 120,
      liquidityUsd: 25_000,
      volume5mUsd: 10_000,
      buyRatio: 0.82,
      buys5m: 40,
      sells5m: 8,
      traders5m: 30,
      organicBuyers5m: 7,
      change5mPct: 8,
    });
    const cold = observationsAt([base], now, tracker)[0];
    expect(evaluatePaperEntry(state, cold, now, config).blockers).toContain("Short-window volume growth is still warming up");

    const warmed = observationsAt([{ ...base, priceUsd: 1.01, volume5mUsd: 11_000, updatedAt: new Date(now + 30_000).toISOString() }], now + 30_000, tracker)[0];
    expect(warmed.shortMomentumPct).toBeCloseTo(1, 6);
    expect(warmed.shortVolumeGrowthPct).toBeCloseTo(10, 6);
    expect(evaluatePaperEntry(state, warmed, now + 30_000, config).eligible).toBe(true);
    expect(config.entryRanking).toBe("launch");
    expect(config.maxHoldMs).toBe(120_000);
    expect(config.exitBuyRatioBelow).toBe(0.43);
    expect(config.buyRatioDeteriorationCooldownMs).toBe(15 * 60_000);
    expect(config.exitLiquidityDrawdownPct).toBe(15);
    expect(config.liquidityDrawdownCooldownMs).toBe(15 * 60_000);
  });

  it("sizes the launch impact gate to the actual order and does not require mature organic fields", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const tracker = createPaperMomentumTracker();
    const state = createPaperEngineState(400, now);
    const config = paperConfig(launchFlowSettingsForBudget(400), state);
    const young = pumpToken({
      ageSeconds: 120,
      liquidityUsd: 5_000,
      volume5mUsd: 2_000,
      buyRatio: 0.65,
      buys5m: 5,
      sells5m: 2,
      traders5m: 8,
      organicBuyers5m: 0,
      organicScore: 0,
      change5mPct: 5,
      riskLevel: "High",
      safety: { ...pumpToken().safety, priceImpactPct: 4.5 },
    });
    observationsAt([young], now, tracker);
    const warmed = observationsAt([{ ...young, priceUsd: 1.01, volume5mUsd: 2_100, updatedAt: new Date(now + 30_000).toISOString() }], now + 30_000, tracker)[0];
    const evaluation = evaluatePaperEntry(state, warmed, now + 30_000, config);
    expect(config.entryNotionalUsd).toBe(10);
    expect(config.entryImpactMultiplier).toBeCloseTo(0.2, 6);
    expect(evaluation.blockers).not.toContain("Organic score is below 0");
    expect(evaluation.eligible).toBe(true);
  });

  it("does not treat exact 100% buy flow as a launch-flow winner", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const state = createPaperEngineState(400, now);
    const config = paperConfig(launchFlowSettingsForBudget(400), state);
    const observation = {
      ...observationsAt([pumpToken({
        ageSeconds: 120,
        liquidityUsd: 25_000,
        volume5mUsd: 11_000,
        buyRatio: 1,
        buys5m: 50,
        sells5m: 0,
        traders5m: 30,
        organicBuyers5m: 7,
        change5mPct: 8,
      })], now)[0],
      shortMomentumPct: 1,
      shortVolumeGrowthPct: 10,
    };
    const evaluation = evaluatePaperEntry(state, observation, now, config);
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockers.join(" ")).toContain("Buy ratio is outside");
    expect(evaluation.blockers).toContain("5m sell count is below 1");
  });

  it("uses the editable portfolio-wide open-position limit", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const state = createPaperEngineState(400, now);
    const settings = { ...pumpScalpSettingsForBudget(400), maxOpenPositions: 7 };
    expect(paperConfig(settings, state).maxOpenPositions).toBe(7);
    expect(pumpScalpSettingsForBudget(400).maxOpenPositions).toBe(4);
    expect(conservativeSettingsForBudget(400).maxOpenPositions).toBe(5);
  });

  it("maps editable flow and liquidity exit controls into the engine", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const state = createPaperEngineState(400, now);
    const config = paperConfig({
      ...launchFlowSettingsForBudget(400),
      exitBuyRatioBelow: 0.35,
      buyRatioDeteriorationCooldownMinutes: 42,
      exitLiquidityDrawdownPct: 25,
      liquidityDrawdownCooldownMinutes: 50,
      exitShortMomentumBelowPct: -1.2,
      exitShortVolumeGrowthBelowPct: -12,
      momentumBreakCooldownMinutes: 18,
    }, state);
    expect(config.exitBuyRatioBelow).toBe(0.35);
    expect(config.buyRatioDeteriorationCooldownMs).toBe(42 * 60_000);
    expect(config.exitLiquidityDrawdownPct).toBe(25);
    expect(config.liquidityDrawdownCooldownMs).toBe(50 * 60_000);
    expect(config.exitShortMomentumBelowPct).toBe(-1.2);
    expect(config.exitShortVolumeGrowthBelowPct).toBe(-12);
    expect(config.momentumBreakCooldownMs).toBe(18 * 60_000);
  });

  it("requires an explicit paper-only opt-in before elevated risk classifications can enter", () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const state = createPaperEngineState(400, now);
    const observation = observationsAt([pumpToken({ riskLevel: "High" })], now)[0];
    const standardSettings = {
      ...conservativeSettingsForBudget(400),
      minLiquidityUsd: 1,
      minModelScore: 0,
    };
    const standardConfig = paperConfig(standardSettings, state);
    const standard = evaluateManualPaperEntry(state, observation, 5, now, standardConfig);
    expect(standard.blockers).toContain("Risk level High is ineligible");
    expect(standard.blockers).toContain("Risk eligibility is not confirmed");

    const elevatedConfig = paperConfig({
      ...standardSettings,
      allowHighRiskPaperEntries: true,
    }, state);
    const elevated = evaluateManualPaperEntry(state, observation, 5, now, elevatedConfig);
    expect(elevated.blockers).not.toContain("Risk level High is ineligible");
    expect(elevated.blockers).not.toContain("Risk eligibility is not confirmed");
    expect(elevated.eligible).toBe(true);
  });
});
