import { describe, expect, it } from "vitest";
import type { MarketToken } from "../types";
import { launchRunnerSettingsForBudget } from "./automationSettings";
import {
  closePaperPosition,
  createPaperEngineState,
  DEFAULT_PAPER_ENGINE_CONFIG,
  enterPaperPosition,
  evaluateManualPaperEntry,
  evaluatePaperEntry,
  evaluatePaperExit,
  markPaperPortfolio,
  manualPaperBuy,
  mergePaperEngineConfig,
  runPaperCycle,
  type PaperEngineConfig,
  type PaperMarketObservation,
} from "./paperEngine";

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);

function observation(
  overrides: Partial<PaperMarketObservation> = {},
  safetyOverrides: Partial<MarketToken["safety"]> = {},
): PaperMarketObservation {
  return {
    mint: "MintA11111111111111111111111111111111111111",
    symbol: "ALPHA",
    name: "Alpha",
    ageSeconds: 3_600,
    priceUsd: 1,
    change5mPct: 2,
    liquidityUsd: 500_000,
    volume5mUsd: 100_000,
    buyRatio: 0.6,
    buys5m: 60,
    sells5m: 40,
    traders5m: 35,
    organicBuyers5m: 8,
    organicScore: 75,
    riskLevel: "Medium",
    modelScore: 0.8,
    safety: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      topTenHolderPct: 20,
      liquidityLocked: true,
      priceImpactPct: 0.2,
      transferTaxPct: 0,
      verified: true,
      ...safetyOverrides,
    },
    source: "test",
    updatedAt: new Date(NOW).toISOString(),
    observedAtMs: NOW,
    auditEligible: true,
    riskEligible: true,
    ...overrides,
  };
}

function permissiveConfig(overrides: Partial<PaperEngineConfig> = {}): PaperEngineConfig {
  return mergePaperEngineConfig({
    entryNotionalUsd: 100,
    minOrderUsd: 1,
    maxOpenPositions: 10,
    maxNewEntriesPerCycle: 10,
    minLiquidityUsd: 1,
    minVolume5mUsd: 1,
    minBuyRatio: 0.1,
    maxBuyRatio: 0.9,
    minBuys5m: 1,
    minSells5m: 1,
    minTrades5m: 1,
    minTraders5m: 1,
    minOrganicBuyers5m: 1,
    allowedRiskLevels: ["Low", "Medium", "Med-High", "High"],
    maxTopTenHolderPct: 100,
    maxTransferTaxPct: 100,
    maxEntryImpactPct: 100,
    minModelScore: 0,
    maxAllocationPerTokenPct: 100,
    maxAllocationPerTokenUsd: 10_000,
    minCashReserveUsd: 0,
    minCashReservePct: 0,
    cooldownMs: 0,
    buyRatioDeteriorationCooldownMs: 0,
    liquidityDrawdownCooldownMs: 0,
    globalEntryCooldownMs: 0,
    takeProfitPct: 10,
    stopLossPct: 10,
    trailingStopPct: 5,
    maxHoldMs: 60 * 60 * 1_000,
    exitBuyRatioBelow: 0.3,
    exitLiquidityDrawdownPct: 50,
    feeRateBps: 0,
    entryImpactMultiplier: 0,
    exitImpactMultiplier: 0,
    dailyLossLimitPct: 50,
    maxObservationAgeMs: 24 * 60 * 60 * 1_000,
    ...overrides,
  });
}

function enteredState(config = permissiveConfig()) {
  return enterPaperPosition(createPaperEngineState(10_000, NOW), observation(), NOW, config);
}

