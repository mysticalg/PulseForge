import { describe, expect, it } from "vitest";
import { launchFlowSettingsForBudget } from "./automationSettings";
import { capturePaperEntryCriteria, defaultLiveTradingConfig, emptyLiveTradingStatus,
  type LiveOrder, type LivePosition, type LiveTradingStatus } from "./liveTrading";
import type { PaperEngineTrade, PaperMarketObservation } from "./paperEngine";
import { createLivePaperFollowSession, detachLivePaperPosition, discardQueuedLivePaperBuys, ingestLivePaperTrades,
  markLivePaperRequestSubmitted, planLivePaperFollow, resetLivePaperFollow, type LivePaperFollowSession } from "./livePaperFollow";

const NOW = Date.UTC(2026, 8, 7, 12);
const settings = launchFlowSettingsForBudget(400, true);
const options = { mode: "live" as const };
const MINT = "YoungMint";

function status(overrides: Partial<LiveTradingStatus> = {}): LiveTradingStatus {
  return { ...emptyLiveTradingStatus, available: true, armed: true, owner: "WalletA", sessionGeneration: 3,
    config: { ...defaultLiveTradingConfig, minLiquidityUsd: 5_000, entryMode: "paperSignals",
      paperEntryCriteria: capturePaperEntryCriteria(settings) },
    entrySafety: { [MINT]: { ready: true, blocker: null } }, ...overrides };
}
function trade(overrides: Partial<PaperEngineTrade> = {}): PaperEngineTrade {
  return { id: "paper-10", mint: MINT, symbol: "YOUNG", side: "BUY", reason: "automatic_launch_flow",
    timestampMs: NOW, quantity: 10, midPriceUsd: 1, fillPriceUsd: 1, notionalUsd: 10, feeUsd: 0.1,
    impactCostUsd: 0.1, cashFlowUsd: -10.2, realizedPnlUsd: 0, ...overrides };
}
function market(overrides: Partial<PaperMarketObservation> = {}): PaperMarketObservation {
  return { mint: MINT, symbol: "YOUNG", name: "Young token", ageSeconds: 120, priceUsd: 1,
    liquidityUsd: 12_542, volume5mUsd: 6_000, buyRatio: 0.6, change5mPct: 3, buys5m: 10,
    sells5m: 2, traders5m: 10, organicBuyers5m: 3, organicScore: 50, riskLevel: "Medium", modelScore: 0.8,
    safety: { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, topTenHolderPct: 30,
      priceImpactPct: 0.1, transferTaxPct: 0, verified: false, liquidityLocked: null }, updatedAt: new Date(NOW).toISOString(),
    observedAtMs: NOW, source: "native-provider", ...overrides };
}
function session(ledger = status()): LivePaperFollowSession {
  return createLivePaperFollowSession(ledger, NOW, 10, "session-uuid-1234")!;
}
function queued(ledger = status()): LivePaperFollowSession {
  return ingestLivePaperTrades(session(ledger), ledger, [trade()], NOW, options);
}
function plan(follower = queued(), ledger = status(), nowMs = NOW, observations = [market()]) {
  return planLivePaperFollow(follower, ledger, observations, settings, nowMs, options);
}
function held(id: string, overrides: Partial<LivePosition> = {}): LivePosition {
  return { id, mint: MINT, symbol: "YOUNG", quantityRaw: "5000000", decimals: 6, entryPriceUsd: 1,
    costBasisUsd: 5, openedAtMs: NOW, highWaterPriceUsd: 1, lastPriceUsd: 1, lastMarkAtMs: NOW,
    entryLiquidityUsd: 12_542, ...overrides };
}
function order(id: string, overrides: Partial<LiveOrder> = {}): LiveOrder {
  return { id, side: "BUY", mint: MINT, symbol: "YOUNG", status: "Confirmed", signature: "sig",
    amountUsd: 5, detail: null, createdAtMs: NOW, ...overrides };
}

