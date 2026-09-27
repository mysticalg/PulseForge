import type { PaperAutomationSettings } from "./automationSettings";
import type { PaperEngineTrade, PaperMarketObservation } from "./paperEngine";
import { planLiveIntent, type LiveIntentPlan, type LivePlanOptions, type LiveTradingRequest, type LiveTradingStatus } from "./liveTrading";

const ENTRY_TTL_MS = 75_000;
const EXIT_RETRY_BUCKET_MS = 15_000;
const MAX_TRACKED_ENTRIES = 256;
const AUTOMATIC_ENTRIES = new Set(["automatic_entry", "automatic_conservative", "automatic_pump_scalp", "automatic_launch_flow"]);
const AUTOMATIC_EXITS = new Set(["take_profit", "stop_loss", "trailing_stop", "profit_lock", "max_hold", "buy_ratio_deterioration",
  "momentum_reversal", "volume_fade", "liquidity_drawdown", "daily_loss"]);

interface FollowedEntry {
  epoch: number;
  sequence: number;
  trade: PaperEngineTrade;
  intentId: string;
  phase: "queued" | "submitted" | "held" | "done";
  close?: { tradeId: string; reason: string };
  lastExitIntentId?: string;
  detached?: boolean;
}

/** Memory only. Loading saved paper history can never recreate pending real buys. */
export interface LivePaperFollowSession {
  owner: string;
  generation: number;
  nonce: string;
  startedAtMs: number;
  paperEpoch: number;
  lastSequence: number;
  entries: readonly FollowedEntry[];
  lastMessage: string | null;
}

export interface LivePaperFollowPlan extends LiveIntentPlan {
  session: LivePaperFollowSession;
}

export function createLivePaperFollowSession(
  status: LiveTradingStatus,
  nowMs: number,
  nextPaperTradeSequence: number,
  nonce: string = crypto.randomUUID(),
): LivePaperFollowSession | null {
  if (!status.available || !status.armed || !status.owner || status.config.entryMode !== "paperSignals"
    || !Number.isSafeInteger(status.sessionGeneration) || status.sessionGeneration < 0
    || !Number.isFinite(nowMs) || nowMs <= 0 || !validSequence(nextPaperTradeSequence)
    || !/^[A-Za-z0-9-]{8,40}$/.test(nonce)) return null;
  return { owner: status.owner, generation: status.sessionGeneration, nonce, startedAtMs: nowMs,
    paperEpoch: 0, lastSequence: nextPaperTradeSequence - 1, entries: [], lastMessage: null };
}

export function discardQueuedLivePaperBuys(session: LivePaperFollowSession): LivePaperFollowSession {
  return { ...session, entries: session.entries.filter(entry => entry.phase !== "queued") };
}

/** A manual paper close ends that paper episode without authorizing a real sale. */
export function detachLivePaperPosition(session: LivePaperFollowSession, mint: string): LivePaperFollowSession {
  return { ...session, entries: session.entries.filter(entry => entry.trade.mint !== mint || entry.phase !== "queued")
    .map(entry => entry.trade.mint === mint ? { ...entry, detached: true } : entry) };
}

/** A paper reset changes event identity; it is never an instruction to sell real holdings. */
export function resetLivePaperFollow(session: LivePaperFollowSession, nextPaperTradeSequence: number): LivePaperFollowSession {
  if (!validSequence(nextPaperTradeSequence)) return discardQueuedLivePaperBuys(session);
  return { ...discardQueuedLivePaperBuys(session), paperEpoch: session.paperEpoch + 1,
    lastSequence: nextPaperTradeSequence - 1 };
}

export function ingestLivePaperTrades(
  session: LivePaperFollowSession,
  status: LiveTradingStatus,
  trades: readonly PaperEngineTrade[],
  nowMs: number,
  options: Pick<LivePlanOptions, "mode" | "pauseEntries">,
): LivePaperFollowSession {
  if (!matchesSession(session, status)) return discardQueuedLivePaperBuys(session);
  let next = options.pauseEntries ? discardQueuedLivePaperBuys(session) : session;
  if (options.mode !== "live" || !Number.isFinite(nowMs)) return next;
  const entries = next.entries.filter(entry => entry.phase !== "done").map(entry => ({ ...entry }));
  for (const trade of trades) {
    const sequence = sequenceOf(trade.id);
    if (sequence === null || sequence <= next.lastSequence) continue;
    next = { ...next, lastSequence: sequence };
    if (!Number.isFinite(trade.timestampMs) || trade.timestampMs < session.startedAtMs
      || trade.timestampMs > nowMs || nowMs - trade.timestampMs > ENTRY_TTL_MS) continue;
    if (trade.side === "BUY" && AUTOMATIC_ENTRIES.has(trade.reason)) {
      if (options.pauseEntries) {
        next.lastMessage = `Paper ${trade.symbol} was skipped: live entries were paused`;
        continue;
      }
      if (entries.length >= MAX_TRACKED_ENTRIES) {
        next.lastMessage = `Paper ${trade.symbol} was skipped: live signal tracking is full`;
        continue;
      }
      entries.push({ epoch: next.paperEpoch, sequence, trade: { ...trade },
        intentId: `paper:${next.nonce}:${next.paperEpoch}:${trade.id}:BUY`, phase: "queued" });
    } else if (trade.side === "SELL" && AUTOMATIC_EXITS.has(trade.reason)) {
      const linked = [...entries].reverse().find(entry => entry.epoch === next.paperEpoch
        && entry.trade.mint === trade.mint && entry.sequence < sequence && !entry.close && !entry.detached && entry.phase !== "done");
      if (!linked) continue;
      linked.close = { tradeId: trade.id, reason: trade.reason };
      if (linked.phase === "queued") {
        linked.phase = "done";
        next.lastMessage = `Paper ${trade.symbol} closed before its live buy; entry cancelled`;
      }
    }
  }
  return { ...next, entries: entries.filter(entry => entry.phase !== "done") };
}

