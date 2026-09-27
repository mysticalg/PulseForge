import type { FeedMode } from "../types";
import type { PaperAutomationSettings } from "./automationSettings";
import {
  compareEntryCandidates,
  evaluatePaperEntry,
  evaluatePaperExit,
  type PaperEngineConfig,
  type PaperEnginePosition,
  type PaperEngineState,
  type PaperMarketObservation,
} from "./paperEngine";
import { paperConfig } from "./paperRuntime";

export interface LiveTradingConfig {
  entryMode?: "guardedDiscovery" | "paperSignals";
  paperEntryCriteria?: PaperEntryCriteria | null;
  maxOrderUsd: number;
  dailyBuyCapUsd: number;
  maxOpenPositions: number;
  dailyLossLimitUsd: number;
  maxSlippageBps: number;
  maxPriceImpactPct: number;
  minLiquidityUsd: number;
  allowHighRisk: boolean;
}

export interface PaperEntryCriteria {
  minTokenAgeSeconds: number;
  maxTokenAgeSeconds: number;
  minLiquidityUsd: number;
  maxTopTenHolderPct: number;
  minTraders5m: number;
  minSells5m: number;
}

/** Captures only entry evidence; paper bankroll never sizes a real order. */
export function capturePaperEntryCriteria(settings: PaperAutomationSettings): PaperEntryCriteria {
  const config = paperConfig(settings, strategyState([], 0, 0));
  return { minTokenAgeSeconds: config.minTokenAgeSeconds, maxTokenAgeSeconds: config.maxTokenAgeSeconds,
    minLiquidityUsd: config.minLiquidityUsd, maxTopTenHolderPct: config.maxTopTenHolderPct,
    minTraders5m: config.minTraders5m, minSells5m: config.minSells5m };
}

export interface LiveTradingRequest {
  sessionGeneration: number;
  intentId: string;
  side: "BUY" | "SELL";
  mint: string;
  amountUsd?: number;
  positionId?: string;
  reason: string;
  signalAtMs: number;
}

export interface LivePosition {
  id: string;
  mint: string;
  symbol: string;
  quantityRaw: string;
  decimals: number;
  entryPriceUsd: number;
  costBasisUsd: number;
  openedAtMs: number;
  highWaterPriceUsd: number;
  lastPriceUsd: number;
  /** Native provider timestamp; absent/zero means there is no verified market mark. */
  lastMarkAtMs?: number;
  /** Present when the native ledger recorded the confirmed entry's liquidity. */
  entryLiquidityUsd?: number;
}

export interface QuarantinedLivePosition {
  position: LivePosition;
  quarantinedAtMs: number;
  riskLossUsd: number;
}

export interface LiveOrder {
  id: string;
  side: "BUY" | "SELL";
  mint: string;
  symbol: string;
  status: string;
  signature: string | null;
  amountUsd: number | null;
  detail: string | null;
  createdAtMs: number;
  reason?: string;
}

export interface LiveTradingStatus {
  sessionGeneration: number;
  available: boolean;
  armed: boolean;
  owner: string | null;
  blocker: string | null;
  config: LiveTradingConfig;
  acknowledgementPhrase: string;
  dailyBuyUsedUsd: number;
  dailyRealizedPnlUsd: number;
  /** Trusted native observation history; absent status from an older app blocks new buys. */
  entrySafety?: Record<string, { ready: boolean; blocker: string | null }>;
  exitAttempts?: Record<string, { order: LiveOrder; retryAfterMs: number }>;
  dailyQuarantineLossUsd?: number;
  quarantinedPositions?: QuarantinedLivePosition[];
  pendingCount: number;
  positions: LivePosition[];
  recentOrders: LiveOrder[];
}

/** Mandatory live buy floors. Native execution rechecks these before signing. */
export const LIVE_ENTRY_SAFETY = {
  minPoolAgeSeconds: 86_400,
  minLiquidityUsd: 20_000,
  maxTopTenHolderPct: 20,
  minTraders5m: 25,
  minSells5m: 10,
} as const;