describe("paper signal entry identity and authorization", () => {
  it("follows the actual young paper entry at the live size without running a second strategy", () => {
    const result = plan();
    expect(result.request).toMatchObject({ side: "BUY", mint: MINT, amountUsd: 5,
      reason: "automatic_launch_flow", signalAtMs: NOW, sessionGeneration: 3 });
    // The fixture has no short-momentum/pattern values and fails the old mature floors.
    expect(result.request!.intentId.length).toBeLessThanOrEqual(128);
    expect(plan().request!.intentId).toBe(result.request!.intentId);
  });
  it("never buys a scanner candidate without a new paper trade", () => {
    expect(plan(session()).request).toBeNull();
  });
  it("uses both live allowance and live order limits, independently of paper spend", () => {
    expect(plan(queued(), status({ dailyBuyUsedUsd: 23.75 })).request?.amountUsd).toBe(1.25);
    expect(plan(queued(), status({ dailyBuyUsedUsd: 24.01 })).request).toBeNull();
    expect(plan(queued(), status({ config: { ...status().config, maxOrderUsd: 2 } })).request?.amountUsd).toBe(2);
  });
  it("does not replay prior ledger rows, manual orders, writeoffs or demo events", () => {
    for (const event of [trade({ id: "paper-9" }), trade({ reason: "manual_entry" }),
      trade({ timestampMs: NOW - 1 }), trade({ side: "SELL", reason: "illiquid_writeoff" })]) {
      expect(plan(ingestLivePaperTrades(session(), status(), [event], NOW, options)).request).toBeNull();
    }
    expect(plan(ingestLivePaperTrades(session(), status(), [trade()], NOW, { mode: "demo" })).request).toBeNull();
  });
  it("consumes duplicate events once and marks dispatch before transport completion", () => {
    const first = queued();
    const repeated = ingestLivePaperTrades(first, status(), [trade()], NOW, options);
    expect(repeated.entries).toHaveLength(1);
    const submitted = markLivePaperRequestSubmitted(repeated, plan(repeated).request!);
    expect(plan(submitted).request).toBeNull();
    expect(ingestLivePaperTrades(submitted, status(), [trade()], NOW, options).entries).toHaveLength(1);
  });
  it("fences owner, mode, generation and stop changes", () => {
    for (const ledger of [status({ owner: "OtherWallet" }), status({ sessionGeneration: 4 }), status({ armed: false }),
      status({ config: { ...status().config, entryMode: "guardedDiscovery" } })]) {
      expect(plan(queued(), ledger).request).toBeNull();
      expect(plan(queued(), ledger).session.entries).toHaveLength(0);
    }
  });
  it("discards paused buys rather than replaying them on resume", () => {
    const paused = planLivePaperFollow(queued(), status(), [market()], settings, NOW, { ...options, pauseEntries: true });
    expect(plan(paused.session).request).toBeNull();
    const duringPause = ingestLivePaperTrades(session(), status(), [trade()], NOW, { ...options, pauseEntries: true });
    expect(plan(duringPause).request).toBeNull();
    expect(discardQueuedLivePaperBuys(queued()).entries).toHaveLength(0);
  });
  it("changes identity on paper reset, without replaying unsubmitted prior events", () => {
    const firstId = plan().request!.intentId;
    const reset = resetLivePaperFollow(queued(), 1);
    expect(reset.entries).toHaveLength(0);
    const next = ingestLivePaperTrades(reset, status(), [trade({ id: "paper-1" })], NOW, options);
    expect(plan(next).request!.intentId).not.toBe(firstId);
  });
  it("bounds session memory while deduplicating retired events with a sequence watermark", () => {
    const events = Array.from({ length: 300 }, (_, i) => trade({ id: `paper-${i + 10}`, mint: `mint-${i}` }));
    const full = ingestLivePaperTrades(session(), status(), events, NOW, options);
    expect(full.entries).toHaveLength(256);
    const cleared = discardQueuedLivePaperBuys(full);
    expect(ingestLivePaperTrades(cleared, status(), events, NOW, options).entries).toHaveLength(0);
  });
  it("requires a valid available armed paper session and fresh nonfuture event clock", () => {
    expect(createLivePaperFollowSession(status({ armed: false }), NOW, 10)).toBeNull();
    expect(createLivePaperFollowSession(status(), NOW, 10, "bad / nonce")).toBeNull();
    expect(plan(ingestLivePaperTrades(session(), status(), [trade({ timestampMs: NOW + 1 })], NOW, options)).request).toBeNull();
  });
});

