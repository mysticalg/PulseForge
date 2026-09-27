import type { MarketToken, RiskLevel } from "../types";

/**
 * Extra point-in-time fields consumed by the automatic paper engine. The base
 * market token remains unchanged so the engine can be integrated incrementally.
 */
export interface PaperMarketObservation extends MarketToken {
  observedAtMs?: number;
  /** Locally measured price change over a short rolling window. */
  shortMomentumPct?: number | null;
  shortMomentumWindowMs?: number | null;
  /** Change in rolling five-minute traded notional over the same local window. */
  shortVolumeGrowthPct?: number | null;
  shortVolumeWindowMs?: number | null;
  /** Locally confirmed launch setup used by the runner entry policy. */
  launchPattern?: "breakout" | "pullback-reclaim" | null;
  launchPatternDetail?: string;
  /** Optional upstream safety classifications consumed by the configured policy. */
  auditEligible?: boolean | null;
  riskEligible?: boolean | null;
}

export interface PaperEngineConfig {
  entryRanking: "model" | "pump" | "launch";
  /** Maximum automatic spend; impact, cash, and allocation limits can reduce it. */
  entryNotionalUsd: number;
  minOrderUsd: number;
  maxOpenPositions: number;
  maxNewEntriesPerCycle: number;
  minLiquidityUsd: number;
  minVolume5mUsd: number;
  minBuyRatio: number;
  maxBuyRatio: number;
  minBuys5m: number;
  minSells5m: number;
  minTrades5m: number;
  minTraders5m: number;
  minOrganicBuyers5m: number;
  minOrganicScore: number;
  requireActivityMetrics: boolean;
  requireOrganicScore: boolean;
  allowedRiskLevels: readonly RiskLevel[];
  requireAuditEligibilityFlag: boolean;
  requireRiskEligibilityFlag: boolean;
  /** Paper-only override for an unavailable or negative risk-classification flag. */
  allowUnconfirmedRiskEligibility: boolean;
  requireMintAuthorityRevoked: boolean;
  requireFreezeAuthorityRevoked: boolean;
  requireLiquidityLocked: boolean;
  requireVerified: boolean;
  maxTopTenHolderPct: number;
  maxTransferTaxPct: number;
  maxEntryImpactPct: number;
  minModelScore: number;
  minTokenAgeSeconds: number;
  maxTokenAgeSeconds: number;
  minMomentum5mPct: number;
  maxMomentum5mPct: number;
  requireShortMomentum: boolean;
  minShortMomentumPct: number;
  maxShortMomentumPct: number;
  requireShortVolumeGrowth: boolean;
  requireLaunchPattern: boolean;
  minShortVolumeGrowthPct: number;
  minVolumeToLiquidity: number;
  /** Percentage points, so 1 means 1% of marked equity. */
  maxAllocationPerTokenPct: number;
  maxAllocationPerTokenUsd: number;
  minCashReserveUsd: number;
  /** Percentage points, so 10 means a 10% cash reserve. */
  minCashReservePct: number;
  cooldownMs: number;
  globalEntryCooldownMs: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  maxHoldMs: number;
  profitLockTriggerPct: number;
  profitLockFloorPct: number;
  exitBuyRatioBelow: number;
  buyRatioDeteriorationCooldownMs: number;
  exitLiquidityDrawdownPct: number;
  liquidityDrawdownCooldownMs: number;
  exitShortMomentumBelowPct: number;
  exitShortVolumeGrowthBelowPct: number;
  momentumBreakCooldownMs: number;
  feeRateBps: number;
  /** Converts the scanner impact reference to entryNotionalUsd before sizing. */
  entryImpactMultiplier: number;
  /** Same reference size as entryImpactMultiplier, scaled to the actual sale. */
  exitImpactMultiplier: number;
  dailyLossLimitPct: number;
  maxObservationAgeMs: number;
  maxFutureSkewMs: number;
}

export const DEFAULT_PAPER_ENGINE_CONFIG: PaperEngineConfig = {
  entryRanking: "model",
  entryNotionalUsd: 25,
  minOrderUsd: 5,
  maxOpenPositions: 5,
  maxNewEntriesPerCycle: 1,
  minLiquidityUsd: 50_000,
  minVolume5mUsd: 10_000,
  minBuyRatio: 0.55,
  maxBuyRatio: 0.85,
  minBuys5m: 1,
  minSells5m: 1,
  minTrades5m: 20,
  minTraders5m: 10,
  minOrganicBuyers5m: 2,
  minOrganicScore: 25,
  requireActivityMetrics: false,
  requireOrganicScore: false,
  allowedRiskLevels: ["Low", "Medium"],
  requireAuditEligibilityFlag: false,
  requireRiskEligibilityFlag: false,
  allowUnconfirmedRiskEligibility: false,
  requireMintAuthorityRevoked: true,
  requireFreezeAuthorityRevoked: true,
  requireLiquidityLocked: false,
  requireVerified: false,
  maxTopTenHolderPct: 35,
  maxTransferTaxPct: 1,
  maxEntryImpactPct: 0.75,
  minModelScore: 0.55,
  minTokenAgeSeconds: 0,
  maxTokenAgeSeconds: Number.MAX_SAFE_INTEGER,
  minMomentum5mPct: -100,
  maxMomentum5mPct: 1_000,
  requireShortMomentum: false,
  minShortMomentumPct: -100,
  maxShortMomentumPct: 1_000,
  requireShortVolumeGrowth: false,
  requireLaunchPattern: false,
  minShortVolumeGrowthPct: 0,
  minVolumeToLiquidity: 0,
  maxAllocationPerTokenPct: 1,
  maxAllocationPerTokenUsd: 250,
  minCashReserveUsd: 100,
  minCashReservePct: 10,
  cooldownMs: 15 * 60 * 1_000,
  globalEntryCooldownMs: 60_000,
  takeProfitPct: 15,
  stopLossPct: 7.5,
  trailingStopPct: 5,
  maxHoldMs: 6 * 60 * 60 * 1_000,
  profitLockTriggerPct: Number.POSITIVE_INFINITY,
  profitLockFloorPct: 0,
  exitBuyRatioBelow: 0.45,
  buyRatioDeteriorationCooldownMs: 30 * 60 * 1_000,
  exitLiquidityDrawdownPct: 35,
  liquidityDrawdownCooldownMs: 30 * 60 * 1_000,
  exitShortMomentumBelowPct: Number.NEGATIVE_INFINITY,
  exitShortVolumeGrowthBelowPct: Number.NEGATIVE_INFINITY,
  momentumBreakCooldownMs: 0,
  feeRateBps: 35,
  entryImpactMultiplier: 1,
  exitImpactMultiplier: 1,
  dailyLossLimitPct: 2,
  maxObservationAgeMs: 60_000,
  maxFutureSkewMs: 5_000,
};