describe("automatic paper entry guards", () => {
  it("records the selected automatic policy as the entry reason", () => {
    const conservative = enterPaperPosition(createPaperEngineState(10_000, NOW), observation(), NOW, permissiveConfig());
    expect(conservative.trades[0].reason).toBe("automatic_conservative");

    const pump = enterPaperPosition(
      createPaperEngineState(10_000, NOW),
      observation(),
      NOW,
      permissiveConfig({ entryRanking: "pump" }),
    );
    expect(pump.trades[0].reason).toBe("automatic_pump_scalp");

    const launch = enterPaperPosition(
      createPaperEngineState(10_000, NOW),
      observation(),
      NOW,
      permissiveConfig({ entryRanking: "launch" }),
    );
    expect(launch.trades[0].reason).toBe("automatic_launch_flow");
  });

  it("accepts a fully eligible, liquid, two-sided observation", () => {
    const evaluation = evaluatePaperEntry(
      createPaperEngineState(10_000, NOW),
      observation(),
      NOW,
      DEFAULT_PAPER_ENGINE_CONFIG,
    );
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.allocationUsd).toBe(25);
  });

  it("fits automatic entries to the impact limit and values the actual position size on exit", () => {
    const config = permissiveConfig({
      entryNotionalUsd: 200,
      minOrderUsd: 5,
      maxAllocationPerTokenPct: 50,
      maxAllocationPerTokenUsd: 200,
      maxEntryImpactPct: 2,
      entryImpactMultiplier: Math.sqrt(200 / 250),
      exitImpactMultiplier: Math.sqrt(200 / 250),
      feeRateBps: 35,
      stopLossPct: 5,
    });
    const state = createPaperEngineState(400, NOW);
    const market = observation({ liquidityUsd: 4_000 }, { priceImpactPct: 5 });
    const evaluation = evaluatePaperEntry(state, market, NOW, config);
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.allocationUsd).toBeCloseTo(40, 10);

    const entered = enterPaperPosition(state, market, NOW, config);
    expect(entered.trades[0].notionalUsd).toBe(evaluation.allocationUsd);
    expect(entered.cashUsd).toBeCloseTo(360, 10);
    expect(entered.trades[0].feeUsd).toBeCloseTo(0.14, 10);
    expect(entered.trades[0].fillPriceUsd).toBeCloseTo(1.02, 10);
    expect(entered.positions[0].quantity).toBeCloseTo(39.86 / 1.02, 10);
    expect(evaluatePaperExit(entered.positions[0], market, NOW, config).shouldExit).toBe(false);

    const marked = markPaperPortfolio(entered, [market], config);
    const fallbackMark = markPaperPortfolio(entered, [], config);
    expect(fallbackMark.equityUsd).toBeCloseTo(marked.equityUsd, 10);
    expect(marked.positions[0].netReturnPct).toBeGreaterThan(-5);
    const closed = closePaperPosition(entered, market, 100, NOW, config);
    expect(closed.cashUsd).toBeCloseTo(marked.equityUsd, 10);

    // Partial exits use the amount actually sold, reducing their estimated impact.
    const partial = closePaperPosition(entered, market, 50, NOW, config);
    expect(partial.trades[1].fillPriceUsd).toBeGreaterThan(closed.trades[1].fillPriceUsd);
  });

  it("retains the cash reserve and scales fill impact after a further allocation reduction", () => {
    const config = permissiveConfig({
      entryNotionalUsd: 200,
      minOrderUsd: 5,
      maxAllocationPerTokenPct: 50,
      maxAllocationPerTokenUsd: 200,
      minCashReserveUsd: 380,
      maxEntryImpactPct: 2,
      entryImpactMultiplier: Math.sqrt(200 / 250),
      feeRateBps: 35,
    });
    const market = observation({ liquidityUsd: 4_000 }, { priceImpactPct: 5 });
    const state = createPaperEngineState(400, NOW);
    expect(evaluatePaperEntry(state, market, NOW, config).allocationUsd).toBe(20);
    const entered = enterPaperPosition(state, market, NOW, config);
    expect(entered.cashUsd).toBe(380);
    expect(entered.trades[0].feeUsd).toBeCloseTo(0.07, 10);
    expect(entered.trades[0].fillPriceUsd).toBeCloseTo(1 + Math.sqrt(2) / 100, 10);
  });

  it("rejects unknown impact and an impact-sized order below the minimum", () => {
    const config = permissiveConfig({
      entryNotionalUsd: 200,
      minOrderUsd: 5,
      maxEntryImpactPct: 2,
      entryImpactMultiplier: Math.sqrt(200 / 250),
    });
    const state = createPaperEngineState(400, NOW);
    for (const priceImpactPct of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const market = observation({}, { priceImpactPct });
      expect(evaluatePaperEntry(state, market, NOW, config).blockers)
        .toContain("Entry impact exceeds 2% or is unknown");
      expect(() => enterPaperPosition(state, market, NOW, config)).toThrow(/Paper entry blocked/);
    }
    const market = observation({ liquidityUsd: 40 }, { priceImpactPct: 25 });
    const evaluation = evaluatePaperEntry(state, market, NOW, config);
    expect(evaluation.allocationUsd).toBeCloseTo(1.6, 10);
    expect(evaluation.blockers).toContain("Allocation is below the minimum paper order");
    expect(() => enterPaperPosition(state, market, NOW, config)).toThrow(/minimum paper order/);
  });

  it("blocks an excessive manual quote instead of resizing the requested amount", () => {
    const config = permissiveConfig({
      entryNotionalUsd: 200,
      minOrderUsd: 5,
      maxAllocationPerTokenPct: 50,
      maxAllocationPerTokenUsd: 200,
      maxEntryImpactPct: 2,
      entryImpactMultiplier: Math.sqrt(200 / 250),
      exitImpactMultiplier: Math.sqrt(200 / 250),
    });
    const state = createPaperEngineState(400, NOW);
    const requestedQuote = observation({ liquidityUsd: 4_000 }, { priceImpactPct: Math.sqrt(20) });
    const evaluation = evaluateManualPaperEntry(state, requestedQuote, 200, NOW, config);
    expect(evaluation.allocationUsd).toBe(200);
    expect(evaluation.blockers).toContain("Entry impact exceeds 2% or is unknown");
    expect(() => manualPaperBuy(state, requestedQuote, 200, NOW, config)).toThrow(/Entry impact/);

    const smallerQuote = observation({ liquidityUsd: 4_000 }, { priceImpactPct: 1 });
    const entered = manualPaperBuy(state, smallerQuote, 25, NOW, config);
    expect(entered.trades[0].notionalUsd).toBe(25);
    expect(entered.trades[0].fillPriceUsd).toBe(1.01);
    // The last mark retains a normalized reference, avoiding a second scaling
    // of the original amount-specific manual quote during portfolio valuation.
    const expectedExitImpactPct = Math.sqrt(entered.positions[0].quantity / 25);
    const expectedProceeds = entered.positions[0].quantity * (1 - expectedExitImpactPct / 100);
    expect(markPaperPortfolio(entered, [], config).liquidationValueUsd).toBeCloseTo(expectedProceeds, 10);
  });

  it("requires a confirmed launch pattern for runner entries while preserving safety gates", () => {
    const config = permissiveConfig({ requireLaunchPattern: true });
    const state = createPaperEngineState(10_000, NOW);
    const measured = { shortMomentumPct: 1, shortMomentumWindowMs: 30_000, shortVolumeGrowthPct: 5, shortVolumeWindowMs: 30_000 };
    expect(evaluatePaperEntry(state, observation(), NOW, config).blockers)
      .toContain("Launch pattern is still forming");
    for (const launchPattern of ["breakout", "pullback-reclaim"] as const) {
      expect(evaluatePaperEntry(state, observation({ ...measured, launchPattern }), NOW, config).eligible).toBe(true);
      expect(evaluatePaperEntry(state, observation({ ...measured, launchPattern }, { mintAuthorityRevoked: false }), NOW, config).eligible)
        .toBe(false);
    }
  });

  it.each([undefined, null, 0, 24_999, 75_001, Number.NaN, Number.POSITIVE_INFINITY])("blocks required entry evidence with unusable windows %s", (windowMs) => {
    const state = createPaperEngineState(10_000, NOW);
    const market = observation({
      launchPattern: "breakout",
      shortMomentumPct: 1,
      shortMomentumWindowMs: windowMs,
      shortVolumeGrowthPct: 10,
      shortVolumeWindowMs: windowMs,
    });
    for (const overrides of [{ requireShortMomentum: true, requireShortVolumeGrowth: true }, { requireLaunchPattern: true }]) {
      const result = evaluatePaperEntry(state, market, NOW, permissiveConfig(overrides));
      expect(result.eligible).toBe(false);
      expect(result.blockers).toContain("Short-window momentum is still warming up");
      expect(result.blockers).toContain("Short-window volume growth is still warming up");
    }
  });

  it("validates independent required price and volume windows at both boundaries", () => {
    const state = createPaperEngineState(10_000, NOW);
    const config = permissiveConfig({ requireLaunchPattern: true });
    const market = observation({
      launchPattern: "pullback-reclaim",
      shortMomentumPct: 1,
      shortMomentumWindowMs: 25_000,
      shortVolumeGrowthPct: 10,
      shortVolumeWindowMs: 75_000,
    });
    expect(evaluatePaperEntry(state, market, NOW, config).eligible).toBe(true);
    expect(evaluatePaperEntry(state, { ...market, shortVolumeWindowMs: 75_001 }, NOW, config).blockers)
      .toEqual(["Short-window volume growth is still warming up"]);
    expect(evaluatePaperEntry(state, { ...market, shortMomentumWindowMs: 24_999 }, NOW, config).blockers)
      .toEqual(["Short-window momentum is still warming up"]);
  });

  it("requires buys and sells and rejects one-sided buy flow", () => {
    const state = createPaperEngineState(10_000, NOW);
    const noSells = evaluatePaperEntry(state, observation({ buys5m: 100, sells5m: 0, buyRatio: 1 }), NOW);
    expect(noSells.eligible).toBe(false);
    expect(noSells.blockers).toContain("5m sell count is below 1");
    expect(noSells.blockers.join(" ")).toContain("Buy ratio is outside");

    const tooOneSided = evaluatePaperEntry(state, observation({ buyRatio: 0.851 }), NOW);
    expect(tooOneSided.eligible).toBe(false);
    const boundary = evaluatePaperEntry(state, observation({ buyRatio: 0.85 }), NOW);
    expect(boundary.blockers.join(" ")).not.toContain("Buy ratio is outside");
  });

  it("enforces total trades, traders, and organic buyers when values are present", () => {
    const state = createPaperEngineState(10_000, NOW);
    const evaluation = evaluatePaperEntry(
      state,
      observation({ buys5m: 10, sells5m: 9, traders5m: 9, organicBuyers5m: 1 }),
      NOW,
    );
    expect(evaluation.blockers).toContain("5m trade count is below 20");
    expect(evaluation.blockers).toContain("5m trader count is below 10");
    expect(evaluation.blockers).toContain("5m organic buyer count is below 2");
  });

  it("can ignore unavailable optional activity metrics or require them", () => {
    const unavailable = observation({ traders5m: Number.NaN, organicBuyers5m: Number.NaN, organicScore: null });
    const state = createPaperEngineState(10_000, NOW);
    expect(evaluatePaperEntry(state, unavailable, NOW).blockers.join(" ")).not.toContain("unavailable");
    const strict = evaluatePaperEntry(
      state,
      unavailable,
      NOW,
      mergePaperEngineConfig({ requireActivityMetrics: true, requireOrganicScore: true }),
    );
    expect(strict.blockers).toContain("5m trader count is unavailable");
    expect(strict.blockers).toContain("5m organic buyer count is unavailable");
    expect(strict.blockers).toContain("Organic score is unavailable");
  });

  it("enforces the configured organic score when Jupiter supplies it", () => {
    const lowOrganic = evaluatePaperEntry(
      createPaperEngineState(10_000, NOW),
      observation({ organicScore: 24.99 }),
      NOW,
    );
    expect(lowOrganic.blockers).toContain("Organic score is below 25");
    expect(evaluatePaperEntry(createPaperEngineState(10_000, NOW), observation({ organicScore: 25 }), NOW).eligible)
      .toBe(true);
  });

  it("does not let model rank bypass risk and audit vetoes", () => {
    const unsafe = observation(
      { modelScore: 0.999, riskLevel: "High", auditEligible: false },
      { mintAuthorityRevoked: false },
    );
    const result = evaluatePaperEntry(createPaperEngineState(10_000, NOW), unsafe, NOW);
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("Risk level High is ineligible");
    expect(result.blockers).toContain("Audit eligibility is not confirmed");
    expect(result.blockers).toContain("Mint authority is not revoked");
  });

  it("can opt into a high-risk classification without bypassing contract audit gates", () => {
    const unsafe = observation(
      { riskLevel: "High", riskEligible: false, auditEligible: false },
      { mintAuthorityRevoked: false },
    );
    const result = evaluatePaperEntry(
      createPaperEngineState(10_000, NOW),
      unsafe,
      NOW,
      permissiveConfig({
        allowedRiskLevels: ["Low", "Medium", "Med-High", "High"],
        requireRiskEligibilityFlag: true,
        allowUnconfirmedRiskEligibility: true,
        requireAuditEligibilityFlag: true,
      }),
    );
    expect(result.blockers).not.toContain("Risk level High is ineligible");
    expect(result.blockers).not.toContain("Risk eligibility is not confirmed");
    expect(result.blockers).toContain("Audit eligibility is not confirmed");
    expect(result.blockers).toContain("Mint authority is not revoked");
  });

  it("sizes down to the per-token cap and preserves the configured cash reserve", () => {
    const state = createPaperEngineState(10_000, NOW);
    const capped = evaluatePaperEntry(
      state,
      observation(),
      NOW,
      mergePaperEngineConfig({ entryNotionalUsd: 500, maxAllocationPerTokenPct: 1, maxAllocationPerTokenUsd: 250 }),
    );
    expect(capped.eligible).toBe(true);
    expect(capped.allocationUsd).toBe(100);

    const reserveBlocked = evaluatePaperEntry(
      createPaperEngineState(100, NOW),
      observation(),
      NOW,
      mergePaperEngineConfig({
        entryNotionalUsd: 25,
        minOrderUsd: 15,
        maxAllocationPerTokenPct: 100,
        maxAllocationPerTokenUsd: 250,
        minCashReserveUsd: 90,
        minCashReservePct: 0,
      }),
    );
    expect(reserveBlocked.eligible).toBe(false);
    expect(reserveBlocked.allocationUsd).toBe(10);
    expect(reserveBlocked.blockers).toContain("Allocation is below the minimum paper order");
  });

  it("applies cooldown after a close and releases it exactly at the boundary", () => {
    const config = permissiveConfig({ cooldownMs: 60_000 });
    const entered = enteredState(config);
    const closed = closePaperPosition(entered, observation(), 100, NOW + 1_000, config);
    const before = evaluatePaperEntry(closed, observation({ observedAtMs: NOW + 60_999 }), NOW + 60_999, config);
    expect(before.blockers).toContain("Token cooldown is active");
    const atBoundary = evaluatePaperEntry(closed, observation({ observedAtMs: NOW + 61_000 }), NOW + 61_000, config);
    expect(atBoundary.blockers).not.toContain("Token cooldown is active");
  });

  it("uses a longer mint cooldown after buy-ratio deterioration", () => {
    const config = permissiveConfig({
      cooldownMs: 60_000,
      buyRatioDeteriorationCooldownMs: 10 * 60_000,
      exitBuyRatioBelow: 0.4,
    });
    const entered = enteredState(config);
    const exitAt = NOW + 1_000;
    const exited = runPaperCycle(
      entered,
      [observation({ buyRatio: 0.39, observedAtMs: exitAt })],
      exitAt,
      config,
    ).state;

    const before = evaluatePaperEntry(
      exited,
      observation({ buyRatio: 0.6, observedAtMs: exitAt + 9 * 60_000 }),
      exitAt + 9 * 60_000,
      config,
    );
    expect(before.blockers).toContain("Buy-ratio deterioration cooldown is active");

    const atBoundary = evaluatePaperEntry(
      exited,
      observation({ buyRatio: 0.6, observedAtMs: exitAt + 10 * 60_000 }),
      exitAt + 10 * 60_000,
      config,
    );
    expect(atBoundary.blockers).not.toContain("Buy-ratio deterioration cooldown is active");
  });

  it("uses a longer mint cooldown after a liquidity-drawdown exit", () => {
    const config = permissiveConfig({
      cooldownMs: 60_000,
      exitLiquidityDrawdownPct: 20,
      liquidityDrawdownCooldownMs: 20 * 60_000,
    });
    const entered = enteredState(config);
    const exitAt = NOW + 1_000;
    const exited = runPaperCycle(
      entered,
      [observation({ liquidityUsd: 399_999, observedAtMs: exitAt })],
      exitAt,
      config,
    ).state;

    const before = evaluatePaperEntry(
      exited,
      observation({ observedAtMs: exitAt + 19 * 60_000 }),
      exitAt + 19 * 60_000,
      config,
    );
    expect(before.blockers).toContain("Liquidity-drawdown cooldown is active");

    const atBoundary = evaluatePaperEntry(
      exited,
      observation({ observedAtMs: exitAt + 20 * 60_000 }),
      exitAt + 20 * 60_000,
      config,
    );
    expect(atBoundary.blockers).not.toContain("Liquidity-drawdown cooldown is active");
  });

  it.each(["momentum_reversal", "volume_fade"] as const)("applies the %s cooldown only to the exited mint, releasing it at the boundary", (reason) => {
    const config = permissiveConfig({
      cooldownMs: 60_000,
      momentumBreakCooldownMs: 15 * 60_000,
      exitShortMomentumBelowPct: -0.2,
      exitShortVolumeGrowthBelowPct: -5,
    });
    // A sell in the same millisecond as its buy still owns the cooldown.
    const exitAt = NOW;
    const exited = runPaperCycle(enteredState(config), [observation({
      shortMomentumPct: reason === "momentum_reversal" ? -0.2 : 1,
      shortMomentumWindowMs: 30_000,
      shortVolumeGrowthPct: reason === "volume_fade" ? -5 : 1,
      shortVolumeWindowMs: 30_000,
      observedAtMs: exitAt,
    })], exitAt, config).state;
    expect(exited.trades.at(-1)?.reason).toBe(reason);
    expect(exited.positions).toHaveLength(0);
    const beforeAt = exitAt + 15 * 60_000 - 1;
    expect(evaluatePaperEntry(exited, observation({ observedAtMs: beforeAt }), beforeAt, config).blockers)
      .toContain("Momentum-break cooldown is active");
    expect(evaluateManualPaperEntry(exited, observation({ observedAtMs: beforeAt }), 25, beforeAt, config).blockers)
      .toContain("Momentum-break cooldown is active");
    expect(evaluatePaperEntry(exited, observation({ mint: "MintB", observedAtMs: beforeAt }), beforeAt, config).eligible)
      .toBe(true);
    const boundaryAt = beforeAt + 1;
    expect(evaluatePaperEntry(exited, observation({ observedAtMs: boundaryAt }), boundaryAt, config).eligible)
      .toBe(true);
  });

  it("spaces automatic entries across market cycles", () => {
    const config = permissiveConfig({ globalEntryCooldownMs: 60_000, maxNewEntriesPerCycle: 1 });
    const first = runPaperCycle(createPaperEngineState(10_000, NOW), [observation()], NOW, config).state;
    const secondCandidate = observation({ mint: "MintB", symbol: "B", observedAtMs: NOW + 5_000 });
    const blocked = evaluatePaperEntry(first, secondCandidate, NOW + 5_000, config);
    expect(blocked.blockers).toContain("Portfolio entry spacing is active");
    const released = evaluatePaperEntry(first, { ...secondCandidate, observedAtMs: NOW + 60_000 }, NOW + 60_000, config);
    expect(released.blockers).not.toContain("Portfolio entry spacing is active");
  });

  it("selects candidates deterministically by model, liquidity, then mint", () => {
    const lower = observation({ mint: "MintB", symbol: "B", modelScore: 0.7 });
    const higher = observation({ mint: "MintA", symbol: "A", modelScore: 0.9 });
    const config = permissiveConfig({ maxNewEntriesPerCycle: 1 });
    const result = runPaperCycle(createPaperEngineState(10_000, NOW), [lower, higher], NOW, config);
    expect(result.state.positions.map((position) => position.mint)).toEqual(["MintA"]);
    expect(result.trades[0].id).toBe("paper-1");
  });
});

