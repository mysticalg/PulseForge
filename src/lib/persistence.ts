import {
  DEFAULT_PAPER_AUTOMATION_SETTINGS,
  type PaperAutomationSettings,
} from "./automationSettings";
import {
  createPaperEngineState,
  type PaperEnginePosition,
  type PaperEngineState,
  type PaperEngineTrade,
} from "./paperEngine";

/**
 * WebView storage is deliberately restricted to simulated paper-trading data.
 * Wallet credentials, API keys, signed transactions, and live-execution state
 * must never be added to this schema.
 */
export const PAPER_STORAGE_KEY = "pulseforge.paper-state";
export const PAPER_STORAGE_VERSION = 11 as const;
export const DEFAULT_PAPER_ORDER_SIZE_USD = 25;
export const DEFAULT_PAPER_KILL_SWITCH = false;

const MAX_SERIALIZED_CHARS = 1_500_000;
const MAX_POSITIONS = 500;
const MAX_TRADES = 5_000;
const MAX_USD = 1_000_000_000_000;
const MAX_QUANTITY = 1e30;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

const BASE58_PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEMO_MINT = /^DemoMint\d{2}1{20,40}$/;
const PAPER_TRADE_ID = /^paper-(\d+)$/;
const UTC_DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const BUY_REASONS = new Set([
  "automatic_entry",
  "automatic_conservative",
  "automatic_pump_scalp",
  "automatic_launch_flow",
  "manual_entry",
]);
const SELL_REASONS = new Set([
  "illiquid_writeoff",
  "take_profit",
  "profit_lock",
  "stop_loss",
  "trailing_stop",
  "max_hold",
  "buy_ratio_deterioration",
  "momentum_reversal",
  "volume_fade",
  "liquidity_drawdown",
  "kill_switch",
  "daily_loss",
  "manual_25",
  "manual_50",
  "manual_100",
]);

export interface PersistedPaperState {
  engineState: PaperEngineState;
  automationSettings: PaperAutomationSettings;
  orderSizeUsd: number;
  /** Global paper-engine control; it is not a live-wallet execution setting. */
  killSwitch: boolean;
}

export interface PaperStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PaperLoadSource = "default" | "stored" | "migrated" | "migration-fallback";
export type PaperLoadIssue =
  | "storage-unavailable"
  | "storage-read-failed"
  | "corrupt-json"
  | "unsupported-version"
  | "invalid-data"
  | "legacy-data-not-migratable";

export interface PaperLoadResult {
  state: PersistedPaperState;
  source: PaperLoadSource;
  issue: PaperLoadIssue | null;
}

interface StoredEnvelopeV10 {
  version: typeof PAPER_STORAGE_VERSION;
  savedAt: string;
  paper: PersistedPaperState;
}

interface LegacyPaperPosition {
  mint: string;
  symbol: string;
  quantity: number;
  averagePriceUsd: number;
  lastPriceUsd: number;
  openedAt: string;
}

interface LegacyPaperTrade {
  id: string;
  mint: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  fillPriceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  timestamp: string;
}

interface LegacyPaperAccount {
  startingEquityUsd: number;
  cashUsd: number;
  positions: LegacyPaperPosition[];
  trades: LegacyPaperTrade[];
  realizedPnlUsd: number;
}

export function createDefaultPaperState(nowMs: number = Date.now()): PersistedPaperState {
  const safeNowMs = normalizedNowMs(nowMs);
  const automationSettings = { ...DEFAULT_PAPER_AUTOMATION_SETTINGS };
  return {
    engineState: createPaperEngineState(automationSettings.portfolioBudgetUsd, safeNowMs),
    automationSettings,
    orderSizeUsd: DEFAULT_PAPER_ORDER_SIZE_USD,
    killSwitch: DEFAULT_PAPER_KILL_SWITCH,
  };
}

function browserStorage(): PaperStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function normalizedNowMs(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP_MS ? value : Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? value as number
    : null;
}

