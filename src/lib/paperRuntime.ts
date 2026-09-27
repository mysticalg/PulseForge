import type { MarketToken } from "../types";
import type { PaperAutomationSettings } from "./automationSettings";
import { classifyLaunchPattern, type LaunchPatternPoint, type LaunchPatternResult } from "./launchPatterns";
import {
  mergePaperEngineConfig,
  type PaperEngineConfig,
  type PaperEngineState,
  type PaperMarketObservation,
} from "./paperEngine";

type MomentumPoint = LaunchPatternPoint;

export interface PaperMomentumTracker {
  pointsByMint: Map<string, MomentumPoint[]>;
}

const SHORT_MOMENTUM_TARGET_MS = 30_000;
const SHORT_MOMENTUM_MIN_WINDOW_MS = 25_000;
const SHORT_MOMENTUM_MAX_WINDOW_MS = 75_000;
const TRACKER_RETENTION_MS = 120_000;

export function createPaperMomentumTracker(): PaperMomentumTracker {
  return { pointsByMint: new Map() };
}

function shortWindowMetrics(
  tracker: PaperMomentumTracker,
  token: MarketToken,
  observedAtMs: number,
): { pricePct: number | null; volumeGrowthPct: number | null; windowMs: number | null; pattern?: LaunchPatternResult } {
  // Provider timestamps, rather than repeated desktop polls, advance evidence.
  const sourceAtMs = Date.parse(token.updatedAt);
  if (!Number.isFinite(sourceAtMs) || sourceAtMs > observedAtMs
    || observedAtMs - sourceAtMs > SHORT_MOMENTUM_MAX_WINDOW_MS
    || !Number.isFinite(token.priceUsd) || token.priceUsd <= 0) {
    tracker.pointsByMint.delete(token.mint);
    return { pricePct: null, volumeGrowthPct: null, windowMs: null };
  }
  const previous = tracker.pointsByMint.get(token.mint) ?? [];
  if (previous.length && sourceAtMs < previous[previous.length - 1].observedAtMs) {
    return { pricePct: null, volumeGrowthPct: null, windowMs: null };
  }
  observedAtMs = sourceAtMs;
  const retained = (tracker.pointsByMint.get(token.mint) ?? [])
    .filter((point) => observedAtMs - point.observedAtMs <= TRACKER_RETENTION_MS && point.observedAtMs <= observedAtMs);
  const targetAt = observedAtMs - SHORT_MOMENTUM_TARGET_MS;
  const baseline = [...retained].reverse().find((point) => point.observedAtMs <= targetAt);
  const windowMs = baseline ? observedAtMs - baseline.observedAtMs : null;
  const usable = baseline && windowMs !== null
    && windowMs >= SHORT_MOMENTUM_MIN_WINDOW_MS
    && windowMs <= SHORT_MOMENTUM_MAX_WINDOW_MS
    && baseline.priceUsd > 0
    && token.priceUsd > 0;
  if (!retained.some((point) => point.observedAtMs === observedAtMs)) {
    retained.push({ observedAtMs, priceUsd: token.priceUsd, volume5mUsd: token.volume5mUsd, buyRatio: token.buyRatio, liquidityUsd: token.liquidityUsd });
  }
  tracker.pointsByMint.set(token.mint, retained);
  return {
    pricePct: usable ? (token.priceUsd / baseline.priceUsd - 1) * 100 : null,
    volumeGrowthPct: usable && baseline.volume5mUsd > 0 && Number.isFinite(token.volume5mUsd)
      ? (token.volume5mUsd / baseline.volume5mUsd - 1) * 100
      : null,
    windowMs: usable ? windowMs : null,
    pattern: classifyLaunchPattern(retained.filter((point) => observedAtMs - point.observedAtMs <= SHORT_MOMENTUM_MAX_WINDOW_MS)),
  };
}