/** Mark dispatch before awaiting IPC: an uncertain response must never repeat a buy. */
export function markLivePaperRequestSubmitted(session: LivePaperFollowSession, request: LiveTradingRequest): LivePaperFollowSession {
  if (request.sessionGeneration !== session.generation) return session;
  return { ...session, entries: session.entries.map(entry => request.side === "BUY" && request.intentId === entry.intentId
    ? { ...entry, phase: "submitted" }
    : request.side === "SELL" && request.positionId === entry.intentId
      ? { ...entry, lastExitIntentId: request.intentId } : entry) };
}

export function planLivePaperFollow(
  session: LivePaperFollowSession,
  status: LiveTradingStatus,
  observations: readonly PaperMarketObservation[],
  settings: PaperAutomationSettings,
  nowMs: number,
  options: Pick<LivePlanOptions, "mode" | "pauseEntries">,
): LivePaperFollowPlan {
  const wait = (next: LivePaperFollowSession, message: string): LivePaperFollowPlan => ({ session: next, request: null, message });
  if (!matchesSession(session, status)) return wait(discardQueuedLivePaperBuys(session), "Paper following stopped because the live session changed");
  let next = options.pauseEntries ? discardQueuedLivePaperBuys(session) : session;
  let lastMessage = next.lastMessage;
  const entries = next.entries.map(entry => {
    let current = { ...entry };
    const position = status.positions.find(position => position.id === entry.intentId && position.mint === entry.trade.mint);
    const order = status.recentOrders.find(order => order.id === entry.intentId && order.side === "BUY" && order.mint === entry.trade.mint);
    if (position) current.phase = "held";
    else if (order && failed(order.status)) {
      current.phase = "done";
      lastMessage = `Paper ${entry.trade.symbol} live buy failed${order.detail ? `: ${order.detail}` : ""}`;
    } else if (order) current.phase = confirmed(order.status) ? "done" : "submitted";
    else if (entry.phase === "held") current.phase = "done";
    if (current.phase === "queued" && (!Number.isFinite(nowMs) || nowMs < entry.trade.timestampMs
      || nowMs - entry.trade.timestampMs > ENTRY_TTL_MS)) {
      current.phase = "done";
      lastMessage = `Paper ${entry.trade.symbol} was skipped: entry expired before live execution`;
    }
    return current;
  }).filter(entry => entry.phase !== "done");
  next = { ...next, entries, lastMessage };
  const paperExits = Object.fromEntries(entries.filter(entry => entry.close && entry.phase === "held").map(entry => [entry.intentId, {
    reason: entry.close!.reason,
    intentId: `paperexit:${next.nonce}:${entry.epoch}:${entry.close!.tradeId}:${Math.floor(nowMs / EXIT_RETRY_BUCKET_MS)}`,
  }]));
  // A full pending/unknown journal prevents all new execution; the queued buy
  // retains its original timestamp and is allowed to expire while waiting.
  const candidate = entries.find(entry => entry.phase === "queued" && !entry.close);
  const paperSignal = candidate ? { intentId: candidate.intentId, mint: candidate.trade.mint,
    reason: candidate.trade.reason, signalAtMs: candidate.trade.timestampMs } : undefined;
  const plan = planLiveIntent(status, observations, settings, nowMs, { ...options, paperSignal, paperExits });
  if (plan.request?.side === "SELL") {
    const linked = entries.find(entry => entry.intentId === plan.request!.positionId);
    if (linked?.lastExitIntentId === plan.request.intentId) return wait(next, "Waiting for the submitted live exit to reconcile");
  }
  if (candidate && !plan.request) {
    next = { ...next, lastMessage: `Paper ${candidate.trade.symbol} waiting: ${plan.message}` };
    return { ...plan, session: next, message: next.lastMessage! };
  }
  if (!candidate && !plan.request && plan.message.startsWith("Following paper") && next.lastMessage) {
    return wait(next, next.lastMessage);
  }
  return { ...plan, session: next };
}

function matchesSession(session: LivePaperFollowSession, status: LiveTradingStatus): boolean {
  return status.available && status.armed && status.owner === session.owner
    && status.sessionGeneration === session.generation && status.config.entryMode === "paperSignals";
}

function validSequence(sequence: number): boolean { return Number.isSafeInteger(sequence) && sequence >= 1; }
function sequenceOf(id: string): number | null {
  const match = /^paper-([1-9]\d*)$/.exec(id);
  const sequence = match ? Number(match[1]) : NaN;
  return validSequence(sequence) ? sequence : null;
}
function confirmed(status: string): boolean { return ["confirmed", "success", "succeeded", "finalized"].includes(status.toLowerCase()); }
function failed(status: string): boolean { return ["failed", "rejected", "expired", "cancelled", "canceled"].includes(status.toLowerCase()); }
