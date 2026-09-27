export type RiskLevel = "Low" | "Medium" | "Med-High" | "High";
export type FeedMode = "demo" | "live";
export type NavView = "market" | "signals" | "positions" | "live-wallet" | "models" | "backtests" | "settings";

export interface SafetyChecks {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  topTenHolderPct: number;
  liquidityLocked: boolean | null;
  priceImpactPct: number;
  transferTaxPct: number;
  /** True when the provider omitted fee evidence and mint verification is pending. */
  transferTaxUnknown?: boolean;
  verified: boolean;
}

export interface MarketToken {
  mint: string;
  symbol: string;
  name: string;
  iconUrl?: string | null;
  ageSeconds: number;
  priceUsd: number;
  /** Provider-reported circulating market cap; null when the feed omits it. */
  marketCapUsd?: number | null;
  change5mPct: number;
  liquidityUsd: number;
  volume5mUsd: number;
  buyRatio: number;
  buys5m: number;
  sells5m: number;
  traders5m: number;
  organicBuyers5m: number;
  organicScore: number | null;
  riskLevel: RiskLevel;
  modelScore: number;
  safety: SafetyChecks;
  source: string;
  updatedAt: string;
}

export interface MarketSnapshot {
  mode: FeedMode;
  provider: string;
  latencyMs: number;
  updatedAt: string;
  tokens: MarketToken[];
  warning: string | null;
}

export interface RuntimeInfo {
  version: string;
  jupiterConfigured: boolean;
  heliusConfigured: boolean;
  laserstreamConfigured: boolean;
  liveExecutionAvailable: boolean;
  modelName: string;
  modelStatus: string;
}

export interface CalibrationStatus {
  storagePath: string;
  observationCount: number;
  labeledCount: number;
  pendingCount: number;
  positiveCount: number;
  negativeCount: number;
  unavailableCount: number;
  invalidOutcomeCount: number;
  boundedOutcomeCount: number;
  observationDays: number;
  targetHorizonMinutes: number;
  quoteSampleCount: number;
  quoteSuccessCount: number;
  quoteFailureCount: number;
  realQuoteCoveragePct: number | null;
  medianRoundTripCostPct: number | null;
  driftPsi: number | null;
  driftStatus: string;
  readyForFirstCalibration: boolean;
  promotionEvidenceDays: number;
  researchArtifact: ResearchArtifactSummary | null;
  status: string;
}

export interface ResearchArtifactSummary {
  champion: "histGradientBoosting" | "randomForest";
  trainedAt: string;
  datasetRows: number;
  observationSpanDays: number;
  testRows: number;
  baselineRocAuc: number | null;
  calibratedRocAuc: number | null;
  calibratedBrier: number;
  selectedObservations: number;
  costStressedMeanReturnPct: number;
  excludedInvalidRows: number;
  boundedReturnRows: number;
  promotionEligible: boolean;
}

export interface QuoteEstimate {
  inputUsd: number;
  expectedPriceUsd: number;
  expectedTokens: number;
  priceImpactPct: number;
  feeUsd: number;
  route: string;
  canPaperTrade: boolean;
  blockers: string[];
}

export interface PaperTrade {
  id: string;
  mint: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  fillPriceUsd: number;
  notionalUsd: number;
  feeUsd: number;
  impactCostUsd: number;
  realizedPnlUsd: number;
  reason: string;
  timestamp: string;
}

export interface PaperPosition {
  mint: string;
  symbol: string;
  quantity: number;
  averagePriceUsd: number;
  lastPriceUsd: number;
  openedAt: string;
}

export interface PaperAccount {
  startingEquityUsd: number;
  cashUsd: number;
  positions: PaperPosition[];
  trades: PaperTrade[];
  realizedPnlUsd: number;
}

export interface MarketEvent {
  id: string;
  time: string;
  kind: "info" | "positive" | "warning" | "danger";
  event: string;
  detail: string;
}

export interface WalletStatus {
  imported: boolean;
  address: string | null;
  storage: string;
  warning: string | null;
}

export interface WalletPortfolio {
  imported: boolean;
  address: string | null;
  solBalance: number | null;
  solPriceUsd: number | null;
  nativeValueUsd: number | null;
  estimatedTotalValueUsd: number | null;
  availableAfterGasUsd: number | null;
  source: string;
  warning: string | null;
}

export interface LiveCanaryRequest {
  side: "BUY" | "SELL";
  mint: string;
  amountUsd?: number | null;
  sellPercent?: 25 | 50 | 100 | null;
}

export interface LiveCanaryPreview {
  challengeId: string;
  side: "BUY" | "SELL";
  mint: string;
  symbol: string;
  inputLabel: string;
  expectedOutputLabel: string;
  requestedUsd: number | null;
  sellPercent: number | null;
  priceImpactPct: number;
  slippageBps: number;
  feeBps: number;
  router: string;
  expiresAt: string;
  confirmationPhrase: string;
}

export interface LiveCanaryTrade {
  id: string;
  createdAt: string;
  side: "BUY" | "SELL";
  mint: string;
  symbol: string;
  requestedUsd: number | null;
  status: string;
  signature: string | null;
  router: string | null;
  detail: string | null;
}

export interface LiveCanaryStatus {
  available: boolean;
  armed: boolean;
  blocker: string | null;
  maxOrderUsd: number;
  dailyBuyCapUsd: number;
  dailyBuyUsedUsd: number;
  maxPriceImpactPct: number;
  maxSlippageBps: number;
  cooldownSeconds: number;
  cooldownRemainingSeconds: number;
  acknowledgementPhrase: string;
  recentTrades: LiveCanaryTrade[];
}

export interface LiveCanaryExecution {
  status: string;
  signature: string;
  side: "BUY" | "SELL";
  mint: string;
  symbol: string;
  inputAmount: string;
  outputAmount: string;
  explorerUrl: string;
}