export const defaultLiveTradingConfig: LiveTradingConfig = {
  maxOrderUsd: 5,
  dailyBuyCapUsd: 25,
  maxOpenPositions: 2,
  dailyLossLimitUsd: 10,
  maxSlippageBps: 100,
  maxPriceImpactPct: 2,
  minLiquidityUsd: LIVE_ENTRY_SAFETY.minLiquidityUsd,
  allowHighRisk: false,
};

export const emptyLiveTradingStatus: LiveTradingStatus = {
  sessionGeneration: 0,
  available: false,
  armed: false,
  owner: null,
  blocker: "Open the Windows desktop app to use live wallet automation.",
  config: { ...defaultLiveTradingConfig },
  acknowledgementPhrase: "I AUTHORIZE AUTOMATIC TRADING WITH REAL FUNDS",
  dailyBuyUsedUsd: 0,
  dailyRealizedPnlUsd: 0,
  entrySafety: {},
  dailyQuarantineLossUsd: 0,
  quarantinedPositions: [],
  pendingCount: 0,
  positions: [],
  recentOrders: [],
};

export interface LivePlanOptions {
  mode: FeedMode;
  /** Stops new buys while continuing management of confirmed bot positions. */
  pauseEntries?: boolean;
  /** Fresh event delivered by the running paper cycle, never reconstructed from its ledger. */
  paperSignal?: { intentId: string; mint: string; reason: string; signalAtMs: number };
  /** Sticky close instructions linked by exact confirmed live position ID. */
  paperExits?: Readonly<Record<string, { reason: string; intentId: string }>>;
}

export interface LiveIntentPlan {
  request: LiveTradingRequest | null;
  message: string;
}

const ENTRY_FAILURE_BACKOFF_MS = 30_000;
const EXIT_FAILURE_BACKOFF_MS = 15_000;
const MAX_MARK_AGE_MS = 75_000;

export function hasFreshLiveMark(position: LivePosition, nowMs: number): boolean {
  const at = position.lastMarkAtMs;
  return Number.isFinite(nowMs) && typeof at === "number" && Number.isFinite(at)
    && at > 0 && at <= nowMs && nowMs - at <= MAX_MARK_AGE_MS
    && Number.isFinite(position.lastPriceUsd) && position.lastPriceUsd > 0;
}
const MIN_ORDER_USD = 1;

/**
 * Strategy suggestions only. The native ledger is authoritative; this function
 * neither creates fills nor changes holdings. Native execution rechecks wallet
 * SOL, caps, routes, mint safety, freshness and intent uniqueness before signing.
 * Paper settings.enabled and paper capital never authorize or size a live buy.
 */