export type PaperExitReason =
  | "illiquid_writeoff"
  | "take_profit"
  | "stop_loss"
  | "trailing_stop"
  | "profit_lock"
  | "max_hold"
  | "buy_ratio_deterioration"
  | "momentum_reversal"
  | "volume_fade"
  | "liquidity_drawdown"
  | "kill_switch"
  | "daily_loss"
  | "manual_25"
  | "manual_50"
  | "manual_100";

export type PaperEntryReason =
  | "automatic_entry"
  | "automatic_conservative"
  | "automatic_pump_scalp"
  | "automatic_launch_flow"
  | "manual_entry";

export interface PaperEnginePosition {
  mint: string;
  symbol: string;
  quantity: number;
  costBasisUsd: number;
  averageFillPriceUsd: number;
  openedAtMs: number;
  lastEntryAtMs: number;
  entryLiquidityUsd: number;
  lastLiquidityUsd: number;
  lastPriceUsd: number;
  highestPriceUsd: number;
  lastImpactPct: number;
}

export interface PaperEngineTrade {
  id: string;
  mint: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  midPriceUsd: number;
  fillPriceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  impactCostUsd: number;
  cashFlowUsd: number;
  realizedPnlUsd: number;
  reason: PaperEntryReason | PaperExitReason;
  timestampMs: number;
}

export interface PaperEngineState {
  startingEquityUsd: number;
  cashUsd: number;
  positions: PaperEnginePosition[];
  trades: PaperEngineTrade[];
  realizedPnlUsd: number;
  nextTradeSequence: number;
  dayKey: string;
  dayStartEquityUsd: number;
  dailyLossLockedDay: string | null;
}

export interface PaperPositionMark {
  mint: string;
  quantity: number;
  midMarketValueUsd: number;
  liquidationValueUsd: number;
  costBasisUsd: number;
  unrealizedPnlUsd: number;
  netReturnPct: number;
  drawdownFromPeakPct: number;
}

export interface PaperPortfolioMark {
  equityUsd: number;
  cashUsd: number;
  liquidationValueUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  feesPaidUsd: number;
  impactCostUsd: number;
  positions: PaperPositionMark[];
}

export interface EntryEvaluation {
  mint: string;
  eligible: boolean;
  allocationUsd: number;
  blockers: string[];
}

export interface ExitEvaluation {
  mint: string;
  shouldExit: boolean;
  reason: Exclude<PaperExitReason, `manual_${number}`> | null;
}

export interface PaperCycleControl {
  killSwitch: boolean;
}

export interface PaperCycleResult {
  state: PaperEngineState;
  mark: PaperPortfolioMark;
  trades: PaperEngineTrade[];
  entries: EntryEvaluation[];
  dailyLossTriggered: boolean;
  automationBlocked: boolean;
  closeBlockers: string[];
}

export type ManualClosePercent = 25 | 50 | 100;

const EPSILON = 1e-10;
/** Local momentum is actionable only over a recent, meaningful sample window. */
export const MIN_SHORT_OBSERVATION_WINDOW_MS = 25_000;
export const MAX_SHORT_OBSERVATION_WINDOW_MS = 75_000;

export function createPaperEngineState(startingEquityUsd: number, nowMs: number): PaperEngineState {
  assertFinitePositive(startingEquityUsd, "startingEquityUsd");
  assertTimestamp(nowMs);
  return {
    startingEquityUsd,
    cashUsd: startingEquityUsd,
    positions: [],
    trades: [],
    realizedPnlUsd: 0,
    nextTradeSequence: 1,
    dayKey: utcDayKey(nowMs),
    dayStartEquityUsd: startingEquityUsd,
    dailyLossLockedDay: null,
  };
}

export function mergePaperEngineConfig(overrides: Partial<PaperEngineConfig> = {}): PaperEngineConfig {
  return { ...DEFAULT_PAPER_ENGINE_CONFIG, ...overrides };
}

