import {
  LEGACY_V03_AUTOMATION_DEFAULTS,
  conservativeSettingsForBudget,
  launchFlowSettingsForBudget,
  pumpScalpSettingsForBudget,
  type PaperAutomationSettings,
} from "./automationSettings";
import {
  createPaperEngineState,
  markPaperPortfolio,
  runPaperCycle,
  type PaperEngineState,
  type PaperEngineTrade,
  type PaperMarketObservation,
} from "./paperEngine";
import { paperConfig, refreshPaperMarks } from "./paperRuntime";

export const SHADOW_LAB_STORAGE_KEY = "pulseforge.shadow-lab-v1";
const SHADOW_LAB_VERSION = 3 as const;
const MAX_RECENT_ENGINE_TRADES = 400;
const MAX_SERIALIZED_CHARS = 2_000_000;

export type ShadowPolicyId = "conservative" | "liquidity-first" | "pump-scalp" | "launch-flow" | "baseline-control";

export interface ShadowExitAggregate {
  exits: number;
  wins: number;
  netPnlUsd: number;
  totalHoldMs: number;
}

export interface ShadowPolicyState {
  id: ShadowPolicyId;
  engineState: PaperEngineState;
  startedAtMs: number;
  peakEquityUsd: number;
  maxDrawdownUsd: number;
  totalOrders: number;
  completedExits: number;
  profitableExits: number;
  totalFeesUsd: number;
  totalImpactCostUsd: number;
  exitAttribution: Record<string, ShadowExitAggregate>;
}

export interface ShadowLabState {
  version: typeof SHADOW_LAB_VERSION;
  budgetUsd: number;
  policies: ShadowPolicyState[];
  updatedAtMs: number;
}

export interface ShadowPolicyDefinition {
  id: ShadowPolicyId;
  label: string;
  description: string;
  settings: PaperAutomationSettings;
}

export interface ShadowPolicyMetrics {
  id: ShadowPolicyId;
  label: string;
  description: string;
  openPositions: number;
  completedExits: number;
  winRatePct: number | null;
  netPnlUsd: number;
  expectancyUsd: number | null;
  maxDrawdownUsd: number;
  costDragUsd: number;
  observationDays: number;
}

export interface ShadowStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): ShadowStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function shadowPolicyDefinitions(budgetUsd: number): ShadowPolicyDefinition[] {
  const budget = Math.max(5, budgetUsd);
  const conservative = conservativeSettingsForBudget(budget, true);
  const liquidityFirst: PaperAutomationSettings = {
    ...conservative,
    minModelScore: 0.65,
    minBuyRatio: 0.56,
    maxBuyRatio: 0.72,
    minLiquidityUsd: 500_000,
    minVolume5mUsd: 150_000,
    minTraders5m: 100,
    minOrganicBuyers5m: 15,
    maxPriceImpactPct: 0.2,
  };
  const baselineControl: PaperAutomationSettings = {
    ...LEGACY_V03_AUTOMATION_DEFAULTS,
    enabled: true,
    portfolioBudgetUsd: budget,
    reserveUsd: Math.round(budget * 10) / 100,
    dailyLossLimitUsd: Math.max(0.1, Math.round(budget * 5) / 100),
  };
  const pumpScalp = pumpScalpSettingsForBudget(budget, true);
  const launchFlow = launchFlowSettingsForBudget(budget, true);
  return [
    { id: "conservative", label: "Conservative v1", description: "Lower size, deeper liquidity and tighter cost gates", settings: conservative },
    { id: "liquidity-first", label: "Liquidity-first", description: "Prioritises route quality over the raw score threshold", settings: liquidityFirst },
    { id: "pump-scalp", label: "Pump scalp", description: "Thirty-second continuation with a five-minute exit clock and cost-aware profit lock", settings: pumpScalp },
    { id: "launch-flow", label: "High-risk launch scout", description: "Young-pool price and volume acceleration after route persistence, with contract and execution gates", settings: launchFlow },
    { id: "baseline-control", label: "Baseline control", description: "The previous v0.3 defaults retained as a control", settings: baselineControl },
  ];
}