export function planLiveIntent(
  status: LiveTradingStatus,
  observations: readonly PaperMarketObservation[],
  settings: PaperAutomationSettings,
  nowMs: number,
  options: LivePlanOptions,
): LiveIntentPlan {
  const wait = (message: string): LiveIntentPlan => ({ request: null, message });
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > 8.64e15) return wait("Live strategy needs a valid clock");
  if (!status.available) return wait(status.blocker ?? "Live wallet automation is unavailable");
  if (!status.armed || !status.owner) return wait("Live wallet automation is disarmed");
  if (!Number.isSafeInteger(status.sessionGeneration) || status.sessionGeneration < 0) return wait("Live session identity is unavailable");
  if (!validConfig(status.config)) return wait("Live execution limits are invalid");
  if (!Number.isInteger(status.pendingCount) || status.pendingCount < 0
    || status.pendingCount > 0 || status.recentOrders.some(isUnresolved)) {
    return wait("Waiting for the pending live order to reconcile");
  }

  const fresh = options.mode === "live" ? freshestObservations(observations, nowMs) : new Map<string, PaperMarketObservation>();
  const projected = status.positions.map((position) => projectPosition(position, fresh.get(position.mint)));
  // This capacity is only the remaining buy allowance, not a wallet balance.
  // Wallet SOL and the fee reserve are enforced by the native executor.
  const remainingBuyCapacityUsd = Number.isFinite(status.dailyBuyUsedUsd) && status.dailyBuyUsedUsd >= 0
    ? Math.max(0, status.config.dailyBuyCapUsd - status.dailyBuyUsedUsd) : 0;
  const state = strategyState(projected.filter((position) => position !== null), remainingBuyCapacityUsd, nowMs);
  const config = liveStrategyConfig(settings, state, status.config);
  let exitWaiting = false;
  const unpricedSymbols: string[] = [];

  for (const position of [...status.positions].sort((a, b) => a.openedAtMs - b.openedAtMs || a.id.localeCompare(b.id))) {
    const candidate = fresh.get(position.mint);
    const observation = candidate && Date.parse(candidate.updatedAt) >= Math.max(position.openedAtMs, position.lastMarkAtMs ?? 0) ? candidate : undefined;
    const projection = projectPosition(position, observation);
    if (!projection) { unpricedSymbols.push(position.symbol || position.mint.slice(0, 8)); continue; }
    const persisted = status.exitAttempts?.[position.id];
    const recent = status.recentOrders.filter(order => order.side === "SELL" && order.mint === position.mint
      && order.createdAtMs >= position.openedAtMs).sort((a,b) => b.createdAtMs - a.createdAtMs)[0];
    const attempt = persisted?.order ?? recent;
    const retryAt = persisted?.retryAfterMs ?? (attempt ? attempt.createdAtMs + EXIT_FAILURE_BACKOFF_MS : 0);
    const dueToClock = Number.isFinite(settings.maxHoldMinutes) && settings.maxHoldMinutes > 0
      && nowMs - position.openedAtMs >= settings.maxHoldMinutes * 60_000;
    const paperExit = options.paperExits?.[position.id];
    let reason = paperExit?.reason ?? (attempt && isFailed(attempt) ? attempt.reason || "exit_retry" : dueToClock ? "max_hold" : undefined);
    if (!reason && observation) {
      const exitConfig = positive(position.entryLiquidityUsd) ? config : { ...config, exitLiquidityDrawdownPct: 0 };
      const evaluation = evaluatePaperExit(projection, { ...observation, safety: { ...observation.safety, priceImpactPct: 0 } }, nowMs, exitConfig);
      if (evaluation.shouldExit && evaluation.reason) reason = evaluation.reason;
    }
    if (!reason) {
      if (!observation) unpricedSymbols.push(position.symbol || position.mint.slice(0, 8));
      continue;
    }
    if (attempt && (!Number.isFinite(retryAt) || nowMs < retryAt)) { exitWaiting = true; continue; }
    // This timestamp is a fresh exit instruction, not a fabricated market mark.
    // Native execution requests a new quote and validates exact owned amounts.
    const request: LiveTradingRequest = { sessionGeneration: status.sessionGeneration,
      intentId: paperExit?.intentId ?? `exit:${status.owner}:${position.mint}:${position.openedAtMs}:${Math.floor(nowMs / EXIT_FAILURE_BACKOFF_MS)}`,
      side: "SELL", mint: position.mint, positionId: position.id, reason, signalAtMs: nowMs };
    if (status.recentOrders.some(order => order.id === request.intentId) || attempt?.id === request.intentId) { exitWaiting = true; continue; }
    return { request, message: `Live exit quote requested: ${position.symbol} (${reason.replaceAll("_", " ")})` };
  }

  // An unpriced or unresolved exit takes precedence over opening more exposure.
  if (unpricedSymbols.length) return wait(`New live entries blocked: ${unpricedSymbols.join(", ")} has no fresh price. Tokens remain held; scanning continues.`);
  if (exitWaiting) return wait("New live entries blocked while an exit is waiting for its retry cooldown; scanning continues.");
  if (options.mode !== "live") return wait("Live automation is waiting for the live market feed");
  if (options.pauseEntries) return wait("Live entries paused · existing positions remain managed");
  if (!Number.isFinite(status.dailyRealizedPnlUsd)) return wait("Live daily profit and loss is unavailable");
  const quarantineLoss = status.dailyQuarantineLossUsd ?? 0;
  if (!Number.isFinite(quarantineLoss) || quarantineLoss < 0) return wait("Live quarantine risk accounting is unavailable");
  if (status.dailyRealizedPnlUsd - quarantineLoss <= -status.config.dailyLossLimitUsd) return wait("Live daily loss limit reached including quarantine risk losses; exits remain active");
  if (remainingBuyCapacityUsd < MIN_ORDER_USD) return wait("Live daily buy allowance exhausted · exits remain active");
  if (projected.some((position) => position === null)) return wait("A live position needs ledger reconciliation");
  if (status.positions.length >= status.config.maxOpenPositions) return wait("Live position limit reached · exits remain active");

  const globalEntrySpacingMs = settings.strategyId === "conservative" ? 60_000 : 45_000;
  if (status.recentOrders.some((order) => order.side === "BUY" && isConfirmed(order)
    && within(nowMs, order.createdAtMs, globalEntrySpacingMs))) return wait("Live entry spacing is active");

  if (status.config.entryMode === "paperSignals") {
    const signal = options.paperSignal;
    if (!signal) return wait("Following paper · waiting for its next automatic entry");
    if (!Number.isFinite(signal.signalAtMs) || signal.signalAtMs <= 0 || signal.signalAtMs > nowMs
      || nowMs - signal.signalAtMs > MAX_MARK_AGE_MS) return wait("Paper entry expired before live execution");
    const criteria = status.config.paperEntryCriteria;
    if (!criteria || !validPaperCriteria(criteria)) return wait("Reviewed paper entry criteria are unavailable");
    const observation = fresh.get(signal.mint);
    if (!observation) return wait("Paper entry is waiting for a fresh live token mark");
    if (status.positions.some(position => position.mint === signal.mint)) return wait("Paper token already has a managed live position");
    if (status.quarantinedPositions?.some(row => row.position.mint === signal.mint)) return wait("Automatic re-entry into a quarantined mint is blocked");
    if (mintCooldown(status.recentOrders, signal.mint, settings, nowMs)) return wait("Token cooldown is active");
    if (!Number.isFinite(observation.ageSeconds) || observation.ageSeconds < criteria.minTokenAgeSeconds
      || observation.ageSeconds > criteria.maxTokenAgeSeconds) return wait("Paper token is outside the reviewed pool age window");
    if (!positive(observation.liquidityUsd)
      || observation.liquidityUsd < Math.max(2_000, status.config.minLiquidityUsd, criteria.minLiquidityUsd)) {
      return wait("Paper token liquidity is below the reviewed live minimum");
    }
    if (!Number.isFinite(observation.safety.topTenHolderPct) || observation.safety.topTenHolderPct > criteria.maxTopTenHolderPct
      || !Number.isFinite(observation.traders5m) || observation.traders5m < criteria.minTraders5m
      || !Number.isFinite(observation.sells5m) || observation.sells5m < criteria.minSells5m) return wait("Paper token no longer meets the reviewed holder and activity limits");
    if (!observation.safety.mintAuthorityRevoked || !observation.safety.freezeAuthorityRevoked
      || observation.safety.transferTaxUnknown || !Number.isFinite(observation.safety.transferTaxPct)
      || observation.safety.transferTaxPct > 1) return wait("Paper token mint safety verification failed or is pending");
    if (!status.config.allowHighRisk && !["Low", "Medium"].includes(observation.riskLevel)) return wait("Live elevated-risk permission is off");
    const safety = status.entrySafety?.[signal.mint];
    if (safety?.ready !== true) return wait(safety?.blocker ?? "Native paper entry safety is pending");
    if (status.recentOrders.some(order => order.id === signal.intentId)) return wait("This paper entry has already been processed");
    const amountUsd = Math.floor(Math.min(status.config.maxOrderUsd, remainingBuyCapacityUsd) * 100) / 100;
    if (amountUsd < MIN_ORDER_USD) return wait("Live allocation is below the minimum order");
    return { request: { ...signal, sessionGeneration: status.sessionGeneration, side: "BUY", amountUsd },
      message: `Following paper entry · ${observation.symbol} · $${amountUsd.toFixed(2)}` };
  }

  // Only new exposure gets the mature-pool policy. Captured paper launch ages
  // and the existing exit strategy remain unchanged, including held young pools.
  const entryConfig: PaperEngineConfig = {
    ...config,
    minTokenAgeSeconds: Math.max(config.minTokenAgeSeconds, LIVE_ENTRY_SAFETY.minPoolAgeSeconds),
    maxTokenAgeSeconds: Number.MAX_SAFE_INTEGER,
    minLiquidityUsd: Math.max(config.minLiquidityUsd, LIVE_ENTRY_SAFETY.minLiquidityUsd),
    maxTopTenHolderPct: Math.min(config.maxTopTenHolderPct, LIVE_ENTRY_SAFETY.maxTopTenHolderPct),
    minTraders5m: Math.max(config.minTraders5m, LIVE_ENTRY_SAFETY.minTraders5m),
    minSells5m: Math.max(config.minSells5m, LIVE_ENTRY_SAFETY.minSells5m),
  };
  const candidates = [...fresh.values()].sort((a, b) => compareEntryCandidates(a, b, entryConfig));
  let firstBlocker: string | undefined;
  for (const observation of candidates) {
    if (status.quarantinedPositions?.some(row => row.position.mint === observation.mint)) {
      firstBlocker ??= "Automatic re-entry into a quarantined mint is blocked";
      continue;
    }
    if (observation.safety.transferTaxUnknown) {
      firstBlocker ??= "Mint transfer-fee verification is pending";
      continue;
    }
    if (mintCooldown(status.recentOrders, observation.mint, settings, nowMs)) {
      firstBlocker ??= "Token cooldown is active";
      continue;
    }
    if (!Number.isFinite(observation.ageSeconds) || observation.ageSeconds < entryConfig.minTokenAgeSeconds) {
      firstBlocker ??= `Pool age must be at least ${entryConfig.minTokenAgeSeconds / 3_600} hours for live entries`;
      continue;
    }
    const evaluation = evaluatePaperEntry(state, observation, nowMs, entryConfig);
    if (!evaluation.eligible) {
      firstBlocker ??= evaluation.blockers[0];
      continue;
    }
    const nativeSafety = status.entrySafety?.[observation.mint];
    if (nativeSafety?.ready !== true) {
      firstBlocker ??= nativeSafety?.blocker ?? "Native entry safety is pending; waiting for verified liquidity history";
      continue;
    }
    const amountUsd = Math.floor(evaluation.allocationUsd * 100) / 100;
    if (!Number.isFinite(amountUsd) || amountUsd < MIN_ORDER_USD) {
      firstBlocker ??= "Live allocation is below the minimum order";
      continue;
    }
    const request = requestFor(status, "BUY", observation,
      settings.strategyId === "launch-flow" ? "automatic_launch_flow"
        : settings.strategyId === "pump-scalp" ? "automatic_pump_scalp" : "automatic_conservative",
      { amountUsd });
    if (status.recentOrders.some((order) => order.id === request.intentId)) {
      firstBlocker ??= "This live signal has already been processed";
      continue;
    }
    return { request, message: `Live entry signal · ${observation.symbol} · $${request.amountUsd!.toFixed(2)}` };
  }
  return wait(candidates.length === 0 ? "Waiting for fresh live observations"
    : `Live scanning · ${firstBlocker ?? "no candidate passes every entry gate"}`);
}