export function evaluatePaperEntry(
  state: PaperEngineState,
  observation: PaperMarketObservation,
  nowMs: number,
  config: PaperEngineConfig = DEFAULT_PAPER_ENGINE_CONFIG,
): EntryEvaluation {
  assertTimestamp(nowMs);
  const blockers: string[] = [];
  const existing = state.positions.find((position) => position.mint === observation.mint);
  const mark = markPaperPortfolio(state, [observation], config);

  if (!isPositiveFinite(observation.priceUsd)) blockers.push("Price is missing or invalid");
  if (!isFreshObservation(observation, nowMs, config)) blockers.push("Observation is stale or time-invalid");
  if (!isPositiveFinite(observation.liquidityUsd) || observation.liquidityUsd < config.minLiquidityUsd) {
    blockers.push(`Liquidity is below $${config.minLiquidityUsd}`);
  }
  if (!isFiniteNumber(observation.volume5mUsd) || observation.volume5mUsd < config.minVolume5mUsd) {
    blockers.push(`5m volume is below $${config.minVolume5mUsd}`);
  }
  if (
    !isFiniteNumber(observation.buyRatio) ||
    observation.buyRatio < config.minBuyRatio ||
    observation.buyRatio > config.maxBuyRatio
  ) {
    blockers.push(`Buy ratio is outside ${config.minBuyRatio}-${config.maxBuyRatio}`);
  }

  checkOptionalMinimum(blockers, "5m buy count", observation.buys5m, config.minBuys5m, true);
  checkOptionalMinimum(blockers, "5m sell count", observation.sells5m, config.minSells5m, true);
  const trades5m = isFiniteNumber(observation.buys5m) && isFiniteNumber(observation.sells5m)
    ? observation.buys5m + observation.sells5m
    : null;
  checkOptionalMinimum(blockers, "5m trade count", trades5m, config.minTrades5m, config.requireActivityMetrics);
  checkOptionalMinimum(blockers, "5m trader count", observation.traders5m, config.minTraders5m, config.requireActivityMetrics);
  checkOptionalMinimum(
    blockers,
    "5m organic buyer count",
    observation.organicBuyers5m,
    config.minOrganicBuyers5m,
    config.requireActivityMetrics,
  );
  checkOptionalMinimum(
    blockers,
    "Organic score",
    observation.organicScore,
    config.minOrganicScore,
    config.requireOrganicScore,
  );

  if (!config.allowedRiskLevels.includes(observation.riskLevel)) blockers.push(`Risk level ${observation.riskLevel} is ineligible`);
  if (!config.allowUnconfirmedRiskEligibility
    && (observation.riskEligible === false || (config.requireRiskEligibilityFlag && observation.riskEligible !== true))) {
    blockers.push("Risk eligibility is not confirmed");
  }
  if (observation.auditEligible === false || (config.requireAuditEligibilityFlag && observation.auditEligible !== true)) {
    blockers.push("Audit eligibility is not confirmed");
  }
  if (config.requireMintAuthorityRevoked && !observation.safety.mintAuthorityRevoked) {
    blockers.push("Mint authority is not revoked");
  }
  if (config.requireFreezeAuthorityRevoked && !observation.safety.freezeAuthorityRevoked) {
    blockers.push("Freeze authority is not revoked");
  }
  if (config.requireLiquidityLocked && observation.safety.liquidityLocked !== true) {
    blockers.push("Liquidity lock is not confirmed");
  }
  if (config.requireVerified && !observation.safety.verified) blockers.push("Token is not verified");
  if (!isFiniteNumber(observation.safety.topTenHolderPct) || observation.safety.topTenHolderPct > config.maxTopTenHolderPct) {
    blockers.push(`Top-holder concentration exceeds ${config.maxTopTenHolderPct}%`);
  }
  if (!isFiniteNumber(observation.safety.transferTaxPct) || observation.safety.transferTaxPct > config.maxTransferTaxPct) {
    blockers.push(`Transfer tax exceeds ${config.maxTransferTaxPct}% or is unknown`);
  }
  const impactAllocationCapUsd = automaticImpactAllocationCap(observation, config);
  if (
    !isFiniteNumber(observation.safety.priceImpactPct) ||
    observation.safety.priceImpactPct < 0 ||
    !isFiniteNumber(config.entryImpactMultiplier) || config.entryImpactMultiplier < 0 ||
    !isPositiveFinite(config.entryNotionalUsd) ||
    !isFiniteNumber(config.maxEntryImpactPct) || config.maxEntryImpactPct < 0
  ) {
    blockers.push(`Entry impact exceeds ${config.maxEntryImpactPct}% or is unknown`);
  }
  if (!isFiniteNumber(observation.modelScore) || observation.modelScore < config.minModelScore) {
    blockers.push(`Model score is below ${config.minModelScore}`);
  }
  if (
    !isFiniteNumber(observation.ageSeconds) ||
    observation.ageSeconds < config.minTokenAgeSeconds ||
    observation.ageSeconds > config.maxTokenAgeSeconds
  ) {
    blockers.push(`Pool age is outside ${config.minTokenAgeSeconds}-${config.maxTokenAgeSeconds} seconds`);
  }
  if (
    !isFiniteNumber(observation.change5mPct) ||
    observation.change5mPct < config.minMomentum5mPct ||
    observation.change5mPct > config.maxMomentum5mPct
  ) {
    blockers.push(`5m momentum is outside ${config.minMomentum5mPct}-${config.maxMomentum5mPct}%`);
  }
  const requiresPriceWindow = config.requireShortMomentum || config.requireLaunchPattern;
  const requiresVolumeWindow = config.requireShortVolumeGrowth || config.requireLaunchPattern;
  if (
    observation.shortMomentumPct == null ||
    !isFiniteNumber(observation.shortMomentumPct) ||
    (requiresPriceWindow && !isUsableShortWindow(observation.shortMomentumWindowMs))
  ) {
    if (requiresPriceWindow) blockers.push("Short-window momentum is still warming up");
  } else if (
    observation.shortMomentumPct < config.minShortMomentumPct ||
    observation.shortMomentumPct > config.maxShortMomentumPct
  ) {
    blockers.push(`Short momentum is outside ${config.minShortMomentumPct}-${config.maxShortMomentumPct}%`);
  }
  if (observation.shortVolumeGrowthPct == null || !isFiniteNumber(observation.shortVolumeGrowthPct)
    || (requiresVolumeWindow && !isUsableShortWindow(observation.shortVolumeWindowMs))) {
    if (requiresVolumeWindow) blockers.push("Short-window volume growth is still warming up");
  } else if (observation.shortVolumeGrowthPct < config.minShortVolumeGrowthPct) {
    blockers.push(`Short volume growth is below ${config.minShortVolumeGrowthPct}%`);
  }
  if (config.requireLaunchPattern
    && observation.launchPattern !== "breakout"
    && observation.launchPattern !== "pullback-reclaim") {
    blockers.push("Launch pattern is still forming");
  }
  const volumeToLiquidity = isPositiveFinite(observation.liquidityUsd)
    ? observation.volume5mUsd / observation.liquidityUsd
    : 0;
  if (!isFiniteNumber(volumeToLiquidity) || volumeToLiquidity < config.minVolumeToLiquidity) {
    blockers.push(`5m volume / liquidity is below ${config.minVolumeToLiquidity}`);
  }
  if (existing) blockers.push("A position in this token is already open");
  if (state.positions.length >= config.maxOpenPositions) {
    blockers.push(`Maximum open positions reached (${state.positions.length}/${config.maxOpenPositions})`);
  }

  addTokenCooldownBlocker(blockers, state, observation.mint, nowMs, config);
  const lastPortfolioEntryAt = state.trades.reduce(
    (latest, trade) => trade.side === "BUY" ? Math.max(latest, trade.timestampMs) : latest,
    Number.NEGATIVE_INFINITY,
  );
  if (nowMs - lastPortfolioEntryAt < config.globalEntryCooldownMs) {
    blockers.push("Portfolio entry spacing is active");
  }

  const tokenCap = Math.min(
    config.maxAllocationPerTokenUsd,
    mark.equityUsd * clamp(config.maxAllocationPerTokenPct / 100, 0, 1),
  );
  const existingExposure = existing ? Math.max(existing.costBasisUsd, existing.quantity * observation.priceUsd) : 0;
  const reserve = Math.max(config.minCashReserveUsd, mark.equityUsd * clamp(config.minCashReservePct / 100, 0, 1));
  const spendableCash = Math.max(0, state.cashUsd - reserve);
  const allocationUsd = Math.max(
    0,
    Math.min(config.entryNotionalUsd, tokenCap - existingExposure, spendableCash, impactAllocationCapUsd),
  );

  if (allocationUsd + EPSILON < config.minOrderUsd) blockers.push("Allocation is below the minimum paper order");

  return { mint: observation.mint, eligible: blockers.length === 0, allocationUsd, blockers };
}