describe("paper live entry checks and waiting", () => {
  it("still enforces the chosen $20,000 floor and native mint readiness", () => {
    expect(plan(queued(), status({ config: { ...status().config, minLiquidityUsd: 20_000 } })).request).toBeNull();
    expect(plan(queued(), status({ entrySafety: {} })).request).toBeNull();
    const unsafe = market(); unsafe.safety.freezeAuthorityRevoked = false;
    expect(plan(queued(), status(), NOW, [unsafe]).request).toBeNull();
  });
  it("still applies exposure, quarantine, daily-loss and elevated-risk limits", () => {
    for (const ledger of [status({ dailyRealizedPnlUsd: -10 }), status({ config: { ...status().config, maxOpenPositions: 0 } }),
      status({ quarantinedPositions: [{ position: held("old"), quarantinedAtMs: NOW, riskLossUsd: 5 }] })]) {
      expect(plan(queued(), ledger).request).toBeNull();
    }
    expect(plan(queued(), status(), NOW, [market({ riskLevel: "High" })]).request).toBeNull();
  });
  it("waits for unresolved orders without extending original buy freshness", () => {
    const pending = status({ pendingCount: 1, recentOrders: [order("other", { status: "Unknown" })] });
    const waiting = plan(queued(), pending);
    expect(waiting.request).toBeNull();
    expect(waiting.session.entries).toHaveLength(1);
    const expired = plan(waiting.session, pending, NOW + 75_001);
    expect(expired.session.entries).toHaveLength(0);
    expect(plan(expired.session, status(), NOW + 75_001).message).toContain("expired");
  });
  it("consumes native failure permanently and retains the useful failure explanation", () => {
    const request = plan().request!;
    const submitted = markLivePaperRequestSubmitted(queued(), request);
    const failed = plan(submitted, status({ recentOrders: [order(request.intentId, { status: "Failed", detail: "No sell route" })] }));
    expect(failed.request).toBeNull();
    expect(failed.session.entries).toHaveLength(0);
    expect(plan(failed.session).message).toContain("No sell route");
  });
});