function emptyPolicy(id: ShadowPolicyId, budgetUsd: number, nowMs: number): ShadowPolicyState {
  return {
    id,
    engineState: createPaperEngineState(budgetUsd, nowMs),
    startedAtMs: nowMs,
    peakEquityUsd: budgetUsd,
    maxDrawdownUsd: 0,
    totalOrders: 0,
    completedExits: 0,
    profitableExits: 0,
    totalFeesUsd: 0,
    totalImpactCostUsd: 0,
    exitAttribution: {},
  };
}

export function createShadowLabState(budgetUsd: number, nowMs: number = Date.now()): ShadowLabState {
  const budget = Math.max(5, budgetUsd);
  return {
    version: SHADOW_LAB_VERSION,
    budgetUsd: budget,
    policies: shadowPolicyDefinitions(budget).map((definition) => emptyPolicy(definition.id, budget, nowMs)),
    updatedAtMs: nowMs,
  };
}

function openTimeByMint(state: PaperEngineState): Map<string, number> {
  return new Map(state.positions.map((position) => [position.mint, position.openedAtMs]));
}

function applyTradeAggregates(policy: ShadowPolicyState, previous: PaperEngineState, trades: readonly PaperEngineTrade[]): ShadowPolicyState {
  const openedAt = openTimeByMint(previous);
  const attribution = { ...policy.exitAttribution };
  let exits = policy.completedExits;
  let wins = policy.profitableExits;
  for (const trade of trades) {
    if (trade.side !== "SELL") continue;
    exits += 1;
    if (trade.realizedPnlUsd > 0) wins += 1;
    const current = attribution[trade.reason] ?? { exits: 0, wins: 0, netPnlUsd: 0, totalHoldMs: 0 };
    attribution[trade.reason] = {
      exits: current.exits + 1,
      wins: current.wins + (trade.realizedPnlUsd > 0 ? 1 : 0),
      netPnlUsd: current.netPnlUsd + trade.realizedPnlUsd,
      totalHoldMs: current.totalHoldMs + Math.max(0, trade.timestampMs - (openedAt.get(trade.mint) ?? trade.timestampMs)),
    };
  }
  return {
    ...policy,
    totalOrders: policy.totalOrders + trades.length,
    completedExits: exits,
    profitableExits: wins,
    totalFeesUsd: policy.totalFeesUsd + trades.reduce((sum, trade) => sum + trade.feeUsd, 0),
    totalImpactCostUsd: policy.totalImpactCostUsd + trades.reduce((sum, trade) => sum + trade.impactCostUsd, 0),
    exitAttribution: attribution,
  };
}

export function runShadowLabCycle(
  lab: ShadowLabState,
  observations: readonly PaperMarketObservation[],
  nowMs: number,
): ShadowLabState {
  const definitions = new Map(shadowPolicyDefinitions(lab.budgetUsd).map((definition) => [definition.id, definition]));
  const policies = lab.policies.map((policy) => {
    const definition = definitions.get(policy.id);
    if (!definition) return policy;
    const markedState = refreshPaperMarks(policy.engineState, observations, nowMs);
    const previousTradeCount = markedState.trades.length;
    const result = runPaperCycle(markedState, observations, nowMs, paperConfig(definition.settings, markedState), { killSwitch: false });
    const newTrades = result.state.trades.slice(previousTradeCount);
    let next = applyTradeAggregates(policy, markedState, newTrades);
    const mark = markPaperPortfolio(result.state, observations, paperConfig(definition.settings, result.state));
    const peak = Math.max(next.peakEquityUsd, mark.equityUsd);
    next = {
      ...next,
      peakEquityUsd: peak,
      maxDrawdownUsd: Math.max(next.maxDrawdownUsd, peak - mark.equityUsd),
      engineState: {
        ...result.state,
        trades: result.state.trades.slice(-MAX_RECENT_ENGINE_TRADES),
      },
    };
    return next;
  });
  return { ...lab, policies, updatedAtMs: nowMs };
}