describe("manual paper entry", () => {
  it("exposes the same preflight blockers before execution", () => {
    const config = permissiveConfig({ maxOpenPositions: 0 });
    const state = createPaperEngineState(10_000, NOW);
    const evaluation = evaluateManualPaperEntry(state, observation(), 25, NOW, config, { killSwitch: true });
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockers).toContain("Maximum open positions reached (0/0)");
    expect(evaluation.blockers).toContain("Kill switch is active");
    expect(() => manualPaperBuy(state, observation(), 25, NOW, config, { killSwitch: true }))
      .toThrow(evaluation.blockers.join("; "));
  });

  it("allows a second token immediately after the configured cap is raised", () => {
    const config = permissiveConfig({ maxOpenPositions: 1 });
    const first = manualPaperBuy(createPaperEngineState(10_000, NOW), observation(), 25, NOW, config);
    const secondObservation = observation({
      mint: "MintB11111111111111111111111111111111111111",
      symbol: "BETA",
      observedAtMs: NOW + 1_000,
    });
    const blocked = evaluateManualPaperEntry(first, secondObservation, 25, NOW + 1_000, config);
    expect(blocked.blockers).toContain("Maximum open positions reached (1/1)");

    const expanded = evaluateManualPaperEntry(
      first,
      secondObservation,
      25,
      NOW + 1_000,
      { ...config, maxOpenPositions: 2 },
    );
    expect(expanded.eligible).toBe(true);
  });

  it("bypasses alpha/activity thresholds but records a manual entry", () => {
    const config = mergePaperEngineConfig({
      entryNotionalUsd: 25,
      minVolume5mUsd: 1_000_000,
      minBuyRatio: 0.55,
      maxBuyRatio: 0.85,
      minTrades5m: 1_000,
      minTraders5m: 1_000,
      minOrganicBuyers5m: 1_000,
      minModelScore: 0.99,
      maxAllocationPerTokenPct: 100,
      maxAllocationPerTokenUsd: 250,
      minCashReserveUsd: 0,
      minCashReservePct: 0,
    });
    const weakSignal = observation({
      volume5mUsd: 0,
      buyRatio: 1,
      buys5m: 0,
      sells5m: 0,
      traders5m: 0,
      organicBuyers5m: 0,
      modelScore: 0,
    });
    expect(evaluatePaperEntry(createPaperEngineState(10_000, NOW), weakSignal, NOW, config).eligible).toBe(false);

    const bought = manualPaperBuy(createPaperEngineState(10_000, NOW), weakSignal, 25, NOW, config);
    expect(bought.positions).toHaveLength(1);
    expect(bought.trades[0].reason).toBe("manual_entry");
    expect(bought.cashUsd).toBe(9_975);
  });

  it("retains hard quote/audit gates and refuses averaging", () => {
    const config = permissiveConfig();
    expect(() => manualPaperBuy(
      createPaperEngineState(10_000, NOW),
      observation({ liquidityUsd: 0.5 }, { mintAuthorityRevoked: false }),
      25,
      NOW,
      config,
    )).toThrow(/Liquidity.*Mint authority/);

    const bought = manualPaperBuy(createPaperEngineState(10_000, NOW), observation(), 25, NOW, config);
    expect(() => manualPaperBuy(bought, observation({ observedAtMs: NOW + 1_000 }), 25, NOW + 1_000, config))
      .toThrow(/averaging is disabled/);
  });

  it("rejects allocations that exceed the token cap or cash reserve", () => {
    const capped = mergePaperEngineConfig({
      maxAllocationPerTokenPct: 1,
      maxAllocationPerTokenUsd: 250,
      minCashReserveUsd: 0,
      minCashReservePct: 0,
    });
    expect(() => manualPaperBuy(createPaperEngineState(10_000, NOW), observation(), 101, NOW, capped))
      .toThrow(/per-token cap/);

    const reserved = mergePaperEngineConfig({
      maxAllocationPerTokenPct: 100,
      maxAllocationPerTokenUsd: 10_000,
      minCashReserveUsd: 9_990,
      minCashReservePct: 0,
    });
    expect(() => manualPaperBuy(createPaperEngineState(10_000, NOW), observation(), 25, NOW, reserved))
      .toThrow(/cash reserve/);
  });

  it("honours the kill switch and a latched daily-loss stop", () => {
    const config = permissiveConfig();
    const state = createPaperEngineState(10_000, NOW);
    expect(() => manualPaperBuy(state, observation(), 25, NOW, config, { killSwitch: true }))
      .toThrow(/Kill switch/);
    expect(() => manualPaperBuy({ ...state, dailyLossLockedDay: "2026-08-21" }, observation(), 25, NOW, config))
      .toThrow(/Daily loss lock/);
  });
});

