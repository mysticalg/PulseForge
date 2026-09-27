export type PaperStrategyId = "conservative" | "pump-scalp" | "launch-flow";

export interface PaperAutomationSettings {
  enabled: boolean;
  strategyId: PaperStrategyId;
  /** Explicit paper-only opt-in for Med-High and High classification labels. */
  allowHighRiskPaperEntries: boolean;
  portfolioBudgetUsd: number;
  maxOpenPositions: number;
  maxAllocationPerTokenPct: number;
  reserveUsd: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  maxHoldMinutes: number;
  /** Exit an open paper position when its latest five-minute buy share falls below this ratio. Zero disables this exit. */
  exitBuyRatioBelow: number;
  /** Mint-specific re-entry delay after a buy-ratio deterioration exit. */
  buyRatioDeteriorationCooldownMinutes: number;
  /** Exit when observed liquidity falls this percentage below entry liquidity. Zero disables this exit. */
  exitLiquidityDrawdownPct: number;
  /** Mint-specific re-entry delay after a liquidity-drawdown exit. */
  liquidityDrawdownCooldownMinutes: number;
  /** Exit at or below this short-window price change. -100 disables this exit. */
  exitShortMomentumBelowPct: number;
  /** Exit at or below this short-window volume growth. -100 disables this exit. */
  exitShortVolumeGrowthBelowPct: number;
  /** Mint-specific re-entry delay after either momentum-break exit. */
  momentumBreakCooldownMinutes: number;
  minModelScore: number;
  minBuyRatio: number;
  maxBuyRatio: number;
  minLiquidityUsd: number;
  minVolume5mUsd: number;
  minTraders5m: number;
  minOrganicBuyers5m: number;
  maxPriceImpactPct: number;
  dailyLossLimitUsd: number;
  cooldownMinutes: number;
  minTokenAgeMinutes: number;
  maxTokenAgeMinutes: number;
  minMomentum5mPct: number;
  maxMomentum5mPct: number;
  minShortMomentumPct: number;
  maxShortMomentumPct: number;
  minShortVolumeGrowthPct: number;
  minVolumeToLiquidity: number;
}

export const DEFAULT_PAPER_AUTOMATION_SETTINGS: PaperAutomationSettings = {
  enabled: false,
  strategyId: "launch-flow",
  allowHighRiskPaperEntries: true,
  portfolioBudgetUsd: 400,
  maxOpenPositions: 4,
  maxAllocationPerTokenPct: 2.5,
  reserveUsd: 360,
  takeProfitPct: 4.5,
  stopLossPct: 3,
  trailingStopPct: 2,
  maxHoldMinutes: 2,
  exitBuyRatioBelow: 0.43,
  buyRatioDeteriorationCooldownMinutes: 15,
  exitLiquidityDrawdownPct: 15,
  liquidityDrawdownCooldownMinutes: 15,
  exitShortMomentumBelowPct: -0.2,
  exitShortVolumeGrowthBelowPct: -5,
  momentumBreakCooldownMinutes: 15,
  minModelScore: 0,
  minBuyRatio: 0.58,
  maxBuyRatio: 0.92,
  minLiquidityUsd: 5_000,
  minVolume5mUsd: 1_500,
  minTraders5m: 8,
  minOrganicBuyers5m: 0,
  maxPriceImpactPct: 1.5,
  dailyLossLimitUsd: 8,
  cooldownMinutes: 5,
  minTokenAgeMinutes: 1.5,
  maxTokenAgeMinutes: 45,
  minMomentum5mPct: 1.5,
  maxMomentum5mPct: 40,
  minShortMomentumPct: 0.2,
  maxShortMomentumPct: 10,
  minShortVolumeGrowthPct: 0,
  minVolumeToLiquidity: 0.2,
};

/** The overly sparse v0.8 defaults, retained only for one-time migration. */
export const UNTUNED_V08_AUTOMATION_DEFAULTS: PaperAutomationSettings = {
  enabled: false,
  strategyId: "conservative",
  allowHighRiskPaperEntries: false,
  portfolioBudgetUsd: 400,
  maxOpenPositions: 5,
  maxAllocationPerTokenPct: 5,
  reserveUsd: 300,
  takeProfitPct: 8,
  stopLossPct: 5,
  trailingStopPct: 4,
  maxHoldMinutes: 45,
  exitBuyRatioBelow: 0.47,
  buyRatioDeteriorationCooldownMinutes: 60,
  exitLiquidityDrawdownPct: 30,
  liquidityDrawdownCooldownMinutes: 60,
  exitShortMomentumBelowPct: -100,
  exitShortVolumeGrowthBelowPct: -100,
  momentumBreakCooldownMinutes: 0,
  minModelScore: 0.7,
  minBuyRatio: 0.58,
  maxBuyRatio: 0.75,
  minLiquidityUsd: 250_000,
  minVolume5mUsd: 100_000,
  minTraders5m: 75,
  minOrganicBuyers5m: 10,
  maxPriceImpactPct: 0.3,
  dailyLossLimitUsd: 4,
  cooldownMinutes: 60,
  minTokenAgeMinutes: 0,
  maxTokenAgeMinutes: 43_200,
  minMomentum5mPct: -100,
  maxMomentum5mPct: 1_000,
  minShortMomentumPct: -100,
  maxShortMomentumPct: 1_000,
  minShortVolumeGrowthPct: 0,
  minVolumeToLiquidity: 0,
};