function boundedText(value: unknown, maximumCharacters: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (
    cleaned.length === 0 ||
    Array.from(cleaned).length > maximumCharacters ||
    /[\u0000-\u001f\u007f]/u.test(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

function publicMint(value: unknown): string | null {
  const mint = boundedText(value, 64);
  return mint !== null && (BASE58_PUBLIC_KEY.test(mint) || DEMO_MINT.test(mint)) ? mint : null;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function timestampMs(value: unknown): number | null {
  return boundedInteger(value, 0, MAX_TIMESTAMP_MS);
}

function dayKey(value: unknown): string | null {
  if (typeof value !== "string" || !UTC_DAY_KEY.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}

function approximatelyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-9;
}

function sanitizeEnginePosition(value: unknown): PaperEnginePosition | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "mint",
    "symbol",
    "quantity",
    "costBasisUsd",
    "averageFillPriceUsd",
    "openedAtMs",
    "lastEntryAtMs",
    "entryLiquidityUsd",
    "lastLiquidityUsd",
    "lastPriceUsd",
    "highestPriceUsd",
    "lastImpactPct",
  ])) {
    return null;
  }

  const mint = publicMint(value.mint);
  const symbol = boundedText(value.symbol, 32);
  const quantity = boundedNumber(value.quantity, Number.MIN_VALUE, MAX_QUANTITY);
  const costBasisUsd = boundedNumber(value.costBasisUsd, Number.MIN_VALUE, MAX_USD);
  const averageFillPriceUsd = boundedNumber(value.averageFillPriceUsd, Number.MIN_VALUE, MAX_USD);
  const openedAtMs = timestampMs(value.openedAtMs);
  const lastEntryAtMs = timestampMs(value.lastEntryAtMs);
  const entryLiquidityUsd = boundedNumber(value.entryLiquidityUsd, Number.MIN_VALUE, MAX_USD);
  const lastLiquidityUsd = boundedNumber(value.lastLiquidityUsd, Number.MIN_VALUE, MAX_USD);
  const lastPriceUsd = boundedNumber(value.lastPriceUsd, Number.MIN_VALUE, MAX_USD);
  const highestPriceUsd = boundedNumber(value.highestPriceUsd, Number.MIN_VALUE, MAX_USD);
  const lastImpactPct = boundedNumber(value.lastImpactPct, 0, 100);

  if (
    mint === null ||
    symbol === null ||
    quantity === null ||
    costBasisUsd === null ||
    averageFillPriceUsd === null ||
    openedAtMs === null ||
    lastEntryAtMs === null ||
    openedAtMs > lastEntryAtMs ||
    entryLiquidityUsd === null ||
    lastLiquidityUsd === null ||
    lastPriceUsd === null ||
    highestPriceUsd === null ||
    highestPriceUsd < lastPriceUsd ||
    lastImpactPct === null
  ) {
    return null;
  }

  return {
    mint,
    symbol,
    quantity,
    costBasisUsd,
    averageFillPriceUsd,
    openedAtMs,
    lastEntryAtMs,
    entryLiquidityUsd,
    lastLiquidityUsd,
    lastPriceUsd,
    highestPriceUsd,
    lastImpactPct,
  };
}

function sanitizeEngineTrade(value: unknown): PaperEngineTrade | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "mint",
    "symbol",
    "side",
    "quantity",
    "midPriceUsd",
    "fillPriceUsd",
    "notionalUsd",
    "feeUsd",
    "impactCostUsd",
    "cashFlowUsd",
    "realizedPnlUsd",
    "reason",
    "timestampMs",
  ])) {
    return null;
  }

  const id = boundedText(value.id, 32);
  const mint = publicMint(value.mint);
  const symbol = boundedText(value.symbol, 32);
  const side = value.side === "BUY" || value.side === "SELL" ? value.side : null;
  const quantity = boundedNumber(value.quantity, Number.MIN_VALUE, MAX_QUANTITY);
  const writeoff = side === "SELL" && value.reason === "illiquid_writeoff";
  const midPriceUsd = boundedNumber(value.midPriceUsd, writeoff ? 0 : Number.MIN_VALUE, MAX_USD);
  const fillPriceUsd = boundedNumber(value.fillPriceUsd, writeoff ? 0 : Number.MIN_VALUE, MAX_USD);
  const notionalUsd = boundedNumber(value.notionalUsd, writeoff ? 0 : Number.MIN_VALUE, MAX_USD);
  const feeUsd = boundedNumber(value.feeUsd, 0, MAX_USD);
  const impactCostUsd = boundedNumber(value.impactCostUsd, 0, MAX_USD);
  const cashFlowUsd = boundedNumber(value.cashFlowUsd, -MAX_USD, MAX_USD);
  const realizedPnlUsd = boundedNumber(value.realizedPnlUsd, -MAX_USD, MAX_USD);
  const reason = typeof value.reason === "string" ? value.reason : null;
  const tradeTimestampMs = timestampMs(value.timestampMs);
  const validReason = side === "BUY"
    ? reason !== null && BUY_REASONS.has(reason)
    : side === "SELL" && reason !== null && SELL_REASONS.has(reason);

  if (
    id === null ||
    !PAPER_TRADE_ID.test(id) ||
    mint === null ||
    symbol === null ||
    side === null ||
    quantity === null ||
    midPriceUsd === null ||
    fillPriceUsd === null ||
    notionalUsd === null ||
    feeUsd === null ||
    feeUsd > notionalUsd ||
    impactCostUsd === null ||
    cashFlowUsd === null ||
    realizedPnlUsd === null ||
    !validReason ||
    (writeoff && (midPriceUsd !== 0 || fillPriceUsd !== 0 || notionalUsd !== 0 || feeUsd !== 0 || impactCostUsd !== 0 || cashFlowUsd !== 0 || realizedPnlUsd >= 0)) ||
    (side === "BUY" && (cashFlowUsd >= 0 || realizedPnlUsd !== 0)) ||
    (side === "SELL" && cashFlowUsd < 0) ||
    tradeTimestampMs === null
  ) {
    return null;
  }

  return {
    id,
    mint,
    symbol,
    side,
    quantity,
    midPriceUsd,
    fillPriceUsd,
    notionalUsd,
    feeUsd,
    impactCostUsd,
    cashFlowUsd,
    realizedPnlUsd,
    reason: reason as PaperEngineTrade["reason"],
    timestampMs: tradeTimestampMs,
  };
}