export function observationsAt(
  tokens: readonly MarketToken[],
  observedAtMs: number,
  tracker?: PaperMomentumTracker,
): PaperMarketObservation[] {
  if (tracker) {
    for (const [mint, points] of tracker.pointsByMint) {
      if (!points.length || observedAtMs - points[points.length - 1].observedAtMs > TRACKER_RETENTION_MS) {
        tracker.pointsByMint.delete(mint);
      }
    }
  }
  return tokens.flatMap((token) => {
    const previous = tracker?.pointsByMint.get(token.mint);
    if (previous?.length && Date.parse(token.updatedAt) < previous[previous.length - 1].observedAtMs) return [];
    const momentum = tracker ? shortWindowMetrics(tracker, token, observedAtMs) : null;
    return [{
      ...token,
      observedAtMs,
      shortMomentumPct: momentum?.pricePct ?? null,
      shortMomentumWindowMs: momentum?.windowMs ?? null,
      shortVolumeGrowthPct: momentum?.volumeGrowthPct ?? null,
      shortVolumeWindowMs: momentum?.windowMs ?? null,
      launchPattern: momentum?.pattern?.pattern ?? null,
      launchPatternDetail: momentum?.pattern?.detail ?? "Waiting for fresh launch observations",
      auditEligible:
        token.safety.mintAuthorityRevoked &&
        token.safety.freezeAuthorityRevoked &&
        token.safety.topTenHolderPct <= 35 &&
        token.safety.transferTaxPct <= 1,
      riskEligible: token.riskLevel === "Low" || token.riskLevel === "Medium",
    }];
  });
}