function requestFor(
  status: LiveTradingStatus,
  side: "BUY" | "SELL",
  observation: PaperMarketObservation,
  reason: string,
  amounts: Pick<LiveTradingRequest, "amountUsd" | "positionId">,
): LiveTradingRequest {
  const signalAtMs = Date.parse(observation.updatedAt);
  // Exact owner, mint, side and provider timestamp remain stable through polls
  // and restarts. The native database must reject duplicate IDs in every state.
  return { sessionGeneration: status.sessionGeneration, intentId: `live:${status.owner}:${side}:${observation.mint}:${signalAtMs}`,
    side, mint: observation.mint, reason, signalAtMs, ...amounts };
}

function liveStrategyConfig(
  settings: PaperAutomationSettings,
  state: PaperEngineState,
  limits: LiveTradingConfig,
): PaperEngineConfig {
  return {
    ...paperConfig(settings, state),
    entryNotionalUsd: limits.maxOrderUsd,
    minOrderUsd: MIN_ORDER_USD,
    maxOpenPositions: limits.maxOpenPositions,
    minLiquidityUsd: Math.max(settings.minLiquidityUsd, limits.minLiquidityUsd),
    maxEntryImpactPct: Math.min(settings.maxPriceImpactPct, limits.maxPriceImpactPct),
    maxAllocationPerTokenPct: 100,
    maxAllocationPerTokenUsd: limits.maxOrderUsd,
    minCashReserveUsd: 0,
    minCashReservePct: 0,
    allowedRiskLevels: limits.allowHighRisk ? ["Low", "Medium", "Med-High", "High"] : ["Low", "Medium"],
    allowUnconfirmedRiskEligibility: limits.allowHighRisk,
    // Entry impact remains a sizing estimate. Live returns and stops use actual
    // confirmed cost basis with current marks; no paper fee or impact is booked.
    entryImpactMultiplier: Math.sqrt(limits.maxOrderUsd / 250),
    exitImpactMultiplier: 0,
    feeRateBps: 0,
    maxObservationAgeMs: MAX_MARK_AGE_MS,
    maxFutureSkewMs: 0,
  };
}