function sanitizeEngineState(value: unknown): PaperEngineState | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "startingEquityUsd",
    "cashUsd",
    "positions",
    "trades",
    "realizedPnlUsd",
    "nextTradeSequence",
    "dayKey",
    "dayStartEquityUsd",
    "dailyLossLockedDay",
  ])) {
    return null;
  }

  const startingEquityUsd = boundedNumber(value.startingEquityUsd, Number.MIN_VALUE, MAX_USD);
  const cashUsd = boundedNumber(value.cashUsd, 0, MAX_USD);
  const realizedPnlUsd = boundedNumber(value.realizedPnlUsd, -MAX_USD, MAX_USD);
  const nextTradeSequence = boundedInteger(value.nextTradeSequence, 1, MAX_TRADES + 1);
  const currentDayKey = dayKey(value.dayKey);
  const dayStartEquityUsd = boundedNumber(value.dayStartEquityUsd, 0, MAX_USD);
  const dailyLossLockedDay = value.dailyLossLockedDay === null ? null : dayKey(value.dailyLossLockedDay);

  if (
    startingEquityUsd === null ||
    cashUsd === null ||
    realizedPnlUsd === null ||
    nextTradeSequence === null ||
    currentDayKey === null ||
    dayStartEquityUsd === null ||
    (value.dailyLossLockedDay !== null && dailyLossLockedDay === null) ||
    (dailyLossLockedDay !== null && dailyLossLockedDay !== currentDayKey) ||
    !Array.isArray(value.positions) ||
    !Array.isArray(value.trades) ||
    value.positions.length > MAX_POSITIONS ||
    value.trades.length > MAX_TRADES
  ) {
    return null;
  }

  const positions: PaperEnginePosition[] = [];
  let previousMint: string | null = null;
  for (const candidate of value.positions) {
    const position = sanitizeEnginePosition(candidate);
    if (position === null || (previousMint !== null && previousMint.localeCompare(position.mint) >= 0)) return null;
    previousMint = position.mint;
    positions.push(position);
  }

  const trades: PaperEngineTrade[] = [];
  let previousTimestamp = 0;
  for (let index = 0; index < value.trades.length; index += 1) {
    const trade = sanitizeEngineTrade(value.trades[index]);
    if (trade === null || trade.timestampMs < previousTimestamp) return null;
    const match = PAPER_TRADE_ID.exec(trade.id);
    if (match === null || Number(match[1]) !== index + 1) return null;
    previousTimestamp = trade.timestampMs;
    trades.push(trade);
  }

  if (nextTradeSequence !== trades.length + 1) return null;
  const expectedCash = startingEquityUsd + trades.reduce((total, trade) => total + trade.cashFlowUsd, 0);
  const expectedRealizedPnl = trades.reduce((total, trade) => total + trade.realizedPnlUsd, 0);
  if (!approximatelyEqual(cashUsd, expectedCash) || !approximatelyEqual(realizedPnlUsd, expectedRealizedPnl)) return null;

  return {
    startingEquityUsd,
    cashUsd,
    positions,
    trades,
    realizedPnlUsd,
    nextTradeSequence,
    dayKey: currentDayKey,
    dayStartEquityUsd,
    dailyLossLockedDay,
  };
}

const V3_AUTOMATION_KEYS = [
    "enabled",
    "portfolioBudgetUsd",
    "maxAllocationPerTokenPct",
    "reserveUsd",
    "takeProfitPct",
    "stopLossPct",
    "trailingStopPct",
    "maxHoldMinutes",
    "minModelScore",
    "minBuyRatio",
    "maxBuyRatio",
    "minLiquidityUsd",
    "minVolume5mUsd",
    "minTraders5m",
    "minOrganicBuyers5m",
    "maxPriceImpactPct",
    "dailyLossLimitUsd",
    "cooldownMinutes",
] as const;

const V6_AUTOMATION_KEYS = [
  "enabled",
  "strategyId",
  "allowHighRiskPaperEntries",
  "portfolioBudgetUsd",
  "maxOpenPositions",
  "maxAllocationPerTokenPct",
  "reserveUsd",
  "takeProfitPct",
  "stopLossPct",
  "trailingStopPct",
  "maxHoldMinutes",
  "minModelScore",
  "minBuyRatio",
  "maxBuyRatio",
  "minLiquidityUsd",
  "minVolume5mUsd",
  "minTraders5m",
  "minOrganicBuyers5m",
  "maxPriceImpactPct",
  "dailyLossLimitUsd",
  "cooldownMinutes",
  "minTokenAgeMinutes",
  "maxTokenAgeMinutes",
  "minMomentum5mPct",
  "maxMomentum5mPct",
  "minShortMomentumPct",
  "maxShortMomentumPct",
  "minVolumeToLiquidity",
] as const;

const V7_AUTOMATION_KEYS = [
  ...V6_AUTOMATION_KEYS,
  "minShortVolumeGrowthPct",
] as const;

const V8_AUTOMATION_KEYS = [
  ...V7_AUTOMATION_KEYS,
  "exitBuyRatioBelow",
  "buyRatioDeteriorationCooldownMinutes",
] as const;

const V9_AUTOMATION_KEYS = [
  ...V8_AUTOMATION_KEYS,
  "exitLiquidityDrawdownPct",
  "liquidityDrawdownCooldownMinutes",
] as const;

const V10_AUTOMATION_KEYS = [
  ...V9_AUTOMATION_KEYS,
  "exitShortMomentumBelowPct",
  "exitShortVolumeGrowthBelowPct",
  "momentumBreakCooldownMinutes",
] as const;

const V5_AUTOMATION_KEYS = V6_AUTOMATION_KEYS.filter((key) => key !== "allowHighRiskPaperEntries");
const V4_AUTOMATION_KEYS = V5_AUTOMATION_KEYS.filter((key) => key !== "maxOpenPositions");