describe("paper exits", () => {
  it.each([
    ["take_profit", { priceUsd: 1.11 }, {}],
    ["stop_loss", { priceUsd: 0.89 }, {}],
    ["max_hold", {}, { nowMs: NOW + 60 * 60 * 1_000 }],
    ["buy_ratio_deterioration", { buyRatio: 0.29 }, {}],
    ["liquidity_drawdown", { liquidityUsd: 249_999 }, {}],
  ] as const)("emits %s", (expected, marketOverrides, timing) => {
    const config = permissiveConfig();
    const position = enteredState(config).positions[0];
    const nowMs = "nowMs" in timing ? timing.nowMs : NOW + 1_000;
    const evaluation = evaluatePaperExit(
      position,
      observation({ ...marketOverrides, observedAtMs: nowMs }),
      nowMs,
      config,
    );
    expect(evaluation).toEqual({ mint: position.mint, shouldExit: true, reason: expected });
  });

  it("can disable buy-ratio deterioration exits with a zero threshold", () => {
    const config = permissiveConfig({ exitBuyRatioBelow: 0 });
    const position = enteredState(config).positions[0];
    const evaluation = evaluatePaperExit(
      position,
      observation({ buyRatio: 0, observedAtMs: NOW + 1_000 }),
      NOW + 1_000,
      config,
    );
    expect(evaluation.shouldExit).toBe(false);
  });

  it("can disable liquidity-drawdown exits with a zero threshold", () => {
    const config = permissiveConfig({ exitLiquidityDrawdownPct: 0 });
    const position = enteredState(config).positions[0];
    const evaluation = evaluatePaperExit(
      position,
      observation({ liquidityUsd: 0, observedAtMs: NOW + 1_000 }),
      NOW + 1_000,
      config,
    );
    expect(evaluation.shouldExit).toBe(false);
  });

  it("exits launch-flow positions when local price or volume momentum fades", () => {
    const config = permissiveConfig({
      exitShortMomentumBelowPct: -0.35,
      exitShortVolumeGrowthBelowPct: -5,
    });
    const position = enteredState(config).positions[0];
    const reversal = evaluatePaperExit(
      position,
      observation({ shortMomentumPct: -0.5, shortMomentumWindowMs: 30_000, shortVolumeGrowthPct: 5, observedAtMs: NOW + 1_000 }),
      NOW + 1_000,
      config,
    );
    expect(reversal.reason).toBe("momentum_reversal");

    const fade = evaluatePaperExit(
      position,
      observation({ shortMomentumPct: 0.2, shortVolumeGrowthPct: -6, shortVolumeWindowMs: 30_000, observedAtMs: NOW + 1_000 }),
      NOW + 1_000,
      config,
    );
    expect(fade.reason).toBe("volume_fade");
  });

  it.each([
    [-0.19, -4.99, null],
    [-0.2, 1, "momentum_reversal"],
    [-0.21, 1, "momentum_reversal"],
    [1, -5, "volume_fade"],
    [1, -5.01, "volume_fade"],
  ] as const)("evaluates exact momentum boundaries %s / %s", (price, volume, reason) => {
    const config = permissiveConfig({ exitShortMomentumBelowPct: -0.2, exitShortVolumeGrowthBelowPct: -5 });
    const result = evaluatePaperExit(enteredState(config).positions[0], observation({
      shortMomentumPct: price,
      shortMomentumWindowMs: 25_000,
      shortVolumeGrowthPct: volume,
      shortVolumeWindowMs: 75_000,
    }), NOW, config);
    expect(result.reason).toBe(reason);
  });

  it.each([undefined, null, 0, 24_999, 75_001, Number.NaN, Number.POSITIVE_INFINITY])("ignores unusable short windows %s", (windowMs) => {
    const config = permissiveConfig({ exitShortMomentumBelowPct: -0.2, exitShortVolumeGrowthBelowPct: -5 });
    expect(evaluatePaperExit(enteredState(config).positions[0], observation({
      shortMomentumPct: -1,
      shortMomentumWindowMs: windowMs,
      shortVolumeGrowthPct: -10,
      shortVolumeWindowMs: windowMs,
    }), NOW, config).shouldExit).toBe(false);
  });

  it.each([undefined, null, Number.NaN, Number.NEGATIVE_INFINITY])("ignores missing or non-finite momentum %s", (value) => {
    const config = permissiveConfig({ exitShortMomentumBelowPct: -0.2, exitShortVolumeGrowthBelowPct: -5 });
    expect(evaluatePaperExit(enteredState(config).positions[0], observation({
      shortMomentumPct: value,
      shortMomentumWindowMs: 30_000,
      shortVolumeGrowthPct: value,
      shortVolumeWindowMs: 30_000,
    }), NOW, config).shouldExit).toBe(false);
  });

  it("uses valid price and volume evidence independently", () => {
    const config = permissiveConfig({ exitShortMomentumBelowPct: -0.2, exitShortVolumeGrowthBelowPct: -5 });
    const position = enteredState(config).positions[0];
    expect(evaluatePaperExit(position, observation({
      shortMomentumPct: -1, shortMomentumWindowMs: 30_000,
      shortVolumeGrowthPct: -10, shortVolumeWindowMs: null,
    }), NOW, config).reason).toBe("momentum_reversal");
    expect(evaluatePaperExit(position, observation({
      shortMomentumPct: -1, shortMomentumWindowMs: null,
      shortVolumeGrowthPct: -10, shortVolumeWindowMs: 30_000,
    }), NOW, config).reason).toBe("volume_fade");
  });

  it("keeps disabled momentum thresholds inactive", () => {
    const config = permissiveConfig();
    expect(evaluatePaperExit(enteredState(config).positions[0], observation({
      shortMomentumPct: -100, shortMomentumWindowMs: 30_000,
      shortVolumeGrowthPct: -100, shortVolumeWindowMs: 30_000,
    }), NOW, config).shouldExit).toBe(false);
  });

  it.each([
    { updatedAt: new Date(NOW - 60_001).toISOString(), observedAtMs: NOW },
    { updatedAt: "invalid", observedAtMs: NOW },
    { updatedAt: new Date(NOW + 5_001).toISOString(), observedAtMs: NOW },
    { updatedAt: new Date(NOW).toISOString(), observedAtMs: NOW - 60_001 },
    { updatedAt: new Date(NOW).toISOString(), observedAtMs: NOW + 5_001 },
    { updatedAt: new Date(NOW).toISOString(), observedAtMs: Number.NaN },
  ])("rejects stale or invalid provider/receipt evidence %#", (timestamps) => {
    const config = permissiveConfig({ maxObservationAgeMs: 60_000, exitShortMomentumBelowPct: -0.2 });
    const state = enteredState(config);
    const market = observation({ ...timestamps, shortMomentumPct: -1, shortMomentumWindowMs: 30_000 });
    expect(evaluatePaperExit(state.positions[0], market, NOW, config).shouldExit).toBe(false);
    expect(evaluatePaperEntry(createPaperEngineState(10_000, NOW), market, NOW, config).blockers)
      .toContain("Observation is stale or time-invalid");
    expect(runPaperCycle(state, [market], NOW, config).trades).toHaveLength(0);
  });

  it("keeps stop-loss and trailing-stop exits ahead of a momentum break", () => {
    const config = permissiveConfig({ exitShortMomentumBelowPct: -0.2 });
    const position = enteredState(config).positions[0];
    const breaking = { shortMomentumPct: -1, shortMomentumWindowMs: 30_000 };
    expect(evaluatePaperExit(position, observation({ ...breaking, priceUsd: 0.85 }), NOW, config).reason).toBe("stop_loss");
    expect(evaluatePaperExit(position, observation({ ...breaking, priceUsd: 0.94 }), NOW, config).reason).toBe("trailing_stop");
  });

  it("lets a runner hold a sustained 10x move past two minutes, then exits a momentum break", () => {
    const runner = launchRunnerSettingsForBudget(400);
    const config = permissiveConfig({
      takeProfitPct: runner.takeProfitPct,
      stopLossPct: runner.stopLossPct,
      trailingStopPct: runner.trailingStopPct,
      maxHoldMs: runner.maxHoldMinutes * 60_000,
      exitShortMomentumBelowPct: runner.exitShortMomentumBelowPct,
      exitShortVolumeGrowthBelowPct: runner.exitShortVolumeGrowthBelowPct,
    });
    const runningAt = NOW + 3 * 60_000;
    const running = observation({
      priceUsd: 10,
      shortMomentumPct: 2,
      shortMomentumWindowMs: 30_000,
      shortVolumeGrowthPct: 10,
      shortVolumeWindowMs: 30_000,
      updatedAt: new Date(runningAt).toISOString(),
      observedAtMs: runningAt,
    });
    const held = runPaperCycle(enteredState(config), [running], runningAt, config);
    expect(held.trades).toHaveLength(0);
    expect(held.state.positions).toHaveLength(1);
    expect(held.state.positions[0].highestPriceUsd).toBe(10);
    expect(evaluatePaperExit(held.state.positions[0], { ...running, shortMomentumPct: -2 }, runningAt, config).reason)
      .toBe("momentum_reversal");
  });

  it("trails the highest observed price", () => {
    const config = permissiveConfig({ takeProfitPct: 100, trailingStopPct: 5 });
    const state = enteredState(config);
    const peakTime = NOW + 1_000;
    const peaked = runPaperCycle(
      state,
      [observation({ priceUsd: 1.2, observedAtMs: peakTime })],
      peakTime,
      config,
    ).state;
    expect(peaked.positions[0].highestPriceUsd).toBe(1.2);

    const pullbackTime = NOW + 2_000;
    const pullback = evaluatePaperExit(
      peaked.positions[0],
      observation({ priceUsd: 1.13, observedAtMs: pullbackTime }),
      pullbackTime,
      config,
    );
    expect(pullback.reason).toBe("trailing_stop");
  });

  it("locks a small net gain after the position has first cleared the pump profit trigger", () => {
    const config = permissiveConfig({
      takeProfitPct: 20,
      trailingStopPct: 100,
      profitLockTriggerPct: 4,
      profitLockFloorPct: 0.5,
    });
    const position = { ...enteredState(config).positions[0], highestPriceUsd: 1.06 };
    const evaluation = evaluatePaperExit(
      position,
      observation({ priceUsd: 1.004, observedAtMs: NOW + 2_000 }),
      NOW + 2_000,
      config,
    );
    expect(evaluation.reason).toBe("profit_lock");
  });

  it("does not re-enter a token in the cycle that exits it", () => {
    const config = permissiveConfig({ cooldownMs: 0, takeProfitPct: 5 });
    const state = enteredState(config);
    const cycleTime = NOW + 1_000;
    const result = runPaperCycle(
      state,
      [observation({ priceUsd: 1.1, observedAtMs: cycleTime })],
      cycleTime,
      config,
    );
    expect(result.state.positions).toHaveLength(0);
    expect(result.trades).toHaveLength(1);
    expect(result.entries[0].blockers).toContain("Token exited during this cycle");
  });

  it("closes all marked positions and blocks entries under the kill switch", () => {
    const config = permissiveConfig();
    const state = enteredState(config);
    const result = runPaperCycle(
      state,
      [observation({ observedAtMs: NOW + 1_000 })],
      NOW + 1_000,
      config,
      { killSwitch: true },
    );
    expect(result.automationBlocked).toBe(true);
    expect(result.state.positions).toHaveLength(0);
    expect(result.trades.at(-1)?.reason).toBe("kill_switch");
  });

  it("latches the daily loss, liquidates, and allows no new entry that day", () => {
    const config = permissiveConfig({
      entryNotionalUsd: 1_000,
      dailyLossLimitPct: 1,
      stopLossPct: 100,
      trailingStopPct: 100,
      exitLiquidityDrawdownPct: 100,
    });
    const state = enteredState(config);
    const lossTime = NOW + 1_000;
    const result = runPaperCycle(
      state,
      [observation({ priceUsd: 0.8, observedAtMs: lossTime })],
      lossTime,
      config,
    );
    expect(result.dailyLossTriggered).toBe(true);
    expect(result.automationBlocked).toBe(true);
    expect(result.state.dailyLossLockedDay).toBe("2026-08-21");
    expect(result.state.positions).toHaveLength(0);
    expect(result.trades.at(-1)?.reason).toBe("daily_loss");
  });
});

