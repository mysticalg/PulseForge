import { describe, expect, it } from "vitest";
import type { MarketToken } from "../types";
import { launchRunnerSettingsForBudget } from "./automationSettings";
import {
  defaultLiveTradingConfig,
  LIVE_ENTRY_SAFETY,
  hasFreshLiveMark,
  emptyLiveTradingStatus,
  planLiveIntent,
  type LiveOrder,
  type LivePosition,
  type LiveTradingStatus,
} from "./liveTrading";
import { createPaperEngineState, evaluatePaperEntry, type PaperMarketObservation } from "./paperEngine";
import { paperConfig } from "./paperRuntime";

const NOW = Date.UTC(2026, 8, 6, 12, 0);
const MINT = "MintA11111111111111111111111111111111111111";
const settings = launchRunnerSettingsForBudget(400, false);
const options = { mode: "live" as const };

describe("live displayed mark freshness", () => {
  it.each([undefined, 0, NOW - 75_001, NOW + 1, NaN])("does not value a position from an unverified or stale timestamp %s", (lastMarkAtMs) => {
    expect(hasFreshLiveMark(position({ lastMarkAtMs }), NOW)).toBe(false);
  });
  it("expires a mark as the display clock advances, without changing the position or ledger", () => {
    const held = position({ lastMarkAtMs: NOW });
    expect(hasFreshLiveMark(held, NOW + 75_000)).toBe(true);
    expect(hasFreshLiveMark(held, NOW + 75_001)).toBe(false);
    expect(held.quantityRaw).toBe("5000000");
    expect(held.costBasisUsd).toBe(5);
    expect(hasFreshLiveMark({ ...held, lastPriceUsd: NaN }, NOW)).toBe(false);
  });
});

function status(overrides: Partial<LiveTradingStatus> = {}): LiveTradingStatus {
  return { ...emptyLiveTradingStatus, available: true, armed: true, owner: "Owner111111111111111111111111111111111111111",
    blocker: null, config: { ...defaultLiveTradingConfig }, positions: [], recentOrders: [],
    entrySafety: Object.fromEntries([MINT, "BetterMint", "DifferentMint", "NewMint", "OtherMint"]
      .map(mint => [mint, { ready: true, blocker: null }])), ...overrides };
}

function observation(overrides: Partial<PaperMarketObservation> = {}, safety: Partial<MarketToken["safety"]> = {}): PaperMarketObservation {
  return {
    mint: MINT, symbol: "ALPHA", name: "Alpha", ageSeconds: 86_400, priceUsd: 1, change5mPct: 3,
    liquidityUsd: 250_000, volume5mUsd: 125_000, buyRatio: 0.65, buys5m: 20, sells5m: 10, traders5m: 25,
    organicBuyers5m: 8, organicScore: 75, riskLevel: "Medium", modelScore: 0.8,
    safety: { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, topTenHolderPct: 20,
      liquidityLocked: true, priceImpactPct: 0.2, transferTaxPct: 0, verified: true, ...safety },
    source: "test-live-provider", updatedAt: new Date(NOW).toISOString(), observedAtMs: NOW,
    shortMomentumPct: 1, shortMomentumWindowMs: 30_000, shortVolumeGrowthPct: 8, shortVolumeWindowMs: 30_000,
    launchPattern: "breakout", auditEligible: true, riskEligible: true, ...overrides,
  };
}

function position(overrides: Partial<LivePosition> = {}): LivePosition {
  return { id: "managed-position-1", mint: MINT, symbol: "ALPHA", quantityRaw: "5000000", decimals: 6,
    entryPriceUsd: 1, costBasisUsd: 5, openedAtMs: NOW - 120_000, highWaterPriceUsd: 1, lastPriceUsd: 1,
    entryLiquidityUsd: 10_000, ...overrides };
}

function order(overrides: Partial<LiveOrder> = {}): LiveOrder {
  return { id: "previous-order", side: "BUY", mint: MINT, symbol: "ALPHA", status: "Confirmed",
    signature: "signature", amountUsd: 5, detail: null, createdAtMs: NOW - 10_000, ...overrides };
}