export function paperConfig(
  settings: PaperAutomationSettings,
  state: PaperEngineState,
): PaperEngineConfig {
  const pumpScalp = settings.strategyId === "pump-scalp";
  const launchFlow = settings.strategyId === "launch-flow";
  const budget = Math.max(5, settings.portfolioBudgetUsd);
  const allocationUsd = Math.min(250, budget * Math.max(0, settings.maxAllocationPerTokenPct) / 100);
  const dailyLossLimitPct = state.dayStartEquityUsd > 0
    ? Math.min(100, Math.max(0.1, settings.dailyLossLimitUsd / state.dayStartEquityUsd * 100))
    : 2;

  return mergePaperEngineConfig({
    entryRanking: launchFlow ? "launch" : pumpScalp ? "pump" : "model",
    entryNotionalUsd: allocationUsd,
    minOrderUsd: 5,
    maxOpenPositions: settings.maxOpenPositions,
    maxNewEntriesPerCycle: 1,
    minLiquidityUsd: settings.minLiquidityUsd,
    minVolume5mUsd: settings.minVolume5mUsd,
    minBuyRatio: Math.min(settings.minBuyRatio, settings.maxBuyRatio),
    maxBuyRatio: Math.max(settings.minBuyRatio, settings.maxBuyRatio),
    minBuys5m: launchFlow ? 3 : 2,
    minSells5m: launchFlow ? 1 : 2,
    minTrades5m: launchFlow ? 5 : 20,
    minTraders5m: settings.minTraders5m,
    minOrganicBuyers5m: settings.minOrganicBuyers5m,
    minOrganicScore: launchFlow ? 0 : 20,
    requireActivityMetrics: true,
    // Jupiter warns that a new pool's organic score is volatile before enough
    // history exists. Launch scout ranks it when present but does not hard-veto
    // an otherwise measurable young-pool setup.
    requireOrganicScore: !launchFlow,
    allowedRiskLevels: settings.allowHighRiskPaperEntries
      ? ["Low", "Medium", "Med-High", "High"]
      : ["Low", "Medium"],
    requireAuditEligibilityFlag: true,
    requireRiskEligibilityFlag: true,
    allowUnconfirmedRiskEligibility: settings.allowHighRiskPaperEntries,
    maxEntryImpactPct: settings.maxPriceImpactPct,
    minModelScore: settings.minModelScore,
    minTokenAgeSeconds: settings.minTokenAgeMinutes * 60,
    maxTokenAgeSeconds: settings.maxTokenAgeMinutes * 60,
    minMomentum5mPct: settings.minMomentum5mPct,
    maxMomentum5mPct: settings.maxMomentum5mPct,
    requireShortMomentum: pumpScalp || launchFlow,
    minShortMomentumPct: settings.minShortMomentumPct,
    maxShortMomentumPct: settings.maxShortMomentumPct,
    requireShortVolumeGrowth: launchFlow,
    requireLaunchPattern: launchFlow && settings.takeProfitPct === 0,
    minShortVolumeGrowthPct: settings.minShortVolumeGrowthPct,
    minVolumeToLiquidity: settings.minVolumeToLiquidity,
    maxAllocationPerTokenPct: settings.maxAllocationPerTokenPct,
    maxAllocationPerTokenUsd: 250,
    minCashReserveUsd: Math.min(settings.reserveUsd, Math.max(0, state.startingEquityUsd - 5)),
    minCashReservePct: 0,
    cooldownMs: settings.cooldownMinutes * 60_000,
    globalEntryCooldownMs: launchFlow ? 45_000 : pumpScalp ? 45_000 : 60_000,
    takeProfitPct: settings.takeProfitPct > 0 ? settings.takeProfitPct : Number.POSITIVE_INFINITY,
    stopLossPct: settings.stopLossPct,
    trailingStopPct: settings.trailingStopPct,
    maxHoldMs: settings.maxHoldMinutes * 60_000,
    profitLockTriggerPct: launchFlow && settings.takeProfitPct === 0
      ? Number.POSITIVE_INFINITY : launchFlow ? 1.5 : pumpScalp ? 3 : Number.POSITIVE_INFINITY,
    profitLockFloorPct: launchFlow ? 0.25 : pumpScalp ? 0.5 : 0,
    exitBuyRatioBelow: settings.exitBuyRatioBelow,
    buyRatioDeteriorationCooldownMs: settings.buyRatioDeteriorationCooldownMinutes * 60_000,
    exitLiquidityDrawdownPct: settings.exitLiquidityDrawdownPct,
    liquidityDrawdownCooldownMs: settings.liquidityDrawdownCooldownMinutes * 60_000,
    exitShortMomentumBelowPct: settings.exitShortMomentumBelowPct <= -100
      ? Number.NEGATIVE_INFINITY : settings.exitShortMomentumBelowPct,
    exitShortVolumeGrowthBelowPct: settings.exitShortVolumeGrowthBelowPct <= -100
      ? Number.NEGATIVE_INFINITY : settings.exitShortVolumeGrowthBelowPct,
    momentumBreakCooldownMs: settings.momentumBreakCooldownMinutes * 60_000,
    dailyLossLimitPct,
    // Jupiter's token-row estimate is anchored to a $250 probe. Scale it to
    // this profile's actual automatic order before gating or simulating fill.
    entryImpactMultiplier: Math.sqrt(Math.max(0.01, allocationUsd) / 250),
    exitImpactMultiplier: Math.sqrt(Math.max(0.01, allocationUsd) / 250),
    maxObservationAgeMs: 75_000,
  });
}

export function refreshPaperMarks(
  state: PaperEngineState,
  observations: readonly PaperMarketObservation[],
  nowMs: number = Date.now(),
): PaperEngineState {
  const lookup = new Map(observations.map((observation) => [observation.mint, observation]));
  return {
    ...state,
    positions: state.positions.map((position) => {
      const observation = lookup.get(position.mint);
      if (!observation || !Number.isFinite(observation.priceUsd) || observation.priceUsd <= 0) return position;
      const sourceAtMs = Date.parse(observation.updatedAt);
      const receivedAtMs = observation.observedAtMs ?? sourceAtMs;
      if (![sourceAtMs, receivedAtMs].every((at) => Number.isFinite(at) && at <= nowMs && nowMs - at <= 75_000)) return position;
      return {
        ...position,
        lastPriceUsd: observation.priceUsd,
        highestPriceUsd: Math.max(position.highestPriceUsd, observation.priceUsd),
        lastLiquidityUsd: observation.liquidityUsd > 0 ? observation.liquidityUsd : position.lastLiquidityUsd,
        lastImpactPct: Number.isFinite(observation.safety.priceImpactPct)
          ? observation.safety.priceImpactPct
          : position.lastImpactPct,
      };
    }),
  };
}