export const LEGACY_V03_AUTOMATION_DEFAULTS: PaperAutomationSettings = {
  enabled: false,
  strategyId: "conservative",
  allowHighRiskPaperEntries: false,
  portfolioBudgetUsd: 400,
  maxOpenPositions: 5,
  maxAllocationPerTokenPct: 20,
  reserveUsd: 40,
  takeProfitPct: 8,
  stopLossPct: 5,
  trailingStopPct: 4,
  maxHoldMinutes: 45,
  exitBuyRatioBelow: 0.45,
  buyRatioDeteriorationCooldownMinutes: 15,
  exitLiquidityDrawdownPct: 30,
  liquidityDrawdownCooldownMinutes: 15,
  exitShortMomentumBelowPct: -100,
  exitShortVolumeGrowthBelowPct: -100,
  momentumBreakCooldownMinutes: 0,
  minModelScore: 0.6,
  minBuyRatio: 0.56,
  maxBuyRatio: 0.82,
  minLiquidityUsd: 50_000,
  minVolume5mUsd: 25_000,
  minTraders5m: 25,
  minOrganicBuyers5m: 3,
  maxPriceImpactPct: 0.75,
  dailyLossLimitUsd: 20,
  cooldownMinutes: 15,
  minTokenAgeMinutes: 0,
  maxTokenAgeMinutes: 43_200,
  minMomentum5mPct: -100,
  maxMomentum5mPct: 1_000,
  minShortMomentumPct: -100,
  maxShortMomentumPct: 1_000,
  minShortVolumeGrowthPct: 0,
  minVolumeToLiquidity: 0,
};

export function conservativeSettingsForBudget(portfolioBudgetUsd: number, enabled = false): PaperAutomationSettings {
  const budget = Math.max(5, Math.min(1_000_000, portfolioBudgetUsd));
  return {
    ...DEFAULT_PAPER_AUTOMATION_SETTINGS,
    enabled,
    strategyId: "conservative",
    allowHighRiskPaperEntries: false,
    maxOpenPositions: 5,
    portfolioBudgetUsd: budget,
    // Keep the order large enough to clear the $5 paper minimum without
    // allowing a tiny account to concentrate more than 25% in one token.
    maxAllocationPerTokenPct: Math.min(25, Math.max(5, 500 / budget)),
    reserveUsd: Math.round(Math.min(budget * 0.75, Math.max(0, budget - 5)) * 100) / 100,
    dailyLossLimitUsd: Math.max(0.1, Math.round(budget * 0.01 * 100) / 100),
    takeProfitPct: 8,
    stopLossPct: 5,
    trailingStopPct: 4,
    maxHoldMinutes: 45,
    exitBuyRatioBelow: 0.44,
    buyRatioDeteriorationCooldownMinutes: 30,
    exitLiquidityDrawdownPct: 30,
    liquidityDrawdownCooldownMinutes: 30,
    exitShortMomentumBelowPct: -100,
    exitShortVolumeGrowthBelowPct: -100,
    momentumBreakCooldownMinutes: 0,
    minModelScore: 0.62,
    minBuyRatio: 0.55,
    maxBuyRatio: 0.85,
    minLiquidityUsd: 100_000,
    minVolume5mUsd: 10_000,
    minTraders5m: 10,
    minOrganicBuyers5m: 1,
    maxPriceImpactPct: 0.75,
    cooldownMinutes: 15,
    minTokenAgeMinutes: 5,
    maxTokenAgeMinutes: 43_200,
    minMomentum5mPct: -20,
    maxMomentum5mPct: 50,
    minShortMomentumPct: -100,
    maxShortMomentumPct: 1_000,
    minShortVolumeGrowthPct: 0,
    minVolumeToLiquidity: 0.05,
  };
}