function projectPosition(position: LivePosition, observation?: PaperMarketObservation): PaperEnginePosition | null {
  if (!/^\d{1,20}$/.test(position.quantityRaw) || BigInt(position.quantityRaw) > 18_446_744_073_709_551_615n
    || !Number.isInteger(position.decimals) || position.decimals < 0 || position.decimals > 255
    || !positive(position.entryPriceUsd) || !positive(position.costBasisUsd)
    || !Number.isFinite(position.openedAtMs) || position.openedAtMs < 0) return null;
  const quantity = Number(position.quantityRaw) / 10 ** position.decimals;
  if (!positive(quantity)) return null;
  const lastPriceUsd = observation?.priceUsd ?? (positive(position.lastPriceUsd) ? position.lastPriceUsd : position.entryPriceUsd);
  return {
    mint: position.mint, symbol: position.symbol, quantity, costBasisUsd: position.costBasisUsd,
    averageFillPriceUsd: position.entryPriceUsd, openedAtMs: position.openedAtMs, lastEntryAtMs: position.openedAtMs,
    entryLiquidityUsd: positive(position.entryLiquidityUsd) ? position.entryLiquidityUsd : 0,
    lastLiquidityUsd: observation?.liquidityUsd ?? 0,
    lastPriceUsd, highestPriceUsd: Math.max(position.entryPriceUsd, lastPriceUsd,
      positive(position.highWaterPriceUsd) ? position.highWaterPriceUsd : position.entryPriceUsd),
    lastImpactPct: 0,
  };
}