export function enterPaperPosition(
  state: PaperEngineState,
  observation: PaperMarketObservation,
  nowMs: number,
  config: PaperEngineConfig = DEFAULT_PAPER_ENGINE_CONFIG,
): PaperEngineState {
  const evaluation = evaluatePaperEntry(state, observation, nowMs, config);
  if (!evaluation.eligible) throw new Error(`Paper entry blocked: ${evaluation.blockers.join("; ")}`);

  const reason = config.entryRanking === "launch"
    ? "automatic_launch_flow"
    : config.entryRanking === "pump"
      ? "automatic_pump_scalp"
      : "automatic_conservative";
  return executePaperEntry(state, observation, evaluation.allocationUsd, reason, nowMs, config);
}

/**
 * Paper-only discretionary entry. It deliberately bypasses model, volume,
 * flow-ratio and participant-count thresholds, but retains every quote,
 * contract/audit and account-risk guard. It never averages into a position.
 */
export function manualPaperBuy(
  state: PaperEngineState,
  observation: PaperMarketObservation,
  desiredUsd: number,
  nowMs: number,
  config: PaperEngineConfig = DEFAULT_PAPER_ENGINE_CONFIG,
  control: PaperCycleControl = { killSwitch: false },
): PaperEngineState {
  const evaluation = evaluateManualPaperEntry(state, observation, desiredUsd, nowMs, config, control);
  if (!evaluation.eligible) throw new Error(`Manual paper entry blocked: ${evaluation.blockers.join("; ")}`);
  return executePaperEntry(state, observation, desiredUsd, "manual_entry", nowMs, config);
}

/**
 * Runs the exact preflight used by manualPaperBuy without changing the ledger.
 * The UI uses this to explain account and risk blockers before the user clicks.
 */
export function evaluateManualPaperEntry(
  state: PaperEngineState,
  observation: PaperMarketObservation,
  desiredUsd: number,
  nowMs: number,
  config: PaperEngineConfig = DEFAULT_PAPER_ENGINE_CONFIG,
  control: PaperCycleControl = { killSwitch: false },
): EntryEvaluation {
  assertTimestamp(nowMs);
  const blockers = coreEntrySafetyBlockers(observation, nowMs, config);
  if (!isPositiveFinite(desiredUsd)) blockers.push("Manual paper entry amount must be finite and positive");
  if (desiredUsd + EPSILON < config.minOrderUsd) blockers.push("Allocation is below the minimum paper order");
  if (state.positions.some((position) => position.mint === observation.mint)) {
    blockers.push("A position in this token is already open; averaging is disabled");
  }
  if (state.positions.length >= config.maxOpenPositions) {
    blockers.push(`Maximum open positions reached (${state.positions.length}/${config.maxOpenPositions})`);
  }
  if (control.killSwitch) blockers.push("Kill switch is active");
  if (state.dailyLossLockedDay === utcDayKey(nowMs)) blockers.push("Daily loss lock is active");

  addTokenCooldownBlocker(blockers, state, observation.mint, nowMs, config);

  const mark = markPaperPortfolio(state, [observation], config);
  const tokenCap = Math.min(
    config.maxAllocationPerTokenUsd,
    mark.equityUsd * clamp(config.maxAllocationPerTokenPct / 100, 0, 1),
  );
  if (desiredUsd > tokenCap + EPSILON) blockers.push("Manual allocation exceeds the per-token cap");
  const reserve = Math.max(config.minCashReserveUsd, mark.equityUsd * clamp(config.minCashReservePct / 100, 0, 1));
  if (state.cashUsd - desiredUsd < reserve - EPSILON) blockers.push("Manual allocation would breach the cash reserve");

  return {
    mint: observation.mint,
    eligible: blockers.length === 0,
    allocationUsd: isPositiveFinite(desiredUsd) ? desiredUsd : 0,
    blockers,
  };
}

function executePaperEntry(
  state: PaperEngineState,
  observation: PaperMarketObservation,
  allocationUsd: number,
  reason: PaperEntryReason,
  nowMs: number,
  config: PaperEngineConfig,
): PaperEngineState {

  const feeUsd = allocationUsd * clamp(config.feeRateBps / 10_000, 0, 1);
  // A manual observation contains the quote for the requested amount. Automatic
  // observations contain the scanner estimate at the configured reference size.
  const impactPct = reason === "manual_entry"
    ? executionImpactPct(observation, 1)
    : notionalImpactPct(observation, allocationUsd, config.entryImpactMultiplier, config);
  const fillPriceUsd = observation.priceUsd * (1 + impactPct / 100);
  const quantity = (allocationUsd - feeUsd) / fillPriceUsd;
  const impactCostUsd = Math.max(0, quantity * (fillPriceUsd - observation.priceUsd));
  const trade = createTrade(state, {
    observation,
    side: "BUY",
    quantity,
    fillPriceUsd,
    notionalUsd: allocationUsd,
    feeUsd,
    impactCostUsd,
    cashFlowUsd: -allocationUsd,
    realizedPnlUsd: 0,
    reason,
    nowMs,
  });
  const position: PaperEnginePosition = {
    mint: observation.mint,
    symbol: observation.symbol,
    quantity,
    costBasisUsd: allocationUsd,
    averageFillPriceUsd: fillPriceUsd,
    openedAtMs: nowMs,
    lastEntryAtMs: nowMs,
    entryLiquidityUsd: observation.liquidityUsd,
    lastLiquidityUsd: observation.liquidityUsd,
    lastPriceUsd: observation.priceUsd,
    highestPriceUsd: observation.priceUsd,
    // Keep the same scanner reference as subsequent mark updates. Normalize an
    // amount-specific manual quote before using it as a fallback exit mark.
    lastImpactPct: reason === "manual_entry"
      ? manualImpactReferencePct(impactPct, allocationUsd, config)
      : observation.safety.priceImpactPct,
  };

  return {
    ...state,
    cashUsd: state.cashUsd - allocationUsd,
    positions: [...state.positions, position].sort((a, b) => a.mint.localeCompare(b.mint)),
    trades: [...state.trades, trade],
    nextTradeSequence: state.nextTradeSequence + 1,
  };
}