function sanitizeAutomationSettings(value: unknown): PaperAutomationSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, V10_AUTOMATION_KEYS)) {
    return null;
  }

  if (
    typeof value.enabled !== "boolean"
    || typeof value.allowHighRiskPaperEntries !== "boolean"
    || (value.strategyId !== "conservative" && value.strategyId !== "pump-scalp" && value.strategyId !== "launch-flow")
  ) return null;
  const portfolioBudgetUsd = boundedNumber(value.portfolioBudgetUsd, 0, 1_000_000);
  const maxOpenPositions = boundedInteger(value.maxOpenPositions, 1, 25);
  const maxAllocationPerTokenPct = boundedNumber(value.maxAllocationPerTokenPct, 0.1, 100);
  const reserveUsd = boundedNumber(value.reserveUsd, 0, 1_000_000);
  const takeProfitPct = boundedNumber(value.takeProfitPct, 0, 1_000);
  const stopLossPct = boundedNumber(value.stopLossPct, 0, 100);
  const trailingStopPct = boundedNumber(value.trailingStopPct, 0, 100);
  const maxHoldMinutes = boundedNumber(value.maxHoldMinutes, 0.25, 43_200);
  const exitBuyRatioBelow = boundedNumber(value.exitBuyRatioBelow, 0, 1);
  const buyRatioDeteriorationCooldownMinutes = boundedNumber(value.buyRatioDeteriorationCooldownMinutes, 0, 10_080);
  const exitLiquidityDrawdownPct = boundedNumber(value.exitLiquidityDrawdownPct, 0, 100);
  const liquidityDrawdownCooldownMinutes = boundedNumber(value.liquidityDrawdownCooldownMinutes, 0, 10_080);
  const exitShortMomentumBelowPct = boundedNumber(value.exitShortMomentumBelowPct, -100, 1_000);
  const exitShortVolumeGrowthBelowPct = boundedNumber(value.exitShortVolumeGrowthBelowPct, -100, 1_000);
  const momentumBreakCooldownMinutes = boundedNumber(value.momentumBreakCooldownMinutes, 0, 10_080);
  const minModelScore = boundedNumber(value.minModelScore, 0, 1);
  const minBuyRatio = boundedNumber(value.minBuyRatio, 0, 1);
  const maxBuyRatio = boundedNumber(value.maxBuyRatio, 0, 1);
  const minLiquidityUsd = boundedNumber(value.minLiquidityUsd, 0, 100_000_000);
  const minVolume5mUsd = boundedNumber(value.minVolume5mUsd, 0, 100_000_000);
  const minTraders5m = boundedNumber(value.minTraders5m, 0, 1_000_000);
  const minOrganicBuyers5m = boundedNumber(value.minOrganicBuyers5m, 0, 1_000_000);
  const maxPriceImpactPct = boundedNumber(value.maxPriceImpactPct, 0, 100);
  const dailyLossLimitUsd = boundedNumber(value.dailyLossLimitUsd, 0, 1_000_000);
  const cooldownMinutes = boundedNumber(value.cooldownMinutes, 0, 10_080);
  const minTokenAgeMinutes = boundedNumber(value.minTokenAgeMinutes, 0, 43_200);
  const maxTokenAgeMinutes = boundedNumber(value.maxTokenAgeMinutes, 0, 43_200);
  const minMomentum5mPct = boundedNumber(value.minMomentum5mPct, -100, 1_000);
  const maxMomentum5mPct = boundedNumber(value.maxMomentum5mPct, -100, 1_000);
  const minShortMomentumPct = boundedNumber(value.minShortMomentumPct, -100, 1_000);
  const maxShortMomentumPct = boundedNumber(value.maxShortMomentumPct, -100, 1_000);
  const minShortVolumeGrowthPct = boundedNumber(value.minShortVolumeGrowthPct, -100, 1_000);
  const minVolumeToLiquidity = boundedNumber(value.minVolumeToLiquidity, 0, 1_000);

  if (
    portfolioBudgetUsd === null ||
    maxOpenPositions === null ||
    maxAllocationPerTokenPct === null ||
    reserveUsd === null ||
    takeProfitPct === null ||
    stopLossPct === null ||
    trailingStopPct === null ||
    maxHoldMinutes === null ||
    exitBuyRatioBelow === null ||
    buyRatioDeteriorationCooldownMinutes === null ||
    exitLiquidityDrawdownPct === null ||
    liquidityDrawdownCooldownMinutes === null ||
    exitShortMomentumBelowPct === null ||
    exitShortVolumeGrowthBelowPct === null ||
    momentumBreakCooldownMinutes === null ||
    minModelScore === null ||
    minBuyRatio === null ||
    maxBuyRatio === null ||
    maxBuyRatio < minBuyRatio ||
    minLiquidityUsd === null ||
    minVolume5mUsd === null ||
    minTraders5m === null ||
    minOrganicBuyers5m === null ||
    maxPriceImpactPct === null ||
    dailyLossLimitUsd === null ||
    cooldownMinutes === null ||
    minTokenAgeMinutes === null ||
    maxTokenAgeMinutes === null ||
    maxTokenAgeMinutes < minTokenAgeMinutes ||
    minMomentum5mPct === null ||
    maxMomentum5mPct === null ||
    maxMomentum5mPct < minMomentum5mPct ||
    minShortMomentumPct === null ||
    maxShortMomentumPct === null ||
    maxShortMomentumPct < minShortMomentumPct ||
    minShortVolumeGrowthPct === null ||
    minVolumeToLiquidity === null
  ) {
    return null;
  }

  return {
    enabled: value.enabled,
    strategyId: value.strategyId,
    allowHighRiskPaperEntries: value.allowHighRiskPaperEntries,
    portfolioBudgetUsd,
    maxOpenPositions,
    maxAllocationPerTokenPct,
    reserveUsd,
    takeProfitPct,
    stopLossPct,
    trailingStopPct,
    maxHoldMinutes,
    exitBuyRatioBelow,
    buyRatioDeteriorationCooldownMinutes,
    exitLiquidityDrawdownPct,
    liquidityDrawdownCooldownMinutes,
    exitShortMomentumBelowPct,
    exitShortVolumeGrowthBelowPct,
    momentumBreakCooldownMinutes,
    minModelScore,
    minBuyRatio,
    maxBuyRatio,
    minLiquidityUsd,
    minVolume5mUsd,
    minTraders5m,
    minOrganicBuyers5m,
    maxPriceImpactPct,
    dailyLossLimitUsd,
    cooldownMinutes,
    minTokenAgeMinutes,
    maxTokenAgeMinutes,
    minMomentum5mPct,
    maxMomentum5mPct,
    minShortMomentumPct,
    maxShortMomentumPct,
    minShortVolumeGrowthPct,
    minVolumeToLiquidity,
  };
}

