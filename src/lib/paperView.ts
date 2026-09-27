import type { PaperAccount, PaperTrade } from "../types";
import type { PaperEngineState, PaperPortfolioMark } from "./paperEngine";

export interface PaperExitView {
  id: string;
  mint: string;
  symbol: string;
  quantity: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  realizedPnlUsd: number;
  closedAt: string;
  reason: string;
}

export interface PaperEvidence {
  observationDays: number;
  completedExits: number;
  profitableExits: number;
  winRatePct: number | null;
  expectancyUsd: number | null;
  totalFeesUsd: number;
  totalImpactCostUsd: number;
}

export function engineToPaperAccount(state: PaperEngineState): PaperAccount {
  const positions = state.positions.map((position) => ({
    mint: position.mint,
    symbol: position.symbol,
    quantity: position.quantity,
    averagePriceUsd: position.quantity > 0 ? position.costBasisUsd / position.quantity : position.averageFillPriceUsd,
    lastPriceUsd: position.lastPriceUsd,
    openedAt: new Date(position.openedAtMs).toISOString(),
  }));

  const trades: PaperTrade[] = [...state.trades]
    .reverse()
    .map((trade) => ({
      id: trade.id,
      mint: trade.mint,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      fillPriceUsd: trade.fillPriceUsd,
      notionalUsd: trade.notionalUsd,
      feeUsd: trade.feeUsd,
      impactCostUsd: trade.impactCostUsd,
      realizedPnlUsd: trade.realizedPnlUsd,
      reason: trade.reason,
      timestamp: new Date(trade.timestampMs).toISOString(),
    }));

  return {
    startingEquityUsd: state.startingEquityUsd,
    cashUsd: state.cashUsd,
    positions,
    trades,
    realizedPnlUsd: state.realizedPnlUsd,
  };
}

export function engineExitViews(state: PaperEngineState): PaperExitView[] {
  return [...state.trades]
    .filter((trade) => trade.side === "SELL")
    .reverse()
    .map((trade) => {
      const netProceeds = trade.cashFlowUsd;
      const allocatedCost = netProceeds - trade.realizedPnlUsd;
      return {
        id: trade.id,
        mint: trade.mint,
        symbol: trade.symbol,
        quantity: trade.quantity,
        entryPriceUsd: trade.quantity > 0 ? allocatedCost / trade.quantity : 0,
        exitPriceUsd: trade.fillPriceUsd,
        realizedPnlUsd: trade.realizedPnlUsd,
        closedAt: new Date(trade.timestampMs).toISOString(),
        reason: trade.reason,
      };
    });
}

export function paperEvidence(state: PaperEngineState): PaperEvidence {
  const exits = state.trades.filter((trade) => trade.side === "SELL");
  const firstTimestamp = state.trades.reduce<number | null>(
    (earliest, trade) => earliest === null ? trade.timestampMs : Math.min(earliest, trade.timestampMs),
    null,
  );
  const profitableExits = exits.filter((trade) => trade.realizedPnlUsd > 0).length;
  return {
    observationDays: firstTimestamp === null ? 0 : Math.max(0, (Date.now() - firstTimestamp) / 86_400_000),
    completedExits: exits.length,
    profitableExits,
    winRatePct: exits.length ? (profitableExits / exits.length) * 100 : null,
    expectancyUsd: exits.length
      ? exits.reduce((total, trade) => total + trade.realizedPnlUsd, 0) / exits.length
      : null,
    totalFeesUsd: state.trades.reduce((total, trade) => total + trade.feeUsd, 0),
    totalImpactCostUsd: state.trades.reduce((total, trade) => total + trade.impactCostUsd, 0),
  };
}

export function describeAutomationTrade(side: "BUY" | "SELL", symbol: string, reason: string) {
  const readable = reason.replaceAll("_", " ");
  return `${side === "BUY" ? "Opened" : "Closed"} ${symbol} · ${readable}`;
}

export function markedAccount(state: PaperEngineState, mark: PaperPortfolioMark) {
  return {
    account: engineToPaperAccount(state),
    equityUsd: mark.equityUsd,
    unrealizedPnlUsd: mark.unrealizedPnlUsd,
  };
}
