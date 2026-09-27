import { invoke } from "@tauri-apps/api/core";
import { browserRuntimeInfo, createDemoSnapshot } from "../data/demo";
import type {
  CalibrationStatus,
  LiveCanaryExecution,
  LiveCanaryPreview,
  LiveCanaryRequest,
  LiveCanaryStatus,
  MarketSnapshot,
  MarketToken,
  QuoteEstimate,
  RuntimeInfo,
  WalletPortfolio,
  WalletStatus,
} from "../types";
import { estimateQuote } from "./strategy";
import { emptyLiveTradingStatus, type LiveTradingConfig, type LiveTradingRequest, type LiveTradingStatus } from "./liveTrading";

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getApprovedPaperWriteoffs(): Promise<import("./paperWriteoffs").PaperWriteoffApproval[]> {
  return isTauriRuntime() ? invoke("approved_paper_writeoffs") : [];
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (!isTauriRuntime()) return browserRuntimeInfo;
  return invoke<RuntimeInfo>("runtime_info");
}

export async function refreshMarket(): Promise<MarketSnapshot> {
  if (!isTauriRuntime()) return createDemoSnapshot();
  return invoke<MarketSnapshot>("refresh_market");
}

export async function refreshMarketToken(mint: string): Promise<MarketToken> {
  if (!isTauriRuntime()) {
    const token = createDemoSnapshot().tokens.find((candidate) => candidate.mint === mint);
    if (!token) throw new Error("The demo feed does not contain this token mint");
    return token;
  }
  return invoke<MarketToken>("refresh_market_token", { mint });
}

export async function refreshMarketTokens(mints: string[]): Promise<MarketToken[]> {
  if (!isTauriRuntime()) return createDemoSnapshot().tokens.filter((token) => mints.includes(token.mint));
  return invoke<MarketToken[]>("refresh_market_tokens", { mints });
}

const emptyCalibrationStatus: CalibrationStatus = {
  storagePath: "Desktop app data directory",
  observationCount: 0,
  labeledCount: 0,
  pendingCount: 0,
  positiveCount: 0,
  negativeCount: 0,
  unavailableCount: 0,
  invalidOutcomeCount: 0,
  boundedOutcomeCount: 0,
  observationDays: 0,
  targetHorizonMinutes: 45,
  quoteSampleCount: 0,
  quoteSuccessCount: 0,
  quoteFailureCount: 0,
  realQuoteCoveragePct: null,
  medianRoundTripCostPct: null,
  driftPsi: null,
  driftStatus: "Insufficient history",
  readyForFirstCalibration: false,
  promotionEvidenceDays: 30,
  researchArtifact: null,
  status: "Desktop live feed required",
};

export async function getCalibrationStatus(): Promise<CalibrationStatus> {
  if (!isTauriRuntime()) return emptyCalibrationStatus;
  return invoke<CalibrationStatus>("calibration_status");
}

export async function recordCalibrationSnapshot(snapshot: MarketSnapshot): Promise<CalibrationStatus> {
  if (!isTauriRuntime() || snapshot.mode !== "live") return emptyCalibrationStatus;
  return invoke<CalibrationStatus>("record_calibration_snapshot", { snapshot });
}

export async function exportCalibrationCsv(): Promise<string> {
  if (!isTauriRuntime()) throw new Error("Calibration export is available in the Windows desktop app.");
  return invoke<string>("export_calibration_csv");
}

export async function importResearchArtifact(): Promise<CalibrationStatus> {
  if (!isTauriRuntime()) throw new Error("Research artifact import is available in the Windows desktop app.");
  return invoke<CalibrationStatus>("import_research_artifact");
}

export async function forgetResearchArtifact(): Promise<CalibrationStatus> {
  if (!isTauriRuntime()) throw new Error("Research artifact removal is available in the Windows desktop app.");
  return invoke<CalibrationStatus>("forget_research_artifact");
}

export async function getPaperQuote(
  token: MarketToken,
  inputUsd: number,
  maxPriceImpactPct = 0.75,
  minLiquidityUsd = 50_000,
): Promise<QuoteEstimate> {
  if (!isTauriRuntime()) return estimateQuote(token, inputUsd, maxPriceImpactPct, minLiquidityUsd);
  return invoke<QuoteEstimate>("estimate_paper_quote", { token, inputUsd, maxPriceImpactPct, minLiquidityUsd });
}

const browserWallet: WalletStatus = {
  imported: false,
  address: null,
  storage: "Windows Credential Manager (desktop build only)",
  warning: null,
};