function sanitizeV9AutomationSettings(value: unknown): PaperAutomationSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, V9_AUTOMATION_KEYS) || typeof value.enabled !== "boolean") return null;
  return sanitizeAutomationSettings({
    ...value,
    // Preserve the previous thresholds and re-entry delay. Migrated automation
    // stays paused until the user enables the updated strategy explicitly.
    enabled: false,
    exitShortMomentumBelowPct: value.strategyId === "launch-flow" ? -0.2 : -100,
    exitShortVolumeGrowthBelowPct: value.strategyId === "launch-flow" ? -5 : -100,
    momentumBreakCooldownMinutes: value.strategyId === "launch-flow" ? value.cooldownMinutes : 0,
  });
}

function sanitizeV8AutomationSettings(value: unknown): PaperAutomationSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, V8_AUTOMATION_KEYS)) return null;
  const previousLiquidityDrawdownPct = value.strategyId === "launch-flow"
    ? 15
    : value.strategyId === "pump-scalp"
      ? 20
      : 30;
  return sanitizeV9AutomationSettings({
    ...value,
    // Preserve the exact v8 exit and re-entry behavior. Selecting a preset
    // applies the new dedicated liquidity-exit cooldown.
    exitLiquidityDrawdownPct: previousLiquidityDrawdownPct,
    liquidityDrawdownCooldownMinutes: value.cooldownMinutes,
  });
}

function sanitizeV7AutomationSettings(value: unknown): PaperAutomationSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, V7_AUTOMATION_KEYS)) return null;
  const minBuyRatio = typeof value.minBuyRatio === "number" && Number.isFinite(value.minBuyRatio)
    ? value.minBuyRatio
    : 0;
  const derivedExitThreshold = value.strategyId === "launch-flow"
    ? Math.max(0, minBuyRatio - 0.15)
    : Math.min(0.5, Math.max(0, minBuyRatio - 0.11));
  const previousExitThreshold = Math.round(derivedExitThreshold * 100) / 100;
  return sanitizeV8AutomationSettings({
    ...value,
    // Preserve the exact v7 behavior. Selecting a strategy preset applies the
    // newer, longer deterioration-specific cooldown.
    exitBuyRatioBelow: previousExitThreshold,
    buyRatioDeteriorationCooldownMinutes: value.cooldownMinutes,
  });
}

function sanitizeV6AutomationSettings(value: unknown): PaperAutomationSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, V6_AUTOMATION_KEYS)) return null;
  return sanitizeV7AutomationSettings({
    ...value,
    minShortVolumeGrowthPct: 0,
  });
}

function sanitizeV5AutomationSettings(value: unknown): PaperAutomationSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, V5_AUTOMATION_KEYS)) return null;
  return sanitizeV7AutomationSettings({
    ...value,
    // Elevated-risk classifications remain blocked unless the user explicitly
    // opts in through the new visible paper-only control.
    allowHighRiskPaperEntries: false,
    minShortVolumeGrowthPct: 0,
  });
}

function sanitizeV4AutomationSettings(value: unknown): PaperAutomationSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, V4_AUTOMATION_KEYS)) return null;
  return sanitizeV7AutomationSettings({
    ...value,
    // Preserve the old hidden exposure rule during migration. The visible
    // setting can then be changed explicitly by the user.
    maxOpenPositions: value.strategyId === "pump-scalp" ? 1 : 5,
    allowHighRiskPaperEntries: false,
    minShortVolumeGrowthPct: 0,
  });
}

function sanitizeV3AutomationSettings(value: unknown): PaperAutomationSettings | null {
  if (!isRecord(value) || !hasExactKeys(value, V3_AUTOMATION_KEYS)) return null;
  const candidate = sanitizeV7AutomationSettings({
    ...value,
    strategyId: "conservative",
    allowHighRiskPaperEntries: false,
    maxOpenPositions: 5,
    minTokenAgeMinutes: 0,
    maxTokenAgeMinutes: 43_200,
    minMomentum5mPct: -100,
    maxMomentum5mPct: 1_000,
    minShortMomentumPct: -100,
    maxShortMomentumPct: 1_000,
    minShortVolumeGrowthPct: 0,
    minVolumeToLiquidity: 0,
  });
  return candidate;
}