export function shadowPolicyMetrics(
  lab: ShadowLabState,
  observations: readonly PaperMarketObservation[],
  nowMs: number = Date.now(),
): ShadowPolicyMetrics[] {
  const definitions = new Map(shadowPolicyDefinitions(lab.budgetUsd).map((definition) => [definition.id, definition]));
  return lab.policies.map((policy) => {
    const definition = definitions.get(policy.id)!;
    const mark = markPaperPortfolio(policy.engineState, observations, paperConfig(definition.settings, policy.engineState));
    const netPnlUsd = mark.equityUsd - lab.budgetUsd;
    return {
      id: policy.id,
      label: definition.label,
      description: definition.description,
      openPositions: policy.engineState.positions.length,
      completedExits: policy.completedExits,
      winRatePct: policy.completedExits ? policy.profitableExits / policy.completedExits * 100 : null,
      netPnlUsd,
      expectancyUsd: policy.completedExits ? policy.engineState.realizedPnlUsd / policy.completedExits : null,
      maxDrawdownUsd: policy.maxDrawdownUsd,
      costDragUsd: policy.totalFeesUsd + policy.totalImpactCostUsd,
      observationDays: Math.max(0, nowMs - policy.startedAtMs) / 86_400_000,
    };
  });
}

function finite(value: unknown, minimum = -Number.MAX_VALUE): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function validPolicy(policy: Partial<ShadowPolicyState> | null | undefined): policy is ShadowPolicyState {
    if (!policy || !finite(policy.startedAtMs, 0) || !finite(policy.peakEquityUsd, 0) || !finite(policy.maxDrawdownUsd, 0)
      || !finite(policy.totalOrders, 0) || !finite(policy.completedExits, 0) || !finite(policy.profitableExits, 0)
      || !finite(policy.totalFeesUsd, 0) || !finite(policy.totalImpactCostUsd, 0) || !policy.engineState
      || !Array.isArray(policy.engineState.positions) || !Array.isArray(policy.engineState.trades) || typeof policy.exitAttribution !== "object") return false;
  return true;
}

function sanitizeLab(value: unknown, budgetUsd: number, nowMs: number): ShadowLabState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ShadowLabState> & { version?: number };
  if (candidate.budgetUsd !== budgetUsd || !finite(candidate.updatedAtMs, 0) || !Array.isArray(candidate.policies)) return null;
  const expectedIds = shadowPolicyDefinitions(budgetUsd).map((definition) => definition.id);
  if (candidate.version === SHADOW_LAB_VERSION) {
    if (candidate.policies.length !== expectedIds.length || candidate.policies.some((policy, index) => policy?.id !== expectedIds[index])) return null;
    if (!candidate.policies.every(validPolicy)) return null;
    return candidate as ShadowLabState;
  }

  const legacyIds: ShadowPolicyId[] = candidate.version === 2
    ? ["conservative", "liquidity-first", "pump-scalp", "baseline-control"]
    : ["conservative", "liquidity-first", "baseline-control"];
  if ((candidate.version !== 1 && candidate.version !== 2) || candidate.policies.length !== legacyIds.length
    || candidate.policies.some((policy, index) => policy?.id !== legacyIds[index])
    || !candidate.policies.every(validPolicy)) return null;
  const migrated = createShadowLabState(budgetUsd, nowMs);
  const legacyById = new Map(candidate.policies.map((policy) => [policy.id, policy]));
  migrated.policies = migrated.policies.map((policy) => legacyById.get(policy.id) ?? policy);
  migrated.updatedAtMs = candidate.updatedAtMs;
  return migrated;
}

export function loadShadowLabState(
  budgetUsd: number,
  storage: ShadowStorage | null = browserStorage(),
  nowMs: number = Date.now(),
): ShadowLabState {
  if (!storage) return createShadowLabState(budgetUsd, nowMs);
  try {
    const raw = storage.getItem(SHADOW_LAB_STORAGE_KEY);
    if (!raw || raw.length > MAX_SERIALIZED_CHARS) return createShadowLabState(budgetUsd, nowMs);
    return sanitizeLab(JSON.parse(raw), budgetUsd, nowMs) ?? createShadowLabState(budgetUsd, nowMs);
  } catch {
    return createShadowLabState(budgetUsd, nowMs);
  }
}

export function saveShadowLabState(lab: ShadowLabState, storage: ShadowStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    const serialized = JSON.stringify(lab);
    if (serialized.length > MAX_SERIALIZED_CHARS) return false;
    storage.setItem(SHADOW_LAB_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export function resetShadowLabState(budgetUsd: number, nowMs: number = Date.now()): ShadowLabState {
  return createShadowLabState(budgetUsd, nowMs);
}