function strategyState(positions: PaperEnginePosition[], capacityUsd: number, nowMs: number): PaperEngineState {
  const equity = Math.max(MIN_ORDER_USD, capacityUsd + positions.reduce((sum, position) => sum + position.costBasisUsd, 0));
  return { startingEquityUsd: equity, cashUsd: capacityUsd, positions, trades: [], realizedPnlUsd: 0,
    nextTradeSequence: 1, dayKey: new Date(nowMs).toISOString().slice(0, 10),
    dayStartEquityUsd: equity, dailyLossLockedDay: null };
}

function freshestObservations(observations: readonly PaperMarketObservation[], nowMs: number): Map<string, PaperMarketObservation> {
  const fresh = new Map<string, PaperMarketObservation>();
  for (const observation of observations) {
    const sourceAt = Date.parse(observation.updatedAt);
    const receiptAt = observation.observedAtMs ?? sourceAt;
    if (!positive(observation.priceUsd) || ![sourceAt, receiptAt].every((at) => Number.isFinite(at)
      && at <= nowMs && nowMs - at <= MAX_MARK_AGE_MS)) continue;
    const previous = fresh.get(observation.mint);
    if (!previous || Date.parse(previous.updatedAt) < sourceAt) fresh.set(observation.mint, observation);
  }
  return fresh;
}