function sanitizePaperState(value: unknown): PersistedPaperState | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "engineState",
    "automationSettings",
    "orderSizeUsd",
    "killSwitch",
  ])) {
    return null;
  }
  const engineState = sanitizeEngineState(value.engineState);
  const automationSettings = sanitizeAutomationSettings(value.automationSettings);
  const orderSizeUsd = boundedNumber(value.orderSizeUsd, 5, 250);
  if (
    engineState === null ||
    automationSettings === null ||
    orderSizeUsd === null ||
    typeof value.killSwitch !== "boolean"
  ) {
    return null;
  }
  return { engineState, automationSettings, orderSizeUsd, killSwitch: value.killSwitch };
}

function sanitizeV3PaperState(value: unknown): PersistedPaperState | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "engineState",
    "automationSettings",
    "orderSizeUsd",
    "killSwitch",
  ])) return null;
  const engineState = sanitizeEngineState(value.engineState);
  const automationSettings = sanitizeV3AutomationSettings(value.automationSettings);
  const orderSizeUsd = boundedNumber(value.orderSizeUsd, 5, 250);
  if (
    engineState === null
    || automationSettings === null
    || orderSizeUsd === null
    || typeof value.killSwitch !== "boolean"
  ) return null;
  return { engineState, automationSettings, orderSizeUsd, killSwitch: value.killSwitch };
}

function sanitizeV4PaperState(value: unknown): PersistedPaperState | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "engineState",
    "automationSettings",
    "orderSizeUsd",
    "killSwitch",
  ])) return null;
  const engineState = sanitizeEngineState(value.engineState);
  const automationSettings = sanitizeV4AutomationSettings(value.automationSettings);
  const orderSizeUsd = boundedNumber(value.orderSizeUsd, 5, 250);
  if (
    engineState === null
    || automationSettings === null
    || orderSizeUsd === null
    || typeof value.killSwitch !== "boolean"
  ) return null;
  return { engineState, automationSettings, orderSizeUsd, killSwitch: value.killSwitch };
}

function sanitizeV5PaperState(value: unknown): PersistedPaperState | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "engineState",
    "automationSettings",
    "orderSizeUsd",
    "killSwitch",
  ])) return null;
  const engineState = sanitizeEngineState(value.engineState);
  const automationSettings = sanitizeV5AutomationSettings(value.automationSettings);
  const orderSizeUsd = boundedNumber(value.orderSizeUsd, 5, 250);
  if (
    engineState === null
    || automationSettings === null
    || orderSizeUsd === null
    || typeof value.killSwitch !== "boolean"
  ) return null;
  return { engineState, automationSettings, orderSizeUsd, killSwitch: value.killSwitch };
}

function sanitizeV6PaperState(value: unknown): PersistedPaperState | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "engineState",
    "automationSettings",
    "orderSizeUsd",
    "killSwitch",
  ])) return null;
  const engineState = sanitizeEngineState(value.engineState);
  const automationSettings = sanitizeV6AutomationSettings(value.automationSettings);
  const orderSizeUsd = boundedNumber(value.orderSizeUsd, 5, 250);
  if (
    engineState === null
    || automationSettings === null
    || orderSizeUsd === null
    || typeof value.killSwitch !== "boolean"
  ) return null;
  return { engineState, automationSettings, orderSizeUsd, killSwitch: value.killSwitch };
}

function sanitizeV7PaperState(value: unknown): PersistedPaperState | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "engineState",
    "automationSettings",
    "orderSizeUsd",
    "killSwitch",
  ])) return null;
  const engineState = sanitizeEngineState(value.engineState);
  const automationSettings = sanitizeV7AutomationSettings(value.automationSettings);
  const orderSizeUsd = boundedNumber(value.orderSizeUsd, 5, 250);
  if (
    engineState === null
    || automationSettings === null
    || orderSizeUsd === null
    || typeof value.killSwitch !== "boolean"
  ) return null;
  return { engineState, automationSettings, orderSizeUsd, killSwitch: value.killSwitch };
}

function sanitizeV8PaperState(value: unknown): PersistedPaperState | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "engineState",
    "automationSettings",
    "orderSizeUsd",
    "killSwitch",
  ])) return null;
  const engineState = sanitizeEngineState(value.engineState);
  const automationSettings = sanitizeV8AutomationSettings(value.automationSettings);
  const orderSizeUsd = boundedNumber(value.orderSizeUsd, 5, 250);
  if (
    engineState === null
    || automationSettings === null
    || orderSizeUsd === null
    || typeof value.killSwitch !== "boolean"
  ) return null;
  return { engineState, automationSettings, orderSizeUsd, killSwitch: value.killSwitch };
}

function sanitizeV9PaperState(value: unknown): PersistedPaperState | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "engineState",
    "automationSettings",
    "orderSizeUsd",
    "killSwitch",
  ])) return null;
  const engineState = sanitizeEngineState(value.engineState);
  const automationSettings = sanitizeV9AutomationSettings(value.automationSettings);
  const orderSizeUsd = boundedNumber(value.orderSizeUsd, 5, 250);
  if (
    engineState === null
    || automationSettings === null
    || orderSizeUsd === null
    || typeof value.killSwitch !== "boolean"
  ) return null;
  return { engineState, automationSettings, orderSizeUsd, killSwitch: value.killSwitch };
}