describe("manual partial closes and accounting", () => {
  it.each([25, 50, 100] as const)("closes exactly %s%% of the position", (percent) => {
    const config = permissiveConfig();
    const state = enteredState(config);
    const initialQuantity = state.positions[0].quantity;
    const closed = closePaperPosition(
      state,
      observation({ observedAtMs: NOW + 1_000 }),
      percent,
      NOW + 1_000,
      config,
    );
    if (percent === 100) {
      expect(closed.positions).toHaveLength(0);
    } else {
      expect(closed.positions[0].quantity).toBeCloseTo(initialQuantity * (1 - percent / 100), 12);
      expect(closed.positions[0].costBasisUsd).toBeCloseTo(100 * (1 - percent / 100), 12);
    }
  });

  it("charges buy and sell fees/impact and reconciles realized plus unrealized P&L", () => {
    const config = permissiveConfig({
      feeRateBps: 100,
      entryImpactMultiplier: 1,
      exitImpactMultiplier: 1,
      maxEntryImpactPct: 2,
    });
    const market = observation({}, { priceImpactPct: 1 });
    const initial = createPaperEngineState(10_000, NOW);
    const entered = enterPaperPosition(initial, market, NOW, config);
    expect(entered.cashUsd).toBe(9_900);
    expect(entered.trades[0].feeUsd).toBeCloseTo(1, 12);
    expect(entered.trades[0].fillPriceUsd).toBeCloseTo(1.01, 12);
    expect(entered.trades[0].impactCostUsd).toBeGreaterThan(0);

    const closeTime = NOW + 1_000;
    const rising = observation({ priceUsd: 1.2, observedAtMs: closeTime }, { priceImpactPct: 1 });
    const partiallyClosed = closePaperPosition(entered, rising, 25, closeTime, config);
    expect(partiallyClosed.positions[0].costBasisUsd).toBeCloseTo(75, 12);
    expect(partiallyClosed.realizedPnlUsd).toBeGreaterThan(0);
    expect(partiallyClosed.trades[1].feeUsd).toBeGreaterThan(0);
    expect(partiallyClosed.trades[1].impactCostUsd).toBeGreaterThan(0);

    const mark = markPaperPortfolio(partiallyClosed, [rising], config);
    expect(mark.totalPnlUsd).toBeCloseTo(mark.realizedPnlUsd + mark.unrealizedPnlUsd, 10);
    expect(mark.feesPaidUsd).toBeCloseTo(
      partiallyClosed.trades.reduce((total, trade) => total + trade.feeUsd, 0),
      12,
    );
  });

  it("does not mutate the caller's state", () => {
    const config = permissiveConfig();
    const state = createPaperEngineState(10_000, NOW);
    const before = structuredClone(state);
    const entered = enterPaperPosition(state, observation(), NOW, config);
    expect(state).toEqual(before);
    expect(entered).not.toBe(state);
    const beforeClose = structuredClone(entered);
    closePaperPosition(entered, observation({ observedAtMs: NOW + 1_000 }), 50, NOW + 1_000, config);
    expect(entered).toEqual(beforeClose);
  });
});