export function pumpScalpSettingsForBudget(portfolioBudgetUsd: number, enabled = false): PaperAutomationSettings {
  const budget = Math.max(5, Math.min(1_000_000, portfolioBudgetUsd));
  return {
    ...DEFAULT_PAPER_AUTOMATION_SETTINGS,
    enabled,
    strategyId: "pump-scalp",
    allowHighRiskPaperEntries: true,
    maxOpenPositions: 4,
    portfolioBudgetUsd: budget,
    maxAllocationPerTokenPct: Math.min(25, Math.max(2.5, 500 / budget)),
    reserveUsd: Math.round(Math.min(budget * 0.9, Math.max(0, budget - 5)) * 100) / 100,
    takeProfitPct: 6,
    stopLossPct: 3.5,
    trailingStopPct: 2.5,
    maxHoldMinutes: 5,
    exitBuyRatioBelow: 0.47,
    buyRatioDeteriorationCooldownMinutes: 15,
    exitLiquidityDrawdownPct: 20,
    liquidityDrawdownCooldownMinutes: 15,
    exitShortMomentumBelowPct: -0.2,
    exitShortVolumeGrowthBelowPct: -100,
    momentumBreakCooldownMinutes: 15,
    minModelScore: 0,
    minBuyRatio: 0.58,
    maxBuyRatio: 0.88,
    minLiquidityUsd: 25_000,
    minVolume5mUsd: 10_000,
    minTraders5m: 15,
    minOrganicBuyers5m: 1,
    maxPriceImpactPct: 1,
    dailyLossLimitUsd: Math.max(0.1, Math.round(budget * 0.02 * 100) / 100),
    cooldownMinutes: 5,
    minTokenAgeMinutes: 2,
    maxTokenAgeMinutes: 60,
    minMomentum5mPct: 2,
    maxMomentum5mPct: 25,
    minShortMomentumPct: 0.3,
    maxShortMomentumPct: 6,
    minShortVolumeGrowthPct: 0,
    minVolumeToLiquidity: 0.2,
  };
}

/**
 * Paper-only profile for very young pools whose price and five-minute traded
 * notional are both still expanding. A high buy share is intentionally paired
 * with participant, organic-flow and execution gates; it is never treated as
 * sufficient evidence by itself.
 */
export function launchFlowSettingsForBudget(portfolioBudgetUsd: number, enabled = false): PaperAutomationSettings {
  const budget = Math.max(5, Math.min(1_000_000, portfolioBudgetUsd));
  return {
    ...DEFAULT_PAPER_AUTOMATION_SETTINGS,
    enabled,
    strategyId: "launch-flow",
    allowHighRiskPaperEntries: true,
    maxOpenPositions: 4,
    portfolioBudgetUsd: budget,
    maxAllocationPerTokenPct: Math.min(20, Math.max(2.5, 500 / budget)),
    reserveUsd: Math.round(Math.min(budget * 0.9, Math.max(0, budget - 5)) * 100) / 100,
    takeProfitPct: 4.5,
    stopLossPct: 3,
    trailingStopPct: 2,
    maxHoldMinutes: 2,
    exitBuyRatioBelow: 0.43,
    buyRatioDeteriorationCooldownMinutes: 15,
    exitLiquidityDrawdownPct: 15,
    liquidityDrawdownCooldownMinutes: 15,
    minModelScore: 0,
    minBuyRatio: 0.58,
    // Exact 100% flow commonly means there has not yet been a meaningful sell
    // sample. Keep one-sided prints out of the default profile.
    maxBuyRatio: 0.92,
    minLiquidityUsd: 5_000,
    minVolume5mUsd: 1_500,
    minTraders5m: 8,
    minOrganicBuyers5m: 0,
    maxPriceImpactPct: 1.5,
    dailyLossLimitUsd: Math.max(0.1, Math.round(budget * 0.02 * 100) / 100),
    cooldownMinutes: 5,
    minTokenAgeMinutes: 1.5,
    maxTokenAgeMinutes: 45,
    minMomentum5mPct: 1.5,
    maxMomentum5mPct: 40,
    minShortMomentumPct: 0.2,
    maxShortMomentumPct: 10,
    minShortVolumeGrowthPct: 0,
    minVolumeToLiquidity: 0.2,
  };
}

/** Paper profile that lets confirmed launch patterns run until momentum breaks. */
export function launchRunnerSettingsForBudget(portfolioBudgetUsd: number, enabled = false): PaperAutomationSettings {
  return {
    ...launchFlowSettingsForBudget(portfolioBudgetUsd, enabled),
    takeProfitPct: 0,
    stopLossPct: 5,
    trailingStopPct: 8,
    maxHoldMinutes: 45,
    exitShortMomentumBelowPct: -2,
    exitShortVolumeGrowthBelowPct: -15,
    minShortVolumeGrowthPct: 5,
    momentumBreakCooldownMinutes: 15,
  };
}

export function usesLegacyV03Defaults(settings: PaperAutomationSettings): boolean {
  return (Object.keys(LEGACY_V03_AUTOMATION_DEFAULTS) as Array<keyof PaperAutomationSettings>)
    .filter((key) => key !== "enabled" && key !== "strategyId")
    .every((key) => settings[key] === LEGACY_V03_AUTOMATION_DEFAULTS[key]);
}

export function usesUntunedV08Defaults(settings: PaperAutomationSettings): boolean {
  return (Object.keys(UNTUNED_V08_AUTOMATION_DEFAULTS) as Array<keyof PaperAutomationSettings>)
    .filter((key) => key !== "enabled")
    .every((key) => settings[key] === UNTUNED_V08_AUTOMATION_DEFAULTS[key]);
}