function sanitizeLegacyPosition(value: unknown): LegacyPaperPosition | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "mint",
    "symbol",
    "quantity",
    "averagePriceUsd",
    "lastPriceUsd",
    "openedAt",
  ])) {
    return null;
  }
  const mint = publicMint(value.mint);
  const symbol = boundedText(value.symbol, 32);
  const quantity = boundedNumber(value.quantity, Number.MIN_VALUE, MAX_QUANTITY);
  const averagePriceUsd = boundedNumber(value.averagePriceUsd, Number.MIN_VALUE, MAX_USD);
  const lastPriceUsd = boundedNumber(value.lastPriceUsd, 0, MAX_USD);
  const openedAt = isoTimestamp(value.openedAt);
  return mint === null || symbol === null || quantity === null || averagePriceUsd === null || lastPriceUsd === null || openedAt === null
    ? null
    : { mint, symbol, quantity, averagePriceUsd, lastPriceUsd, openedAt };
}

function sanitizeLegacyTrade(value: unknown): LegacyPaperTrade | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "mint",
    "symbol",
    "side",
    "quantity",
    "fillPriceUsd",
    "notionalUsd",
    "feeUsd",
    "timestamp",
  ])) {
    return null;
  }
  const id = boundedText(value.id, 102);
  const mint = publicMint(value.mint);
  const symbol = boundedText(value.symbol, 32);
  const side = value.side === "BUY" || value.side === "SELL" ? value.side : null;
  const quantity = boundedNumber(value.quantity, Number.MIN_VALUE, MAX_QUANTITY);
  const fillPriceUsd = boundedNumber(value.fillPriceUsd, Number.MIN_VALUE, MAX_USD);
  const notionalUsd = boundedNumber(value.notionalUsd, Number.MIN_VALUE, MAX_USD);
  const feeUsd = boundedNumber(value.feeUsd, 0, MAX_USD);
  const timestamp = isoTimestamp(value.timestamp);
  return id === null || mint === null || symbol === null || side === null || quantity === null || fillPriceUsd === null || notionalUsd === null || feeUsd === null || feeUsd > notionalUsd || timestamp === null
    ? null
    : { id, mint, symbol, side, quantity, fillPriceUsd, notionalUsd, feeUsd, timestamp };
}

function sanitizeLegacyAccount(value: unknown): LegacyPaperAccount | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "startingEquityUsd",
    "cashUsd",
    "positions",
    "trades",
    "realizedPnlUsd",
  ])) {
    return null;
  }
  const startingEquityUsd = boundedNumber(value.startingEquityUsd, Number.MIN_VALUE, MAX_USD);
  const cashUsd = boundedNumber(value.cashUsd, 0, MAX_USD);
  const realizedPnlUsd = boundedNumber(value.realizedPnlUsd, -MAX_USD, MAX_USD);
  if (
    startingEquityUsd === null ||
    cashUsd === null ||
    realizedPnlUsd === null ||
    !Array.isArray(value.positions) ||
    !Array.isArray(value.trades) ||
    value.positions.length > MAX_POSITIONS ||
    value.trades.length > MAX_TRADES
  ) {
    return null;
  }
  const positions = value.positions.map(sanitizeLegacyPosition);
  const trades = value.trades.map(sanitizeLegacyTrade);
  if (positions.some((position) => position === null) || trades.some((trade) => trade === null)) return null;
  return {
    startingEquityUsd,
    cashUsd,
    positions: positions as LegacyPaperPosition[],
    trades: trades as LegacyPaperTrade[],
    realizedPnlUsd,
  };
}

function fallback(issue: PaperLoadIssue | null, nowMs: number): PaperLoadResult {
  return { state: createDefaultPaperState(nowMs), source: "default", issue };
}

function migrateLegacyAccount(
  accountValue: unknown,
  orderSizeValue: unknown,
  killSwitchValue: unknown,
  nowMs: number,
): PaperLoadResult {
  const account = sanitizeLegacyAccount(accountValue);
  const orderSizeUsd = boundedNumber(orderSizeValue, 5, 250);
  if (account === null || orderSizeUsd === null || typeof killSwitchValue !== "boolean") {
    return fallback("invalid-data", nowMs);
  }

  // The old ledger lacks engine liquidity, impact, sequence, and day-lock data.
  // Only a pristine account can therefore be migrated without inventing state.
  if (
    account.positions.length > 0 ||
    account.trades.length > 0 ||
    !approximatelyEqual(account.cashUsd, account.startingEquityUsd) ||
    !approximatelyEqual(account.realizedPnlUsd, 0)
  ) {
    return {
      state: createDefaultPaperState(nowMs),
      source: "migration-fallback",
      issue: "legacy-data-not-migratable",
    };
  }

  return {
    state: {
      engineState: createPaperEngineState(account.startingEquityUsd, nowMs),
      automationSettings: { ...DEFAULT_PAPER_AUTOMATION_SETTINGS },
      orderSizeUsd,
      killSwitch: killSwitchValue,
    },
    source: "migrated",
    issue: null,
  };
}