export function evaluatePaperExit(
  position: PaperEnginePosition,
  observation: PaperMarketObservation,
  nowMs: number,
  config: PaperEngineConfig = DEFAULT_PAPER_ENGINE_CONFIG,
): ExitEvaluation {
  assertTimestamp(nowMs);
  if (!isFreshObservation(observation, nowMs, config) || !isPositiveFinite(observation.priceUsd)) {
    return { mint: position.mint, shouldExit: false, reason: null };
  }

  const updatedPeak = Math.max(position.highestPriceUsd, observation.priceUsd);
  const liquidation = estimateLiquidation(position.quantity, observation, config);
  const netReturnPct = position.costBasisUsd > 0 ? ((liquidation.proceedsUsd / position.costBasisUsd) - 1) * 100 : 0;
  const trailingDrawdownPct = updatedPeak > 0 ? ((updatedPeak - observation.priceUsd) / updatedPeak) * 100 : 0;
  const peakLiquidation = estimateLiquidation(position.quantity, { ...observation, priceUsd: updatedPeak }, config);
  const peakNetReturnPct = position.costBasisUsd > 0
    ? ((peakLiquidation.proceedsUsd / position.costBasisUsd) - 1) * 100
    : 0;
  const liquidityDrawdownPct = position.entryLiquidityUsd > 0
    ? ((position.entryLiquidityUsd - observation.liquidityUsd) / position.entryLiquidityUsd) * 100
    : 100;

  if (netReturnPct <= -config.stopLossPct) return exit(position.mint, "stop_loss");
  if (peakNetReturnPct >= config.profitLockTriggerPct && netReturnPct <= config.profitLockFloorPct) {
    return exit(position.mint, "profit_lock");
  }
  if (trailingDrawdownPct >= config.trailingStopPct) return exit(position.mint, "trailing_stop");
  if (config.takeProfitPct > 0 && netReturnPct >= config.takeProfitPct) return exit(position.mint, "take_profit");
  if (config.exitLiquidityDrawdownPct > 0 && liquidityDrawdownPct >= config.exitLiquidityDrawdownPct) {
    return exit(position.mint, "liquidity_drawdown");
  }
  if (observation.buyRatio < config.exitBuyRatioBelow) return exit(position.mint, "buy_ratio_deterioration");
  if (isFiniteNumber(observation.shortMomentumPct)
    && isUsableShortWindow(observation.shortMomentumWindowMs)
    && observation.shortMomentumPct <= config.exitShortMomentumBelowPct) return exit(position.mint, "momentum_reversal");
  if (isFiniteNumber(observation.shortVolumeGrowthPct)
    && isUsableShortWindow(observation.shortVolumeWindowMs)
    && observation.shortVolumeGrowthPct <= config.exitShortVolumeGrowthBelowPct) return exit(position.mint, "volume_fade");
  if (nowMs - position.openedAtMs >= config.maxHoldMs) return exit(position.mint, "max_hold");
  return { mint: position.mint, shouldExit: false, reason: null };
}

export function closePaperPosition(
  state: PaperEngineState,
  observation: PaperMarketObservation,
  percent: ManualClosePercent,
  nowMs: number,
  config: PaperEngineConfig = DEFAULT_PAPER_ENGINE_CONFIG,
): PaperEngineState {
  const reason = `manual_${percent}` as const;
  return closePositionFraction(state, observation, percent / 100, reason, nowMs, config);
}

/**
 * Creates an explicit paper-only exit mark when the provider cannot refresh a
 * held mint. This keeps simulated positions closable without pretending that
 * the last recorded price is a new live quote.
 */
export function paperExitObservationFromLastMark(
  position: PaperEnginePosition,
  nowMs: number,
): PaperMarketObservation {
  assertTimestamp(nowMs);
  const priceUsd = isPositiveFinite(position.lastPriceUsd)
    ? position.lastPriceUsd
    : position.averageFillPriceUsd;
  if (!isPositiveFinite(priceUsd)) throw new Error("Paper position has no usable recorded price");
  const observation = observationFromPosition(position, priceUsd);
  const liquidityUsd = isPositiveFinite(position.lastLiquidityUsd)
    ? position.lastLiquidityUsd
    : position.entryLiquidityUsd;
  const priceImpactPct = isFiniteNumber(position.lastImpactPct) && position.lastImpactPct >= 0
    ? clamp(position.lastImpactPct, 0, 99)
    : 25;
  return {
    ...observation,
    liquidityUsd,
    safety: { ...observation.safety, priceImpactPct },
    source: "paper-last-recorded-mark",
    updatedAt: new Date(nowMs).toISOString(),
    observedAtMs: nowMs,
  };
}

export function markPaperPortfolio(
  state: PaperEngineState,
  observations: readonly PaperMarketObservation[],
  config: PaperEngineConfig = DEFAULT_PAPER_ENGINE_CONFIG,
): PaperPortfolioMark {
  const lookup = observationLookup(observations);
  const positions = state.positions.map((position): PaperPositionMark => {
    const observation = lookup.get(position.mint);
    const priceUsd = observation && isPositiveFinite(observation.priceUsd) ? observation.priceUsd : position.lastPriceUsd;
    const synthetic = observation ?? observationFromPosition(position, priceUsd);
    const liquidation = estimateLiquidation(position.quantity, synthetic, config);
    const midMarketValueUsd = position.quantity * priceUsd;
    const unrealizedPnlUsd = liquidation.proceedsUsd - position.costBasisUsd;
    const updatedPeak = Math.max(position.highestPriceUsd, priceUsd);
    return {
      mint: position.mint,
      quantity: position.quantity,
      midMarketValueUsd,
      liquidationValueUsd: liquidation.proceedsUsd,
      costBasisUsd: position.costBasisUsd,
      unrealizedPnlUsd,
      netReturnPct: position.costBasisUsd > 0 ? (unrealizedPnlUsd / position.costBasisUsd) * 100 : 0,
      drawdownFromPeakPct: updatedPeak > 0 ? ((updatedPeak - priceUsd) / updatedPeak) * 100 : 0,
    };
  });
  const liquidationValueUsd = sum(positions.map((position) => position.liquidationValueUsd));
  const unrealizedPnlUsd = sum(positions.map((position) => position.unrealizedPnlUsd));
  const equityUsd = state.cashUsd + liquidationValueUsd;
  return {
    equityUsd,
    cashUsd: state.cashUsd,
    liquidationValueUsd,
    realizedPnlUsd: state.realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd: equityUsd - state.startingEquityUsd,
    feesPaidUsd: sum(state.trades.map((trade) => trade.feeUsd)),
    impactCostUsd: sum(state.trades.map((trade) => trade.impactCostUsd)),
    positions,
  };
}

