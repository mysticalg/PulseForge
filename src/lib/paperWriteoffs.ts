import type { PaperEngineState, PaperEngineTrade } from "./paperEngine";

export interface PaperWriteoffApproval {
  mint: string;
  openedAtMs: number;
  quantity: number;
  costBasisUsd: number;
}

/** User-approved paper accounting adjustment; never a quote or real sale. */
export function applyPaperWriteoffs(state: PaperEngineState, approvals: readonly PaperWriteoffApproval[], nowMs: number, dailyLossLimitUsd: number): PaperEngineState {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(dailyLossLimitUsd) || dailyLossLimitUsd <= 0) throw new Error("Invalid paper adjustment context");
  const positions = state.positions.filter(position => approvals.some(approval =>
    approval.mint === position.mint && approval.openedAtMs === position.openedAtMs
    && approval.quantity === position.quantity && approval.costBasisUsd === position.costBasisUsd));
  if (!positions.length) return state;
  const removed = new Set(positions.map(position => position.mint));
  const lossUsd = positions.reduce((sum, position) => sum + position.costBasisUsd, 0);
  const trades: PaperEngineTrade[] = positions.map((position, index) => ({
    id: `paper-${state.nextTradeSequence + index}`, mint: position.mint, symbol: position.symbol,
    side: "SELL", quantity: position.quantity, midPriceUsd: 0, fillPriceUsd: 0,
    notionalUsd: 0, feeUsd: 0, impactCostUsd: 0, cashFlowUsd: 0,
    realizedPnlUsd: -position.costBasisUsd, reason: "illiquid_writeoff", timestampMs: nowMs,
  }));
  const remaining = state.positions.filter(position => !removed.has(position.mint));
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const dayStart = state.dayKey === day ? state.dayStartEquityUsd
    : state.cashUsd + state.positions.reduce((sum, p) => sum + p.costBasisUsd, 0);
  const bookEquity = state.cashUsd + remaining.reduce((sum, p) => sum + p.costBasisUsd, 0);
  return { ...state, positions: remaining, trades: [...state.trades, ...trades],
    realizedPnlUsd: state.realizedPnlUsd - lossUsd, nextTradeSequence: state.nextTradeSequence + trades.length,
    dayKey: day, dayStartEquityUsd: dayStart,
    dailyLossLockedDay: lossUsd >= dailyLossLimitUsd || dayStart - bookEquity >= dailyLossLimitUsd ? day : state.dailyLossLockedDay,
  };
}