describe("paper closes and delayed native confirmations", () => {
  const close = trade({ id: "paper-11", side: "SELL", reason: "take_profit" });
  function submittedAndClosed() {
    const request = plan().request!;
    const submitted = markLivePaperRequestSubmitted(queued(), request);
    return { request, follower: ingestLivePaperTrades(submitted, status(), [close], NOW, options) };
  }
  it("cancels a buy when paper has already closed before dispatch", () => {
    const closed = ingestLivePaperTrades(queued(), status(), [close], NOW, options);
    expect(plan(closed).request).toBeNull();
    expect(closed.entries).toHaveLength(0);
  });
  it("retains a close through unknown buy state and sells exact position after late confirmation", () => {
    const { request, follower } = submittedAndClosed();
    const pending = status({ pendingCount: 1, recentOrders: [order(request.intentId, { status: "Unknown" })] });
    const waiting = plan(follower, pending, NOW + 80_000, []);
    expect(waiting.request).toBeNull();
    expect(waiting.session.entries).toHaveLength(1);
    const confirmed = status({ positions: [held(request.intentId)], recentOrders: [order(request.intentId)] });
    const closing = plan(waiting.session, confirmed, NOW + 80_000, []);
    expect(closing.request).toMatchObject({ side: "SELL", positionId: request.intentId, mint: MINT,
      reason: "take_profit", signalAtMs: NOW + 80_000 });
    expect(closing.request?.amountUsd).toBeUndefined();
  });
  it("never sells another position merely because its mint matches", () => {
    const { follower } = submittedAndClosed();
    expect(plan(follower, status({ positions: [held("different-episode")] })).request).toBeNull();
  });
  it("keeps closes active despite paused entries, liquidity, daily caps and no scanner mark", () => {
    const { request, follower } = submittedAndClosed();
    const ledger = status({ positions: [held(request.intentId)], dailyRealizedPnlUsd: -100, dailyBuyUsedUsd: 25,
      config: { ...status().config, minLiquidityUsd: 250_000 }, entrySafety: {} });
    expect(planLivePaperFollow(follower, ledger, [], settings, NOW + 1_000, { ...options, pauseEntries: true }).request)
      .toMatchObject({ side: "SELL", positionId: request.intentId });
  });
  it("ignores manual closes, writeoffs and automatic exits without a followed entry", () => {
    const request = plan().request!;
    const submitted = markLivePaperRequestSubmitted(queued(), request);
    const ledger = status({ positions: [held(request.intentId)] });
    for (const reason of ["manual_100", "illiquid_writeoff"] as const) {
      expect(plan(ingestLivePaperTrades(submitted, ledger, [{ ...close, reason }], NOW, options), ledger).request).toBeNull();
    }
    expect(plan(ingestLivePaperTrades(session(), ledger, [close], NOW, options), ledger).request).toBeNull();
  });
  it("does not duplicate dispatched exits and respects native retry backoff", () => {
    const { request, follower } = submittedAndClosed();
    const ledger = status({ positions: [held(request.intentId)] });
    const exit = plan(follower, ledger);
    const dispatched = markLivePaperRequestSubmitted(exit.session, exit.request!);
    expect(plan(dispatched, ledger).request).toBeNull();
    const attempt = order(exit.request!.intentId, { side: "SELL", status: "Failed", reason: "take_profit" });
    const failed = { ...ledger, exitAttempts: { [request.intentId]: { order: attempt, retryAfterMs: NOW + 120_000 } } };
    expect(plan(dispatched, failed, NOW + 119_999, []).request).toBeNull();
    expect(plan(dispatched, failed, NOW + 120_000, []).request?.side).toBe("SELL");
  });
  it("paper reset preserves an already submitted close but never closes an open position by itself", () => {
    const { request, follower } = submittedAndClosed();
    const ledger = status({ positions: [held(request.intentId)] });
    expect(plan(resetLivePaperFollow(follower, 1), ledger).request?.side).toBe("SELL");
    const open = markLivePaperRequestSubmitted(queued(), request);
    expect(plan(resetLivePaperFollow(open, 1), ledger).request).toBeNull();
  });
  it("a manual full paper close detaches its episode so a later paper exit cannot sell the old live position", () => {
    const request = plan().request!;
    const open = markLivePaperRequestSubmitted(queued(), request);
    const detached = detachLivePaperPosition(open, MINT);
    const ledger = status({ positions: [held(request.intentId)] });
    const newEpisode = [trade({ id: "paper-12", reason: "manual_entry" }), { ...close, id: "paper-13" }];
    expect(plan(ingestLivePaperTrades(detached, ledger, newEpisode, NOW, options), ledger).request).toBeNull();
    expect(detachLivePaperPosition(queued(), MINT).entries).toHaveLength(0);
    const alreadyClosed = submittedAndClosed();
    expect(plan(detachLivePaperPosition(alreadyClosed.follower, MINT), ledger).request?.side).toBe("SELL");
  });
});