export function runPaperCycle(
  inputState: PaperEngineState,
  observations: readonly PaperMarketObservation[],
  nowMs: number,
  config: PaperEngineConfig = DEFAULT_PAPER_ENGINE_CONFIG,
  control: PaperCycleControl = { killSwitch: false },
): PaperCycleResult {
  assertTimestamp(nowMs);
  const lookup = observationLookup(observations);
  const freshObservations = observations.filter((observation) => isFreshObservation(observation, nowMs, config));
  let state = updatePositionMarks(inputState, lookup, nowMs, config);
  let currentMark = markPaperPortfolio(state, freshObservations, config);
  const today = utcDayKey(nowMs);

  if (state.dayKey !== today) {
    state = {
      ...state,
      dayKey: today,
      dayStartEquityUsd: currentMark.equityUsd,
      dailyLossLockedDay: null,
    };
  }

  const dailyLossTriggered =
    state.dailyLossLockedDay === today ||
    currentMark.equityUsd <= state.dayStartEquityUsd * (1 - clamp(config.dailyLossLimitPct / 100, 0, 1));
  if (dailyLossTriggered && state.dailyLossLockedDay !== today) state = { ...state, dailyLossLockedDay: today };

  const firstTradeIndex = state.trades.length;
  const closeBlockers: string[] = [];
  const globalReason: PaperExitReason | null = control.killSwitch
    ? "kill_switch"
    : dailyLossTriggered
      ? "daily_loss"
      : null;

  for (const position of [...state.positions].sort((a, b) => a.mint.localeCompare(b.mint))) {
    const observation = lookup.get(position.mint);
    if (!observation || !isFreshObservation(observation, nowMs, config) || !isPositiveFinite(observation.priceUsd)) {
      if (globalReason) closeBlockers.push(`${position.mint}: no fresh executable paper mark`);
      continue;
    }
    const evaluation = globalReason
      ? { mint: position.mint, shouldExit: true, reason: globalReason }
      : evaluatePaperExit(position, observation, nowMs, config);
    if (evaluation.shouldExit && evaluation.reason) {
      state = closePositionFraction(state, observation, 1, evaluation.reason, nowMs, config);
    }
  }

  const automationBlocked = control.killSwitch || dailyLossTriggered;
  const entries: EntryEvaluation[] = [];
  if (!automationBlocked) {
    const exitedMints = new Set(
      state.trades.slice(firstTradeIndex).filter((trade) => trade.side === "SELL").map((trade) => trade.mint),
    );
    const candidates = [...observations].sort((a, b) => compareEntryCandidates(a, b, config));
    let entered = 0;
    for (const observation of candidates) {
      const baseEvaluation = evaluatePaperEntry(state, observation, nowMs, config);
      const evaluation = exitedMints.has(observation.mint)
        ? {
            ...baseEvaluation,
            eligible: false,
            blockers: [...baseEvaluation.blockers, "Token exited during this cycle"],
          }
        : baseEvaluation;
      entries.push(evaluation);
      if (!evaluation.eligible || entered >= config.maxNewEntriesPerCycle) continue;
      state = enterPaperPosition(state, observation, nowMs, config);
      entered += 1;
    }
  }

  currentMark = markPaperPortfolio(state, freshObservations, config);
  return {
    state,
    mark: currentMark,
    trades: state.trades.slice(firstTradeIndex),
    entries,
    dailyLossTriggered,
    automationBlocked,
    closeBlockers,
  };
}

function closePositionFraction(
  state: PaperEngineState,
  observation: PaperMarketObservation,
  fraction: number,
  reason: PaperExitReason,
  nowMs: number,
  config: PaperEngineConfig,
): PaperEngineState {
  assertTimestamp(nowMs);
  if (!isFreshObservation(observation, nowMs, config) || !isPositiveFinite(observation.priceUsd)) {
    throw new Error("Paper close requires a fresh positive market observation");
  }
  const index = state.positions.findIndex((position) => position.mint === observation.mint);
  if (index < 0) throw new Error(`No paper position for ${observation.mint}`);
  const position = state.positions[index];
  const closeFraction = clamp(fraction, 0, 1);
  if (closeFraction <= 0) throw new Error("Close fraction must be positive");

  const quantity = position.quantity * closeFraction;
  const costBasisUsd = position.costBasisUsd * closeFraction;
  const liquidation = estimateLiquidation(quantity, observation, config);
  const impactCostUsd = Math.max(0, quantity * (observation.priceUsd - liquidation.fillPriceUsd));
  const realizedPnlUsd = liquidation.proceedsUsd - costBasisUsd;
  const trade = createTrade(state, {
    observation,
    side: "SELL",
    quantity,
    fillPriceUsd: liquidation.fillPriceUsd,
    notionalUsd: quantity * observation.priceUsd,
    feeUsd: liquidation.feeUsd,
    impactCostUsd,
    cashFlowUsd: liquidation.proceedsUsd,
    realizedPnlUsd,
    reason,
    nowMs,
  });

  const remainingQuantity = position.quantity - quantity;
  const positions = remainingQuantity <= EPSILON
    ? state.positions.filter((_, positionIndex) => positionIndex !== index)
    : state.positions.map((candidate, positionIndex) => positionIndex === index
      ? {
          ...candidate,
          quantity: remainingQuantity,
          costBasisUsd: Math.max(0, position.costBasisUsd - costBasisUsd),
          lastPriceUsd: observation.priceUsd,
          lastLiquidityUsd: observation.liquidityUsd,
          lastImpactPct: observation.safety.priceImpactPct,
        }
      : candidate);

  return {
    ...state,
    cashUsd: state.cashUsd + liquidation.proceedsUsd,
    positions,
    trades: [...state.trades, trade],
    realizedPnlUsd: state.realizedPnlUsd + realizedPnlUsd,
    nextTradeSequence: state.nextTradeSequence + 1,
  };
}

function updatePositionMarks(
  state: PaperEngineState,
  lookup: ReadonlyMap<string, PaperMarketObservation>,
  nowMs: number,
  config: PaperEngineConfig,
): PaperEngineState {
  const positions = state.positions.map((position) => {
    const observation = lookup.get(position.mint);
    if (!observation || !isFreshObservation(observation, nowMs, config) || !isPositiveFinite(observation.priceUsd)) {
      return position;
    }
    return {
      ...position,
      lastPriceUsd: observation.priceUsd,
      highestPriceUsd: Math.max(position.highestPriceUsd, observation.priceUsd),
      lastLiquidityUsd: isPositiveFinite(observation.liquidityUsd) ? observation.liquidityUsd : position.lastLiquidityUsd,
      lastImpactPct: isFiniteNumber(observation.safety.priceImpactPct)
        ? observation.safety.priceImpactPct
        : position.lastImpactPct,
    };
  });
  return { ...state, positions };
}