function decodeStoredState(raw: string, nowMs: number): PaperLoadResult {
  if (raw.length > MAX_SERIALIZED_CHARS) return fallback("invalid-data", nowMs);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return fallback("corrupt-json", nowMs);
  }
  if (!isRecord(decoded) || !Number.isInteger(decoded.version)) return fallback("invalid-data", nowMs);

  if (decoded.version === PAPER_STORAGE_VERSION || decoded.version === 10) {
    if (!hasExactKeys(decoded, ["version", "savedAt", "paper"]) || isoTimestamp(decoded.savedAt) === null) {
      return fallback("invalid-data", nowMs);
    }
    const paper = sanitizePaperState(decoded.paper);
    return paper === null
      ? fallback("invalid-data", nowMs)
      : { state: paper, source: decoded.version === PAPER_STORAGE_VERSION ? "stored" : "migrated", issue: null };
  }

  if (decoded.version === 9) {
    if (!hasExactKeys(decoded, ["version", "savedAt", "paper"]) || isoTimestamp(decoded.savedAt) === null) {
      return fallback("invalid-data", nowMs);
    }
    const paper = sanitizeV9PaperState(decoded.paper);
    return paper === null
      ? fallback("invalid-data", nowMs)
      : { state: paper, source: "migrated", issue: null };
  }

  if (decoded.version === 8) {
    if (!hasExactKeys(decoded, ["version", "savedAt", "paper"]) || isoTimestamp(decoded.savedAt) === null) {
      return fallback("invalid-data", nowMs);
    }
    const paper = sanitizeV8PaperState(decoded.paper);
    return paper === null
      ? fallback("invalid-data", nowMs)
      : { state: paper, source: "migrated", issue: null };
  }

  if (decoded.version === 7) {
    if (!hasExactKeys(decoded, ["version", "savedAt", "paper"]) || isoTimestamp(decoded.savedAt) === null) {
      return fallback("invalid-data", nowMs);
    }
    const paper = sanitizeV7PaperState(decoded.paper);
    return paper === null
      ? fallback("invalid-data", nowMs)
      : { state: paper, source: "migrated", issue: null };
  }

  if (decoded.version === 6) {
    if (!hasExactKeys(decoded, ["version", "savedAt", "paper"]) || isoTimestamp(decoded.savedAt) === null) {
      return fallback("invalid-data", nowMs);
    }
    const paper = sanitizeV6PaperState(decoded.paper);
    return paper === null
      ? fallback("invalid-data", nowMs)
      : { state: paper, source: "migrated", issue: null };
  }

  if (decoded.version === 5) {
    if (!hasExactKeys(decoded, ["version", "savedAt", "paper"]) || isoTimestamp(decoded.savedAt) === null) {
      return fallback("invalid-data", nowMs);
    }
    const paper = sanitizeV5PaperState(decoded.paper);
    return paper === null
      ? fallback("invalid-data", nowMs)
      : { state: paper, source: "migrated", issue: null };
  }

  if (decoded.version === 4) {
    if (!hasExactKeys(decoded, ["version", "savedAt", "paper"]) || isoTimestamp(decoded.savedAt) === null) {
      return fallback("invalid-data", nowMs);
    }
    const paper = sanitizeV4PaperState(decoded.paper);
    return paper === null
      ? fallback("invalid-data", nowMs)
      : { state: paper, source: "migrated", issue: null };
  }

  if (decoded.version === 3) {
    if (!hasExactKeys(decoded, ["version", "savedAt", "paper"]) || isoTimestamp(decoded.savedAt) === null) {
      return fallback("invalid-data", nowMs);
    }
    const paper = sanitizeV3PaperState(decoded.paper);
    return paper === null
      ? fallback("invalid-data", nowMs)
      : { state: paper, source: "migrated", issue: null };
  }

  if (decoded.version === 2) {
    if (!hasExactKeys(decoded, ["version", "savedAt", "paper"]) || isoTimestamp(decoded.savedAt) === null || !isRecord(decoded.paper) || !hasExactKeys(decoded.paper, ["account", "settings"]) || !isRecord(decoded.paper.settings) || !hasExactKeys(decoded.paper.settings, ["orderSizeUsd", "paperTradingPaused"])) {
      return fallback("invalid-data", nowMs);
    }
    return migrateLegacyAccount(
      decoded.paper.account,
      decoded.paper.settings.orderSizeUsd,
      decoded.paper.settings.paperTradingPaused,
      nowMs,
    );
  }

  if (decoded.version === 1) {
    if (!hasExactKeys(decoded, ["version", "paperAccount", "orderSizeUsd", "killSwitch"])) {
      return fallback("invalid-data", nowMs);
    }
    return migrateLegacyAccount(decoded.paperAccount, decoded.orderSizeUsd, decoded.killSwitch, nowMs);
  }

  return fallback("unsupported-version", nowMs);
}

export function loadPaperState(
  storage: PaperStorage | null = browserStorage(),
  nowMs: number = Date.now(),
): PaperLoadResult {
  const safeNowMs = normalizedNowMs(nowMs);
  if (storage === null) return fallback("storage-unavailable", safeNowMs);
  try {
    const raw = storage.getItem(PAPER_STORAGE_KEY);
    return raw === null ? fallback(null, safeNowMs) : decodeStoredState(raw, safeNowMs);
  } catch {
    return fallback("storage-read-failed", safeNowMs);
  }
}

export function savePaperState(
  state: unknown,
  storage: PaperStorage | null = browserStorage(),
  nowMs: number = Date.now(),
): boolean {
  if (storage === null) return false;
  const paper = sanitizePaperState(state);
  if (paper === null) return false;
  const safeNowMs = normalizedNowMs(nowMs);
  const envelope: StoredEnvelopeV10 = {
    version: PAPER_STORAGE_VERSION,
    savedAt: new Date(safeNowMs).toISOString(),
    paper,
  };
  const serialized = JSON.stringify(envelope);
  if (serialized.length > MAX_SERIALIZED_CHARS) return false;
  try {
    storage.setItem(PAPER_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export function clearPaperState(storage: PaperStorage | null = browserStorage()): boolean {
  if (storage === null) return false;
  try {
    storage.removeItem(PAPER_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