export async function getWalletStatus(): Promise<WalletStatus> {
  if (!isTauriRuntime()) return browserWallet;
  return invoke<WalletStatus>("wallet_status");
}

export async function importWalletFromFile(): Promise<WalletStatus> {
  if (!isTauriRuntime()) throw new Error("Wallet import is available only in the signed desktop app.");
  return invoke<WalletStatus>("import_wallet_file");
}

export async function forgetWallet(): Promise<WalletStatus> {
  if (!isTauriRuntime()) return browserWallet;
  return invoke<WalletStatus>("forget_wallet");
}

export async function getWalletPortfolio(): Promise<WalletPortfolio> {
  if (!isTauriRuntime()) {
    return {
      imported: false,
      address: null,
      solBalance: null,
      solPriceUsd: null,
      nativeValueUsd: null,
      estimatedTotalValueUsd: null,
      availableAfterGasUsd: null,
      source: "Desktop build required",
      warning: "Open the Windows app to use the OS-backed wallet vault.",
    };
  }
  return invoke<WalletPortfolio>("wallet_portfolio");
}

const browserLiveCanary: LiveCanaryStatus = {
  available: false,
  armed: false,
  blocker: "Open the Windows desktop app to use manually approved live canary swaps.",
  maxOrderUsd: 10,
  dailyBuyCapUsd: 25,
  dailyBuyUsedUsd: 0,
  maxPriceImpactPct: 1,
  maxSlippageBps: 100,
  cooldownSeconds: 60,
  cooldownRemainingSeconds: 0,
  acknowledgementPhrase: "I UNDERSTAND LIVE TRADES USE REAL FUNDS",
  recentTrades: [],
};

export async function getLiveCanaryStatus(): Promise<LiveCanaryStatus> {
  if (!isTauriRuntime()) return browserLiveCanary;
  return invoke<LiveCanaryStatus>("live_canary_status");
}

export async function armLiveCanary(acknowledgement: string): Promise<LiveCanaryStatus> {
  if (!isTauriRuntime()) throw new Error(browserLiveCanary.blocker ?? "Desktop app required");
  return invoke<LiveCanaryStatus>("arm_live_canary", { acknowledgement });
}

export async function disarmLiveCanary(): Promise<LiveCanaryStatus> {
  if (!isTauriRuntime()) return browserLiveCanary;
  return invoke<LiveCanaryStatus>("disarm_live_canary");
}

export async function previewLiveCanary(request: LiveCanaryRequest): Promise<LiveCanaryPreview> {
  if (!isTauriRuntime()) throw new Error(browserLiveCanary.blocker ?? "Desktop app required");
  return invoke<LiveCanaryPreview>("preview_live_canary", { request });
}

export async function executeLiveCanary(challengeId: string, confirmationPhrase: string): Promise<LiveCanaryExecution> {
  if (!isTauriRuntime()) throw new Error(browserLiveCanary.blocker ?? "Desktop app required");
  return invoke<LiveCanaryExecution>("execute_live_canary", { challengeId, confirmationPhrase });
}

export async function getLiveTradingStatus(): Promise<LiveTradingStatus> {
  if (!isTauriRuntime()) return { ...emptyLiveTradingStatus, blocker: "Open the Windows desktop app to use your imported wallet." };
  return invoke<LiveTradingStatus>("live_trading_status");
}

export async function armLiveTrading(config: LiveTradingConfig, acknowledgement: string): Promise<LiveTradingStatus> {
  if (!isTauriRuntime()) throw new Error("Live trading requires the Windows desktop app.");
  return invoke<LiveTradingStatus>("arm_live_trading", { config, acknowledgement });
}

export async function disarmLiveTrading(): Promise<LiveTradingStatus> {
  if (!isTauriRuntime()) return emptyLiveTradingStatus;
  return invoke<LiveTradingStatus>("disarm_live_trading");
}

export async function executeLiveTrading(request: LiveTradingRequest): Promise<LiveTradingStatus> {
  if (!isTauriRuntime()) throw new Error("Live trading requires the Windows desktop app.");
  return invoke<LiveTradingStatus>("execute_live_trading", { request });
}

export async function quarantineLivePosition(owner: string, positionId: string): Promise<LiveTradingStatus> {
  if (!isTauriRuntime()) throw new Error("Quarantine requires the Windows desktop app.");
  return invoke<LiveTradingStatus>("quarantine_live_position", { owner, positionId });
}