function mintCooldown(orders: readonly LiveOrder[], mint: string, settings: PaperAutomationSettings, nowMs: number): boolean {
  return orders.some((order) => {
    if (order.mint !== mint) return false;
    if (isFailed(order)) return within(nowMs, order.createdAtMs, ENTRY_FAILURE_BACKOFF_MS);
    if (!isConfirmed(order)) return true;
    const reasonMinutes = order.side !== "SELL" ? 0
      : order.reason === "buy_ratio_deterioration" ? settings.buyRatioDeteriorationCooldownMinutes
        : order.reason === "liquidity_drawdown" ? settings.liquidityDrawdownCooldownMinutes
          : order.reason === "momentum_reversal" || order.reason === "volume_fade" ? settings.momentumBreakCooldownMinutes : 0;
    return within(nowMs, order.createdAtMs, Math.max(settings.cooldownMinutes, reasonMinutes) * 60_000);
  });
}

function within(nowMs: number, timestampMs: number, durationMs: number): boolean {
  return !Number.isFinite(timestampMs) || timestampMs > nowMs || nowMs - timestampMs < durationMs;
}

function isConfirmed(order: LiveOrder): boolean {
  return ["confirmed", "success", "succeeded", "finalized"].includes(order.status.toLowerCase());
}

function isFailed(order: LiveOrder): boolean {
  return ["failed", "rejected", "expired", "cancelled", "canceled"].includes(order.status.toLowerCase());
}

function isUnresolved(order: LiveOrder): boolean {
  return !isConfirmed(order) && !isFailed(order);
}

function positive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validConfig(config: LiveTradingConfig): boolean {
  return positive(config.maxOrderUsd) && positive(config.dailyBuyCapUsd)
    && positive(config.dailyLossLimitUsd) && positive(config.minLiquidityUsd)
    && Number.isInteger(config.maxOpenPositions) && config.maxOpenPositions > 0
    && Number.isInteger(config.maxSlippageBps) && config.maxSlippageBps >= 0 && config.maxSlippageBps <= 10_000
    && Number.isFinite(config.maxPriceImpactPct) && config.maxPriceImpactPct >= 0 && config.maxPriceImpactPct < 100
    && typeof config.allowHighRisk === "boolean"
    && (config.entryMode === undefined || config.entryMode === "guardedDiscovery" || config.entryMode === "paperSignals");
}

function validPaperCriteria(criteria: PaperEntryCriteria): boolean {
  return Object.values(criteria).every(value => Number.isFinite(value) && value >= 0)
    && criteria.maxTokenAgeSeconds >= criteria.minTokenAgeSeconds && criteria.minLiquidityUsd >= 2_000
    && criteria.maxTokenAgeSeconds <= 1_000_000_000_000 && criteria.maxTopTenHolderPct <= 35
    && Number.isInteger(criteria.minTraders5m) && criteria.minTraders5m <= 1_000_000_000
    && Number.isInteger(criteria.minSells5m) && criteria.minSells5m <= 1_000_000_000;
}