function estimateLiquidation(
  quantity: number,
  observation: PaperMarketObservation,
  config: PaperEngineConfig,
): { fillPriceUsd: number; feeUsd: number; proceedsUsd: number } {
  const impactPct = notionalImpactPct(observation, quantity * observation.priceUsd, config.exitImpactMultiplier, config);
  const fillPriceUsd = observation.priceUsd * (1 - impactPct / 100);
  const grossProceedsUsd = Math.max(0, quantity * fillPriceUsd);
  const feeUsd = grossProceedsUsd * clamp(config.feeRateBps / 10_000, 0, 1);
  return { fillPriceUsd, feeUsd, proceedsUsd: Math.max(0, grossProceedsUsd - feeUsd) };
}

function createTrade(
  state: PaperEngineState,
  values: {
    observation: PaperMarketObservation;
    side: "BUY" | "SELL";
    quantity: number;
    fillPriceUsd: number;
    notionalUsd: number;
    feeUsd: number;
    impactCostUsd: number;
    cashFlowUsd: number;
    realizedPnlUsd: number;
    reason: PaperEntryReason | PaperExitReason;
    nowMs: number;
  },
): PaperEngineTrade {
  return {
    id: `paper-${state.nextTradeSequence}`,
    mint: values.observation.mint,
    symbol: values.observation.symbol,
    side: values.side,
    quantity: values.quantity,
    midPriceUsd: values.observation.priceUsd,
    fillPriceUsd: values.fillPriceUsd,
    notionalUsd: values.notionalUsd,
    feeUsd: values.feeUsd,
    impactCostUsd: values.impactCostUsd,
    cashFlowUsd: values.cashFlowUsd,
    realizedPnlUsd: values.realizedPnlUsd,
    reason: values.reason,
    timestampMs: values.nowMs,
  };
}

export function compareEntryCandidates(
  a: PaperMarketObservation,
  b: PaperMarketObservation,
  config: PaperEngineConfig,
): number {
  if (config.entryRanking === "launch") {
    return (b.shortVolumeGrowthPct ?? Number.NEGATIVE_INFINITY) - (a.shortVolumeGrowthPct ?? Number.NEGATIVE_INFINITY)
      || (b.shortMomentumPct ?? Number.NEGATIVE_INFINITY) - (a.shortMomentumPct ?? Number.NEGATIVE_INFINITY)
      || b.buyRatio - a.buyRatio
      || b.traders5m - a.traders5m
      || a.ageSeconds - b.ageSeconds
      || a.mint.localeCompare(b.mint);
  }
  if (config.entryRanking === "pump") {
    return (b.shortMomentumPct ?? Number.NEGATIVE_INFINITY) - (a.shortMomentumPct ?? Number.NEGATIVE_INFINITY)
      || b.change5mPct - a.change5mPct
      || (b.volume5mUsd / Math.max(1, b.liquidityUsd)) - (a.volume5mUsd / Math.max(1, a.liquidityUsd))
      || b.traders5m - a.traders5m
      || a.mint.localeCompare(b.mint);
  }
  return b.modelScore - a.modelScore || b.liquidityUsd - a.liquidityUsd || a.mint.localeCompare(b.mint);
}

function latestTradeForMint(state: PaperEngineState, mint: string): PaperEngineTrade | null {
  let latest: PaperEngineTrade | null = null;
  for (const trade of state.trades) {
    // Trades are appended in ledger order; a later sell can share its entry's
    // millisecond and must still determine the exit-specific re-entry delay.
    if (trade.mint === mint && (latest === null || trade.timestampMs >= latest.timestampMs)) latest = trade;
  }
  return latest;
}

function addTokenCooldownBlocker(
  blockers: string[],
  state: PaperEngineState,
  mint: string,
  nowMs: number,
  config: PaperEngineConfig,
) {
  const lastTrade = latestTradeForMint(state, mint);
  if (lastTrade === null) return;
  const deteriorationExit = lastTrade.side === "SELL" && lastTrade.reason === "buy_ratio_deterioration";
  const liquidityExit = lastTrade.side === "SELL" && lastTrade.reason === "liquidity_drawdown";
  const momentumExit = lastTrade.side === "SELL"
    && (lastTrade.reason === "momentum_reversal" || lastTrade.reason === "volume_fade");
  const reasonCooldownMs = deteriorationExit
    ? config.buyRatioDeteriorationCooldownMs
    : liquidityExit
      ? config.liquidityDrawdownCooldownMs
      : momentumExit
        ? config.momentumBreakCooldownMs
        : 0;
  const requiredCooldownMs = Math.max(config.cooldownMs, reasonCooldownMs);
  if (nowMs - lastTrade.timestampMs >= requiredCooldownMs) return;
  blockers.push(
    deteriorationExit
      ? "Buy-ratio deterioration cooldown is active"
      : liquidityExit
        ? "Liquidity-drawdown cooldown is active"
        : momentumExit
          ? "Momentum-break cooldown is active"
          : "Token cooldown is active",
  );
}

function observationLookup(observations: readonly PaperMarketObservation[]): Map<string, PaperMarketObservation> {
  const lookup = new Map<string, PaperMarketObservation>();
  for (const observation of [...observations].sort((a, b) => a.mint.localeCompare(b.mint))) {
    const existing = lookup.get(observation.mint);
    const timestamp = observationTimestamp(observation);
    const existingTimestamp = existing ? observationTimestamp(existing) : Number.NEGATIVE_INFINITY;
    if (
      !existing ||
      timestamp > existingTimestamp ||
      (timestamp === existingTimestamp && observationTieKey(observation) < observationTieKey(existing))
    ) {
      lookup.set(observation.mint, observation);
    }
  }
  return lookup;
}

function observationTieKey(observation: PaperMarketObservation): string {
  return [
    observation.source,
    observation.priceUsd,
    observation.liquidityUsd,
    observation.volume5mUsd,
    observation.buyRatio,
    observation.modelScore,
  ].join("|");
}

