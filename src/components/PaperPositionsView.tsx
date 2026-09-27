import { History, LoaderCircle, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { hasFreshPortfolioPrice } from "../lib/portfolioFreshness";
import { useListKeyboardNavigation } from "../hooks/useListKeyboardNavigation";
import { compareText, directedComparison, nextSortState, type SortState } from "../lib/sorting";
import { formatMoney, formatPrice } from "../lib/strategy";
import type { MarketToken, PaperAccount } from "../types";
import { SortHeader, SortReset } from "./SortControls";
import { TokenIdentity } from "./TokenIdentity";

export type PaperCloseFraction = 0.25 | 0.5 | 1;

export type PaperExitReason =
  | "manual"
  | "take_profit"
  | "profit_lock"
  | "stop_loss"
  | "trailing_stop"
  | "max_hold"
  | "daily_loss_limit"
  | "kill_switch"
  | "risk_gate"
  | string;

export interface PaperPositionCloseRequest {
  mint: string;
  fraction: PaperCloseFraction;
  reason: "manual";
}

export interface PaperExitRecord {
  id: string;
  mint: string;
  symbol: string;
  quantity: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  realizedPnlUsd: number;
  closedAt: string;
  reason: PaperExitReason;
}

export interface PaperPositionsViewProps {
  account: PaperAccount;
  equityUsd: number;
  unrealizedPnlUsd: number;
  exits?: readonly PaperExitRecord[];
  tokens?: readonly MarketToken[];
  onClosePosition?: (request: PaperPositionCloseRequest) => void | Promise<void>;
}

const CLOSE_FRACTIONS: readonly PaperCloseFraction[] = [0.25, 0.5, 1];

function formatQuantity(quantity: number) {
  return quantity.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatExitReason(reason: PaperExitReason) {
  return reason
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatClosedAt(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function PaperPositionsView({
  account,
  equityUsd,
  unrealizedPnlUsd,
  exits = [],
  tokens = [],
  onClosePosition,
}: PaperPositionsViewProps) {
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [clockMs, setClockMs] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setClockMs(Date.now()), 5_000); return () => window.clearInterval(timer); }, []);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [positionSort, setPositionSort] = useState<SortState<PositionSortKey> | null>(null);
  const [exitSort, setExitSort] = useState<SortState<ExitSortKey> | null>(null);
  const [activePositionMint, setActivePositionMint] = useState<string | null>(null);
  const [activeExitId, setActiveExitId] = useState<string | null>(null);
  const tokenByMint = useMemo(() => new Map(tokens.map((token) => [token.mint, token])), [tokens]);
  const entryReasonByMint = useMemo(() => {
    const reasons = new Map<string, string>();
    for (const trade of account.trades) {
      if (trade.side === "BUY" && !reasons.has(trade.mint)) reasons.set(trade.mint, trade.reason);
    }
    return reasons;
  }, [account.trades]);
  const positionRows = useMemo(() => account.positions.map((position) => {
    const costUsd = position.quantity * position.averagePriceUsd;
    const valueUsd = position.quantity * position.lastPriceUsd;
    const pnlUsd = valueUsd - costUsd;
    return {
      position,
      token: tokenByMint.get(position.mint),
      fresh: hasFreshPortfolioPrice(tokenByMint.get(position.mint), clockMs),
      costUsd,
      valueUsd,
      pnlUsd,
      pnlPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0,
      entryReason: describeEntryReason(entryReasonByMint.get(position.mint)),
    };
  }).sort((a, b) => {
    if (positionSort === null) return 0;
    let comparison = 0;
    if (positionSort.key === "asset") comparison = compareText(a.position.symbol, b.position.symbol);
    if (positionSort.key === "entry") comparison = a.position.averagePriceUsd - b.position.averagePriceUsd;
    if (positionSort.key === "current") comparison = a.position.lastPriceUsd - b.position.lastPriceUsd;
    if (positionSort.key === "size") comparison = a.valueUsd - b.valueUsd;
    if (positionSort.key === "pnl") comparison = a.pnlUsd - b.pnlUsd;
    if (positionSort.key === "reason") comparison = compareText(a.entryReason.label, b.entryReason.label);
    return directedComparison(comparison, positionSort.direction) || compareText(a.position.mint, b.position.mint);
  }), [account.positions, entryReasonByMint, positionSort, tokenByMint, clockMs]);
  const unpricedCount = positionRows.filter(row => !row.fresh).length;
  const exitRows = useMemo(() => [...exits].sort((a, b) => {
    if (exitSort === null) return 0;
    let comparison = 0;
    if (exitSort.key === "asset") comparison = compareText(a.symbol, b.symbol);
    if (exitSort.key === "size") comparison = a.quantity - b.quantity;
    if (exitSort.key === "entry") comparison = a.entryPriceUsd - b.entryPriceUsd;
    if (exitSort.key === "exit") comparison = a.exitPriceUsd - b.exitPriceUsd;
    if (exitSort.key === "pnl") comparison = a.realizedPnlUsd - b.realizedPnlUsd;
    if (exitSort.key === "reason") comparison = compareText(formatExitReason(a.reason), formatExitReason(b.reason));
    return directedComparison(comparison, exitSort.direction) || compareText(a.id, b.id);
  }), [exitSort, exits]);
  const positionKeys = useMemo(() => positionRows.map((row) => row.position.mint), [positionRows]);
  const positionNavigation = useListKeyboardNavigation({
    keys: positionKeys,
    activeKey: activePositionMint,
    onActivate: setActivePositionMint,
  });
  const exitKeys = useMemo(() => exitRows.map((row) => row.id), [exitRows]);
  const exitNavigation = useListKeyboardNavigation({
    keys: exitKeys,
    activeKey: activeExitId,
    onActivate: setActiveExitId,
  });
  const investedUsd = account.positions.reduce(
    (total, position) => total + position.quantity * position.lastPriceUsd,
    0,
  );

  const closePosition = async (mint: string, fraction: PaperCloseFraction) => {
    if (!onClosePosition || closingKey) return;
    const key = `${mint}:${fraction}`;
    setClosingKey(key);
    setCloseError(null);
    try {
      await onClosePosition({ mint, fraction, reason: "manual" });
    } catch (error) {
      setCloseError(error instanceof Error ? error.message : String(error));
    } finally {
      setClosingKey(null);
    }
  };

  return (
    <div className="paper-portfolio">
      <div className="portfolio-summary portfolio-summary--five">
        <div><span>Equity</span><strong>{unpricedCount ? "Unavailable" : formatMoney(equityUsd, 2)}</strong></div>
        <div><span>Cash</span><strong>{formatMoney(account.cashUsd, 2)}</strong></div>
        <div><span>Position value</span><strong>{unpricedCount ? "Unavailable" : formatMoney(investedUsd, 2)}</strong></div>
        <div>
          <span>Unrealized P&amp;L</span>
          <strong className={unrealizedPnlUsd >= 0 ? "text-positive" : "text-danger"}>
            {unpricedCount ? "—" : formatMoney(unrealizedPnlUsd, 2)}
          </strong>
        </div>
        <div>
          <span>Realized P&amp;L</span>
          <strong className={account.realizedPnlUsd >= 0 ? "text-positive" : "text-danger"}>
            {formatMoney(account.realizedPnlUsd, 2)}
          </strong>
        </div>
      </div>

      {unpricedCount > 0 && <p className="integration-note" role="status">{unpricedCount} paper holding(s) have no fresh price. Equity and unrealized P&amp;L are unavailable. Unpriced holdings still occupy position slots; a missing price is not a completed exit.</p>}

      <section className="positions-section" aria-labelledby="open-positions-title">
        <div className="positions-section-title">
          <div>
            <h2 id="open-positions-title">Open positions</h2>
            <span>{account.positions.length} held</span>
          </div>
          {!onClosePosition && account.positions.length > 0 ? (
            <span className="integration-note">Close handler not connected</span>
          ) : null}
          <SortReset active={positionSort !== null} onReset={() => setPositionSort(null)} />
        </div>
        <div className="positions-table">
          <div className="positions-head">
            <SortHeader label="Asset" active={positionSort?.key === "asset"} direction={positionSort?.direction ?? "asc"} onSort={() => setPositionSort(nextSortState(positionSort, "asset"))} />
            <SortHeader label="Entry price" active={positionSort?.key === "entry"} direction={positionSort?.direction ?? "desc"} onSort={() => setPositionSort(nextSortState(positionSort, "entry", "desc"))} />
            <SortHeader label="Current price" active={positionSort?.key === "current"} direction={positionSort?.direction ?? "desc"} onSort={() => setPositionSort(nextSortState(positionSort, "current", "desc"))} />
            <SortHeader label="Size" active={positionSort?.key === "size"} direction={positionSort?.direction ?? "desc"} onSort={() => setPositionSort(nextSortState(positionSort, "size", "desc"))} />
            <SortHeader label="Unrealized" active={positionSort?.key === "pnl"} direction={positionSort?.direction ?? "desc"} onSort={() => setPositionSort(nextSortState(positionSort, "pnl", "desc"))} />
            <SortHeader label="Buy reason" active={positionSort?.key === "reason"} direction={positionSort?.direction ?? "asc"} onSort={() => setPositionSort(nextSortState(positionSort, "reason"))} />
            <span>Close</span>
          </div>
          {positionRows.length ? positionRows.map(({ position, token, fresh, valueUsd, pnlUsd, pnlPct, entryReason }) => {
            const keyboard = positionNavigation.rowProps(position.mint);
            return (
              <div
                className={`position-row ${positionNavigation.resolvedActiveKey === position.mint ? "is-keyboard-selected" : ""}`}
                key={position.mint}
                ref={keyboard.ref}
                tabIndex={keyboard.tabIndex}
                onKeyDown={keyboard.onKeyDown}
                onClick={() => setActivePositionMint(position.mint)}
              >
                <span><TokenIdentity symbol={position.symbol} name={token?.name} mint={position.mint} iconUrl={token?.iconUrl} compact /></span>
                <span className="price-cell">${formatPrice(position.averagePriceUsd)}</span>
                <span className="price-cell">{fresh ? `$${formatPrice(position.lastPriceUsd)}` : "Unpriced"}</span>
                <span className="position-size-cell">
                  <strong>{fresh ? formatMoney(valueUsd, 2) : "—"}</strong>
                  <small>{formatQuantity(position.quantity)} tokens</small>
                </span>
                <span className={pnlUsd >= 0 ? "text-positive position-pnl-cell" : "text-danger position-pnl-cell"}>
                  <strong>{fresh ? formatMoney(pnlUsd, 2) : "—"}</strong>
                  <small>{fresh ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%` : "Fresh price required"}</small>
                </span>
                <span className="entry-reason-cell"><strong>{entryReason.label}</strong><small>{entryReason.detail}</small></span>
                <span className="close-position-actions">
                  {CLOSE_FRACTIONS.map((fraction) => {
                    const key = `${position.mint}:${fraction}`;
                    const percentage = Math.round(fraction * 100);
                    return (
                      <button
                        type="button"
                        key={fraction}
                        aria-label={`Close ${percentage}% of ${position.symbol}`}
                        title={onClosePosition ? `Paper close ${percentage}%` : "Connect onClosePaperPosition to enable"}
                        disabled={!onClosePosition || closingKey !== null}
                        onClick={() => closePosition(position.mint, fraction)}
                      >
                        {closingKey === key ? <LoaderCircle size={12} className="spin" /> : `${percentage}%`}
                      </button>
                    );
                  })}
                </span>
              </div>
            );
          }) : (
            <div className="table-empty">
              <Wallet size={28} />
              <strong>No paper positions</strong>
              <span>Eligible paper entries will appear here with partial-close controls.</span>
            </div>
          )}
        </div>
        {closeError ? <p className="position-action-error" role="alert">{closeError}</p> : null}
      </section>

      <section className="positions-section" aria-labelledby="exit-history-title">
        <div className="positions-section-title">
          <div>
            <h2 id="exit-history-title">Exit history</h2>
            <span>{exits.length} recorded</span>
          </div>
          <SortReset active={exitSort !== null} onReset={() => setExitSort(null)} />
        </div>
        <div className="exit-table">
          <div className="exit-head">
            <SortHeader label="Asset" active={exitSort?.key === "asset"} direction={exitSort?.direction ?? "asc"} onSort={() => setExitSort(nextSortState(exitSort, "asset"))} />
            <SortHeader label="Size closed" active={exitSort?.key === "size"} direction={exitSort?.direction ?? "desc"} onSort={() => setExitSort(nextSortState(exitSort, "size", "desc"))} />
            <SortHeader label="Entry" active={exitSort?.key === "entry"} direction={exitSort?.direction ?? "desc"} onSort={() => setExitSort(nextSortState(exitSort, "entry", "desc"))} />
            <SortHeader label="Exit" active={exitSort?.key === "exit"} direction={exitSort?.direction ?? "desc"} onSort={() => setExitSort(nextSortState(exitSort, "exit", "desc"))} />
            <SortHeader label="Realized" active={exitSort?.key === "pnl"} direction={exitSort?.direction ?? "desc"} onSort={() => setExitSort(nextSortState(exitSort, "pnl", "desc"))} />
            <SortHeader label="Exit reason" active={exitSort?.key === "reason"} direction={exitSort?.direction ?? "asc"} onSort={() => setExitSort(nextSortState(exitSort, "reason"))} />
          </div>
          {exitRows.length ? exitRows.map((exit) => {
            const keyboard = exitNavigation.rowProps(exit.id);
            return <div
              className={`exit-row ${exitNavigation.resolvedActiveKey === exit.id ? "is-keyboard-selected" : ""}`}
              key={exit.id}
              ref={keyboard.ref}
              tabIndex={keyboard.tabIndex}
              onKeyDown={keyboard.onKeyDown}
              onClick={() => setActiveExitId(exit.id)}
            >
              <span><TokenIdentity symbol={exit.symbol} name={`${tokenByMint.get(exit.mint)?.name ?? "Token"} · ${formatClosedAt(exit.closedAt)}`} mint={exit.mint} iconUrl={tokenByMint.get(exit.mint)?.iconUrl} compact /></span>
              <span>{formatQuantity(exit.quantity)}</span>
              <span className="price-cell">${formatPrice(exit.entryPriceUsd)}</span>
              <span className="price-cell">${formatPrice(exit.exitPriceUsd)}</span>
              <span className={exit.realizedPnlUsd >= 0 ? "text-positive" : "text-danger"}>{formatMoney(exit.realizedPnlUsd, 2)}</span>
              <span className="exit-reason">{formatExitReason(exit.reason)}</span>
            </div>;
          }) : (
            <div className="history-empty"><History size={16} /><span>No paper exits recorded yet.</span></div>
          )}
        </div>
      </section>
    </div>
  );
}

type PositionSortKey = "asset" | "entry" | "current" | "size" | "pnl" | "reason";
type ExitSortKey = "asset" | "size" | "entry" | "exit" | "pnl" | "reason";

function describeEntryReason(reason?: string) {
  if (reason === "automatic_pump_scalp") return { label: "Pump scalp", detail: "Momentum, flow and safety gates passed" };
  if (reason === "automatic_launch_flow") return { label: "High-risk launch scout", detail: "Route persistence, price/volume continuation, and contract gates passed" };
  if (reason === "automatic_conservative") return { label: "Conservative", detail: "Score, liquidity and safety gates passed" };
  if (reason === "manual_entry") return { label: "Manual", detail: "User-initiated paper entry" };
  if (reason === "automatic_entry") return { label: "Automatic", detail: "Strategy gates passed" };
  return { label: "Recorded entry", detail: reason ? formatExitReason(reason) : "Legacy entry reason unavailable" };
}