describe("live intent authorization and isolation", () => {
  it("binds proposed orders to the exact native session generation", () => {
    expect(planLiveIntent(status({ sessionGeneration: 37 }), [observation()], settings, NOW, options).request?.sessionGeneration).toBe(37);
    expect(planLiveIntent(status({ sessionGeneration: NaN }), [observation()], settings, NOW, options).request).toBeNull();
  });
  it("requires an available, armed native wallet and a real market feed", () => {
    expect(planLiveIntent(status({ available: false }), [observation()], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(status({ armed: false }), [observation()], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(status({ owner: null }), [observation()], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(status(), [observation()], settings, NOW, { mode: "demo" }).request).toBeNull();
  });

  it("does not use paper automation or paper cash limits to authorize or size live entries", () => {
    const plan = planLiveIntent(status(), [observation()],
      { ...settings, enabled: false, portfolioBudgetUsd: 100_000, reserveUsd: 100_000, maxAllocationPerTokenPct: 0 }, NOW, options);
    expect(plan.request).toMatchObject({ side: "BUY", amountUsd: 5 });
  });

  it("returns only an intent without mutating the ledger or input observations", () => {
    const ledger = status();
    const observations = [observation()];
    const before = JSON.stringify({ ledger, observations });
    const first = planLiveIntent(ledger, observations, settings, NOW, options);
    const second = planLiveIntent(ledger, observations, settings, NOW + 1_000, options);
    expect(first.request?.intentId).toBe(second.request?.intentId);
    expect(first.request?.signalAtMs).toBe(NOW);
    expect(JSON.stringify({ ledger, observations })).toBe(before);
    expect(ledger.positions).toHaveLength(0);
    expect(ledger.recentOrders).toHaveLength(0);
  });

  it("blocks all new intents while any order is pending or its state is unknown", () => {
    for (const ledger of [status({ pendingCount: 1 }), status({ recentOrders: [order({ status: "Submitted" })] }),
      status({ recentOrders: [order({ status: "Unknown" })] })]) {
      expect(planLiveIntent(ledger, [observation()], settings, NOW, options).request).toBeNull();
      expect(planLiveIntent({ ...ledger, positions: [position()] }, [observation({ priceUsd: 0.8 })], settings, NOW, options).request).toBeNull();
    }
  });

  it("never reuses an already journaled intent, even after its failure cooldown", () => {
    const request = planLiveIntent(status(), [observation()], settings, NOW, options).request!;
    const ledger = status({ recentOrders: [order({ id: request.intentId, status: "Failed", createdAtMs: NOW - 31_000 })] });
    expect(planLiveIntent(ledger, [observation()], settings, NOW, options).request).toBeNull();
    const refreshed = observation({ updatedAt: new Date(NOW + 1_000).toISOString(), observedAtMs: NOW + 1_000 });
    expect(planLiveIntent(ledger, [refreshed], settings, NOW + 1_000, options).request?.intentId).not.toBe(request.intentId);
  });
});

describe("live entry limits and strategy gates", () => {
  it("caps each entry by both per-order spend and remaining native daily allowance", () => {
    const config = { ...defaultLiveTradingConfig, maxOrderUsd: 10 };
    expect(planLiveIntent(status({ config }), [observation()], settings, NOW, options).request?.amountUsd).toBe(10);
    expect(planLiveIntent(status({ config, dailyBuyUsedUsd: 18.75 }), [observation()], settings, NOW, options).request?.amountUsd).toBe(6.25);
    expect(planLiveIntent(status({ config, dailyBuyUsedUsd: 24.01 }), [observation()], settings, NOW, options).request).toBeNull();
  });

  it("honors native $1–$4 limits independently of the $5 paper minimum", () => {
    for (const maxOrderUsd of [1, 2, 3, 4]) {
      expect(planLiveIntent(status({ config: { ...defaultLiveTradingConfig, maxOrderUsd } }), [observation()],
        settings, NOW, options).request?.amountUsd).toBe(maxOrderUsd);
    }
    expect(planLiveIntent(status({ dailyBuyUsedUsd: 23.75 }), [observation()], settings, NOW, options).request?.amountUsd).toBe(1.25);
  });

  it("reduces a larger order to satisfy the real-mode impact sizing cap", () => {
    const config = { ...defaultLiveTradingConfig, maxOrderUsd: 25, maxPriceImpactPct: 2 };
    const plan = planLiveIntent(status({ config }), [observation({}, { priceImpactPct: 10 })],
      { ...settings, maxPriceImpactPct: 2 }, NOW, options);
    expect(plan.request?.amountUsd).toBe(10);
  });

  it("requires a separate native high-risk opt-in even when the paper preset allows it", () => {
    const high = observation({ riskLevel: "High", riskEligible: false });
    expect(settings.allowHighRiskPaperEntries).toBe(true);
    expect(planLiveIntent(status(), [high], settings, NOW, options).request).toBeNull();
    const optedIn = status({ config: { ...defaultLiveTradingConfig, allowHighRisk: true } });
    expect(planLiveIntent(optedIn, [high], settings, NOW, options).request?.side).toBe("BUY");
    expect(planLiveIntent(optedIn, [observation({ riskLevel: "High", riskEligible: false }, { freezeAuthorityRevoked: false })],
      settings, NOW, options).request).toBeNull();
  });

  it("retains a minimum age, pattern, flow and mint-safety gates", () => {
    const invalid = [observation({ ageSeconds: 10 }), observation({ ageSeconds: 3_000 }),
      observation({ launchPattern: null }), observation({ buyRatio: 1 }), observation({ shortVolumeGrowthPct: null }),
      observation({}, { mintAuthorityRevoked: false }), observation({}, { transferTaxUnknown: true, transferTaxPct: 0 })];
    for (const candidate of invalid) expect(planLiveIntent(status(), [candidate], settings, NOW, options).request).toBeNull();
  });

  it("requires fresh provider and receipt timestamps and excludes future marks", () => {
    const invalid = [observation({ updatedAt: new Date(NOW - 75_001).toISOString() }),
      observation({ observedAtMs: NOW - 75_001 }), observation({ updatedAt: new Date(NOW + 1).toISOString() }),
      observation({ observedAtMs: NOW + 1 }), observation({ updatedAt: "invalid" }), observation({ priceUsd: NaN })];
    for (const candidate of invalid) expect(planLiveIntent(status(), [candidate], settings, NOW, options).request).toBeNull();
  });

  it("uses the newest provider observation per mint and shared launch ranking", () => {
    const staleBad = observation({ buyRatio: 1, updatedAt: new Date(NOW - 1_000).toISOString() });
    const better = observation({ mint: "BetterMint", symbol: "BETTER", shortVolumeGrowthPct: 20 });
    expect(planLiveIntent(status(), [observation(), staleBad], settings, NOW, options).request?.side).toBe("BUY");
    expect(planLiveIntent(status(), [observation(), better], settings, NOW, options).request?.mint).toBe("BetterMint");
  });

  it("blocks duplicate holdings, position caps, loss limits and paused entries", () => {
    expect(planLiveIntent(status({ positions: [position()] }), [observation()], settings, NOW, options).request).toBeNull();
    const full = status({ positions: [position(), position({ id: "two", mint: "OtherMint" })] });
    expect(planLiveIntent(full, [observation(), observation({ mint: "OtherMint" }), observation({ mint: "NewMint" })], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(status({ dailyRealizedPnlUsd: -10 }), [observation()], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(status(), [observation()], settings, NOW, { ...options, pauseEntries: true }).request).toBeNull();
  });

  it("applies confirmed entry spacing, mint cooldowns and failure backoff", () => {
    expect(planLiveIntent(status({ recentOrders: [order({ mint: "OtherMint" })] }), [observation()], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(status({ recentOrders: [order({ side: "SELL", createdAtMs: NOW - 4 * 60_000 })] }), [observation()], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(status({ recentOrders: [order({ side: "SELL", reason: "momentum_reversal", createdAtMs: NOW - 10 * 60_000 })] }), [observation()], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(status({ recentOrders: [order({ status: "Failed", createdAtMs: NOW - 29_000 })] }), [observation()], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(status({ recentOrders: [order({ status: "Failed", createdAtMs: NOW - 30_000 })] }), [observation()], settings, NOW, options).request?.side).toBe("BUY");
  });
});

describe("stricter automatic live discovery", () => {
  it("allows a $20,000 pool with the configured minimum, native readiness and a qualifying signal", () => {
    const candidate = observation({ liquidityUsd: 20_000, volume5mUsd: 10_000 },
      { priceImpactPct: Math.sqrt(250 / 20_000) * 20 });
    const ledger = status({ config: { ...defaultLiveTradingConfig, minLiquidityUsd: 20_000 } });
    const capturedSettings = { ...settings, minLiquidityUsd: 20_000 };

    expect(defaultLiveTradingConfig.minLiquidityUsd).toBe(20_000);
    expect(planLiveIntent(ledger, [candidate], capturedSettings, NOW, options).request)
      .toMatchObject({ side: "BUY", mint: MINT, amountUsd: 5 });
    const belowMinimum = planLiveIntent(ledger, [{ ...candidate, liquidityUsd: 19_999 }],
      capturedSettings, NOW, options);
    expect(belowMinimum.request).toBeNull();
    expect(belowMinimum.message).toContain("Liquidity is below $20000");

    const stricterLive = planLiveIntent({ ...ledger, config: { ...ledger.config, minLiquidityUsd: 250_000 } },
      [candidate], capturedSettings, NOW, options);
    expect(stricterLive.request).toBeNull();
    expect(stricterLive.message).toContain("Liquidity is below $250000");
    const stricterPaper = planLiveIntent(ledger, [candidate],
      { ...capturedSettings, minLiquidityUsd: 250_000 }, NOW, options);
    expect(stricterPaper.request).toBeNull();
    expect(stricterPaper.message).toContain("Liquidity is below $250000");
  });

  it.each<LiveTradingStatus["entrySafety"]>([undefined, {}, { [MINT]: { ready: false, blocker: null } }])
    ("fails closed when native entry safety is absent or unready: %j", (entrySafety) => {
      const plan = planLiveIntent(status({ entrySafety }), [observation()], settings, NOW, options);
      expect(plan.request).toBeNull();
      expect(plan.message).toContain("Native entry safety");
    });

  it("shows the native history blocker and requires readiness for the exact mint", () => {
    const entrySafety = { [MINT]: { ready: false, blocker: "Observing liquidity stability (120/300 seconds)" } };
    const plan = planLiveIntent(status({ entrySafety }), [observation()], settings, NOW, options);
    expect(plan.request).toBeNull();
    expect(plan.message).toContain("Observing liquidity stability (120/300 seconds)");
    const otherMint = status({ entrySafety: { DifferentMint: { ready: true, blocker: null } } });
    expect(planLiveIntent(otherMint, [observation()], settings, NOW, options).request).toBeNull();
  });

  it.each([
    [observation({ ageSeconds: LIVE_ENTRY_SAFETY.minPoolAgeSeconds - 1 }), "Pool age"],
    [observation({ ageSeconds: NaN }), "Pool age"],
    [observation({ liquidityUsd: LIVE_ENTRY_SAFETY.minLiquidityUsd - 1 }), "Liquidity"],
    [observation({}, { topTenHolderPct: LIVE_ENTRY_SAFETY.maxTopTenHolderPct + 0.01 }), "Top-holder"],
    [observation({}, { topTenHolderPct: NaN }), "Top-holder"],
    [observation({ traders5m: LIVE_ENTRY_SAFETY.minTraders5m - 1 }), "5m trader count"],
    [observation({ traders5m: undefined }), "5m trader count"],
    [observation({ sells5m: LIVE_ENTRY_SAFETY.minSells5m - 1 }), "5m sell count"],
    [observation({ sells5m: undefined }), "5m sell count"],
  ] as const)("keeps mandatory candidate floors even with native readiness: %j", (candidate, blocker) => {
    for (const entrySafety of [status().entrySafety, undefined]) {
      const ledger = status({ config: { ...defaultLiveTradingConfig, minLiquidityUsd: 2_000, allowHighRisk: true }, entrySafety });
      const plan = planLiveIntent(ledger, [candidate], settings, NOW, options);
      expect(plan.request).toBeNull();
      expect(plan.message).toContain(blocker);
    }
  });

  it("preserves stricter configured liquidity, participant and minimum-age thresholds", () => {
    expect(planLiveIntent(status({ config: { ...defaultLiveTradingConfig, minLiquidityUsd: 300_000 } }),
      [observation()], settings, NOW, options).message).toContain("Liquidity is below $300000");
    expect(planLiveIntent(status(), [observation()], { ...settings, minLiquidityUsd: 400_000 }, NOW, options)
      .message).toContain("Liquidity is below $400000");
    expect(planLiveIntent(status(), [observation()], { ...settings, minTraders5m: 50 }, NOW, options)
      .message).toContain("5m trader count");
    expect(planLiveIntent(status(), [observation()], { ...settings, minTokenAgeMinutes: 2_880 }, NOW, options)
      .message).toContain("at least 48 hours");
  });

  it.each([45, 60])("replaces the %i-minute launch maximum only for live entries", (maxTokenAgeMinutes) => {
    const capturedSettings = { ...settings, maxTokenAgeMinutes };
    const before = JSON.stringify(capturedSettings);
    const mature = observation({ ageSeconds: 7 * 86_400 });
    const paperState = createPaperEngineState(400, NOW);
    const paperBefore = paperConfig(capturedSettings, paperState);
    expect(evaluatePaperEntry(paperState, mature, NOW, paperBefore).blockers)
      .toContain(`Pool age is outside ${capturedSettings.minTokenAgeMinutes * 60}-${maxTokenAgeMinutes * 60} seconds`);
    expect(planLiveIntent(status(), [mature], capturedSettings, NOW, options).request?.side).toBe("BUY");
    expect(JSON.stringify(capturedSettings)).toBe(before);
    expect(paperConfig(capturedSettings, paperState)).toEqual(paperBefore);
  });

  it.each<LiveTradingStatus["entrySafety"]>([undefined, {}, { [MINT]: { ready: false, blocker: "Liquidity history is warming up" } }])
    ("preserves exits from young illiquid concentrated holdings without entry readiness: %j", (entrySafety) => {
      const ledger = status({ positions: [position()], entrySafety });
      const riskyHeld = observation({ ageSeconds: 180, liquidityUsd: 10_000, priceUsd: 0.8, traders5m: 1, sells5m: 0 },
        { topTenHolderPct: 99 });
      expect(planLiveIntent(ledger, [riskyHeld], settings, NOW, options).request)
        .toMatchObject({ side: "SELL", reason: "stop_loss", positionId: "managed-position-1" });
    });
});

describe("confirmed live position exits", () => {
  it("prioritizes exits over entries, paused entries, daily spend and realized loss limits", () => {
    const ledger = status({ positions: [position()], dailyBuyUsedUsd: 25, dailyRealizedPnlUsd: -10 });
    const plan = planLiveIntent(ledger, [observation({ mint: "NewMint" }), observation({ shortMomentumPct: -3 })],
      settings, NOW, { ...options, pauseEntries: true });
    expect(plan.request).toMatchObject({ side: "SELL", positionId: "managed-position-1", mint: MINT, reason: "momentum_reversal" });
    expect(plan.request?.amountUsd).toBeUndefined();
    expect(ledger.positions).toHaveLength(1);
  });

  it("uses confirmed cost basis and actual quantity, without adding simulated exit fees or impact", () => {
    const ledger = status({ positions: [position()] });
    expect(planLiveIntent(ledger, [observation({ priceUsd: 0.96 }, { priceImpactPct: 99 })], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(ledger, [observation({ priceUsd: 0.94 }, { priceImpactPct: NaN })], settings, NOW, options).request?.reason).toBe("stop_loss");
  });

  it("uses the native high-water mark for trailing stops", () => {
    const ledger = status({ positions: [position({ highWaterPriceUsd: 1.5 })] });
    expect(planLiveIntent(ledger, [observation({ priceUsd: 1.3 })], settings, NOW, options).request?.reason).toBe("trailing_stop");
  });

  it("uses an actual entry liquidity baseline when available", () => {
    const market = observation({ liquidityUsd: 8_000 });
    expect(planLiveIntent(status({ positions: [position()] }), [market], settings, NOW, options).request?.reason).toBe("liquidity_drawdown");
    expect(planLiveIntent(status({ positions: [position({ entryLiquidityUsd: undefined })] }), [market], settings, NOW, options).request).toBeNull();
  });

  it("does not invent stale exit marks or sell unrelated observed tokens", () => {
    expect(planLiveIntent(status({ positions: [position()] }), [observation({ updatedAt: new Date(NOW - 80_000).toISOString(), priceUsd: 0.5 })],
      settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(status(), [observation({ priceUsd: 0.5, shortMomentumPct: -10 })], settings, NOW, options).request).toBeNull();
  });

  it("backs failed exits off for 15 seconds without marking the position closed", () => {
    const ledger = status({ positions: [position()], recentOrders: [order({ side: "SELL", status: "Failed", createdAtMs: NOW - 14_999 })] });
    expect(planLiveIntent(ledger, [observation({ priceUsd: 0.8 })], settings, NOW, options).request).toBeNull();
    ledger.recentOrders[0].createdAtMs = NOW - 15_000;
    expect(planLiveIntent(ledger, [observation({ priceUsd: 0.8 })], settings, NOW, options).request?.side).toBe("SELL");
    expect(ledger.positions).toHaveLength(1);
  });

  it("rejects malformed native quantities and configuration instead of proposing trades", () => {
    for (const quantityRaw of ["-1", "1.5", "1e6", "18446744073709551616", "0"]) {
      expect(planLiveIntent(status({ positions: [position({ quantityRaw })] }), [observation({ priceUsd: 0.8 })], settings, NOW, options).request).toBeNull();
    }
    expect(planLiveIntent(status({ config: { ...defaultLiveTradingConfig, maxOrderUsd: NaN } }), [observation()], settings, NOW, options).request).toBeNull();
  });
});


describe("quarantined live holdings", () => {
  const quarantined = { position: position(), quarantinedAtMs: NOW, riskLossUsd: 5.6 };
  it("allows an unrelated eligible mint while excluding the quarantined mint", () => {
    const ledger = status({ quarantinedPositions: [quarantined], dailyQuarantineLossUsd: 5.6 });
    expect(planLiveIntent(ledger, [observation()], settings, NOW, options).request).toBeNull();
    expect(planLiveIntent(ledger, [observation({ mint: "DifferentMint" })], settings, NOW, options).request).toMatchObject({ side: "BUY", mint: "DifferentMint" });
  });
  it("counts risk losses against the daily cap without changing realized P&L or buy usage", () => {
    const ledger = status({ quarantinedPositions: [quarantined], dailyQuarantineLossUsd: 5.6, dailyRealizedPnlUsd: -5 });
    const before = JSON.stringify(ledger);
    expect(planLiveIntent(ledger, [observation({ mint: "DifferentMint" })], settings, NOW, options).message).toContain("daily loss limit");
    expect(JSON.stringify(ledger)).toBe(before);
  });
  it("continues managed exits after a quarantine risk loss exhausts the entry limit", () => {
    const ledger = status({ quarantinedPositions: [{...quarantined, position: position({mint: "OldMint"})}], dailyQuarantineLossUsd: 20, positions: [position()] });
    expect(planLiveIntent(ledger, [observation({priceUsd: 0.5})], settings, NOW, options).request).toMatchObject({side: "SELL"});
  });
});


describe("live exit recovery", () => {
  it("retries a failed close without a price using a new intent and the persisted deadline", () => {
    const held = position();
    const failed = order({id:"old-exit", side:"SELL", status:"Failed",reason:"take_profit",createdAtMs:NOW-30_000,signature:null});
    const ledger = status({positions:[held],recentOrders:[],exitAttempts:{[held.id]:{order:failed,retryAfterMs:NOW}}});
    const before=JSON.stringify(ledger);
    const retry=planLiveIntent(ledger,[],settings,NOW,options);
    expect(retry.request).toMatchObject({side:"SELL",reason:"take_profit",signalAtMs:NOW,positionId:held.id});
    expect(retry.request?.intentId).not.toBe(failed.id);
    expect(planLiveIntent(ledger,[],settings,NOW-1,options).request).toBeNull();
    expect(JSON.stringify(ledger)).toBe(before);
  });
  it("never retries an unresolved signed transaction", () => {
    const held=position();
    const unknown=order({side:"SELL",status:"Unknown",createdAtMs:NOW-60_000});
    expect(planLiveIntent(status({positions:[held],pendingCount:1,exitAttempts:{[held.id]:{order:unknown,retryAfterMs:NOW-1}}}),[],settings,NOW,options).request).toBeNull();
  });
  it("uses max hold as a clock deadline even if discovery is down, without inventing prices", () => {
    const held=position({openedAtMs:NOW-180_000});
    expect(planLiveIntent(status({positions:[held]}),[],{...settings,maxHoldMinutes:2},NOW,{mode:"demo"}).request).toMatchObject({side:"SELL",reason:"max_hold",signalAtMs:NOW});
  });
  it("does not evaluate a profit against a provider price from before the buy confirmed", () => {
    const held=position({openedAtMs:NOW-2_000});
    const old=observation({priceUsd:2,updatedAt:new Date(NOW-3_000).toISOString()});
    expect(planLiveIntent(status({positions:[held]}),[old],settings,NOW,options).request).toBeNull();
  });
  it("does not latch a failed close from an earlier holding of the same mint", () => {
    const held=position({openedAtMs:NOW-1_000});
    const old=order({side:"SELL",status:"Failed",createdAtMs:NOW-20_000});
    expect(planLiveIntent(status({positions:[held],recentOrders:[old]}),[],settings,NOW,options).request).toBeNull();
  });
});