function observationTimestamp(observation: PaperMarketObservation): number {
  if (isFiniteNumber(observation.observedAtMs)) return observation.observedAtMs;
  const parsed = Date.parse(observation.updatedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isFreshObservation(
  observation: PaperMarketObservation,
  nowMs: number,
  config: PaperEngineConfig,
): boolean {
  const isFreshTimestamp = (timestamp: number) => Number.isFinite(timestamp)
    && timestamp <= nowMs + config.maxFutureSkewMs
    && nowMs - timestamp <= config.maxObservationAgeMs;
  // Receiving a cached row again cannot renew the provider's quote timestamp.
  return isFreshTimestamp(Date.parse(observation.updatedAt))
    && (observation.observedAtMs === undefined || isFreshTimestamp(observation.observedAtMs));
}

function isUsableShortWindow(windowMs: number | null | undefined): boolean {
  return isFiniteNumber(windowMs)
    && windowMs >= MIN_SHORT_OBSERVATION_WINDOW_MS
    && windowMs <= MAX_SHORT_OBSERVATION_WINDOW_MS;
}

function observationFromPosition(position: PaperEnginePosition, priceUsd: number): PaperMarketObservation {
  return {
    mint: position.mint,
    symbol: position.symbol,
    name: position.symbol,
    ageSeconds: 0,
    priceUsd,
    change5mPct: 0,
    liquidityUsd: position.lastLiquidityUsd,
    volume5mUsd: 0,
    buyRatio: 0.5,
    buys5m: 0,
    sells5m: 0,
    traders5m: 0,
    organicBuyers5m: 0,
    organicScore: null,
    riskLevel: "Medium",
    modelScore: 0,
    safety: {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      topTenHolderPct: 0,
      liquidityLocked: null,
      priceImpactPct: position.lastImpactPct,
      transferTaxPct: 0,
      verified: false,
    },
    source: "paper-last-mark",
    updatedAt: new Date(position.lastEntryAtMs).toISOString(),
    observedAtMs: position.lastEntryAtMs,
  };
}

function executionImpactPct(observation: PaperMarketObservation, multiplier: number): number {
  return clamp(observation.safety.priceImpactPct * multiplier, 0, 99);
}

/** Invert the existing square-root impact estimate; the configured size is a cap. */
function automaticImpactAllocationCap(observation: PaperMarketObservation, config: PaperEngineConfig): number {
  const referenceImpactPct = observation.safety.priceImpactPct * config.entryImpactMultiplier;
  if (!isFiniteNumber(observation.safety.priceImpactPct) || observation.safety.priceImpactPct < 0
    || !isFiniteNumber(referenceImpactPct) || referenceImpactPct < 0
    || !isPositiveFinite(config.entryNotionalUsd)
    || !isFiniteNumber(config.maxEntryImpactPct) || config.maxEntryImpactPct < 0) return 0;
  if (referenceImpactPct === 0) return config.entryNotionalUsd;
  return config.entryNotionalUsd * Math.min(1, (config.maxEntryImpactPct / referenceImpactPct) ** 2);
}

function notionalImpactPct(
  observation: PaperMarketObservation,
  notionalUsd: number,
  referenceMultiplier: number,
  config: PaperEngineConfig,
): number {
  return executionImpactPct(observation, referenceMultiplier * Math.sqrt(Math.max(0, notionalUsd) / config.entryNotionalUsd));
}

function manualImpactReferencePct(quoteImpactPct: number, allocationUsd: number, config: PaperEngineConfig): number {
  const multiplier = config.exitImpactMultiplier * Math.sqrt(allocationUsd / config.entryNotionalUsd);
  return isPositiveFinite(multiplier) ? quoteImpactPct / multiplier : quoteImpactPct;
}

function coreEntrySafetyBlockers(
  observation: PaperMarketObservation,
  nowMs: number,
  config: PaperEngineConfig,
): string[] {
  const blockers: string[] = [];
  if (!isPositiveFinite(observation.priceUsd)) blockers.push("Price is missing or invalid");
  if (!isFreshObservation(observation, nowMs, config)) blockers.push("Observation is stale or time-invalid");
  if (!isPositiveFinite(observation.liquidityUsd) || observation.liquidityUsd < config.minLiquidityUsd) {
    blockers.push(`Liquidity is below $${config.minLiquidityUsd}`);
  }
  if (!config.allowedRiskLevels.includes(observation.riskLevel)) blockers.push(`Risk level ${observation.riskLevel} is ineligible`);
  if (!config.allowUnconfirmedRiskEligibility
    && (observation.riskEligible === false || (config.requireRiskEligibilityFlag && observation.riskEligible !== true))) {
    blockers.push("Risk eligibility is not confirmed");
  }
  if (observation.auditEligible === false || (config.requireAuditEligibilityFlag && observation.auditEligible !== true)) {
    blockers.push("Audit eligibility is not confirmed");
  }
  if (config.requireMintAuthorityRevoked && !observation.safety.mintAuthorityRevoked) {
    blockers.push("Mint authority is not revoked");
  }
  if (config.requireFreezeAuthorityRevoked && !observation.safety.freezeAuthorityRevoked) {
    blockers.push("Freeze authority is not revoked");
  }
  if (config.requireLiquidityLocked && observation.safety.liquidityLocked !== true) {
    blockers.push("Liquidity lock is not confirmed");
  }
  if (config.requireVerified && !observation.safety.verified) blockers.push("Token is not verified");
  if (!isFiniteNumber(observation.safety.topTenHolderPct) || observation.safety.topTenHolderPct > config.maxTopTenHolderPct) {
    blockers.push(`Top-holder concentration exceeds ${config.maxTopTenHolderPct}%`);
  }
  if (!isFiniteNumber(observation.safety.transferTaxPct) || observation.safety.transferTaxPct > config.maxTransferTaxPct) {
    blockers.push(`Transfer tax exceeds ${config.maxTransferTaxPct}% or is unknown`);
  }
  if (
    !isFiniteNumber(observation.safety.priceImpactPct) ||
    observation.safety.priceImpactPct < 0 ||
    observation.safety.priceImpactPct > config.maxEntryImpactPct
  ) {
    blockers.push(`Entry impact exceeds ${config.maxEntryImpactPct}% or is unknown`);
  }
  return blockers;
}

function checkOptionalMinimum(
  blockers: string[],
  label: string,
  value: number | null | undefined,
  minimum: number,
  requireAvailability: boolean,
): void {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    if (requireAvailability) blockers.push(`${label} is unavailable`);
    return;
  }
  if (value < minimum) blockers.push(`${label} is below ${minimum}`);
}

function exit(mint: string, reason: ExitEvaluation["reason"]): ExitEvaluation {
  return { mint, shouldExit: true, reason };
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function assertTimestamp(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("nowMs must be a finite non-negative timestamp");
}

function assertFinitePositive(value: number, label: string): void {
  if (!isPositiveFinite(value)) throw new Error(`${label} must be finite and positive`);
}
