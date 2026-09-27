import { AlertTriangle, Check, Clipboard, LockKeyhole, ShieldCheck, X, XCircle } from "lucide-react";
import { useState } from "react";
import { formatMoney, formatPrice } from "../lib/strategy";
import type { LiveCanaryExecution, LiveCanaryPreview, LiveCanaryStatus, MarketToken, QuoteEstimate } from "../types";
import { Sparkline } from "./Charts";
import { LiveCanaryPanel } from "./LiveCanaryPanel";

interface Props {
  token: MarketToken;
  quote: QuoteEstimate | null;
  sizeUsd: number;
  killSwitch: boolean;
  quoteLoading: boolean;
  manualBlockers: readonly string[];
  launchPattern?: "breakout" | "pullback-reclaim" | null;
  launchPatternDetail?: string;
  maxPriceImpactPct: number;
  onSizeChange: (size: number) => void;
  onPaperBuy: () => void;
  onClose: () => void;
  liveCanaryStatus: LiveCanaryStatus;
  livePreview: LiveCanaryPreview | null;
  liveExecution: LiveCanaryExecution | null;
  liveBusy: boolean;
  onPreviewLiveBuy: (amountUsd: number) => void | Promise<void>;
  onPreviewLiveSell: (percent: 25 | 50 | 100) => void | Promise<void>;
  onExecuteLive: (confirmation: string) => void | Promise<void>;
  onCancelLivePreview: () => void;
}

function CheckRow({ passed, label, value }: { passed: boolean | null; label: string; value: string }) {
  return (
    <li className={passed === true ? "check-pass" : passed === false ? "check-fail" : "check-warn"}>
      {passed === true ? <Check size={13} /> : passed === false ? <X size={13} /> : <AlertTriangle size={13} />}
      <span>{label}</span>
      <strong>{value}</strong>
    </li>
  );
}

export function DecisionInspector({ token, quote, sizeUsd, killSwitch, quoteLoading, manualBlockers, launchPattern, launchPatternDetail, maxPriceImpactPct, onSizeChange, onPaperBuy, onClose, liveCanaryStatus, livePreview, liveExecution, liveBusy, onPreviewLiveBuy, onPreviewLiveSell, onExecuteLive, onCancelLivePreview }: Props) {
  const [copied, setCopied] = useState(false);
  const safety = token.safety;
  const quoteOnlyBlockers = (quote?.blockers ?? []).filter((quoteBlocker) => (
    !manualBlockers.some((manualBlocker) => blockerFamily(manualBlocker) === blockerFamily(quoteBlocker))
  ));
  const blockers = [...new Set([...manualBlockers, ...quoteOnlyBlockers])];
  const blocked = quoteLoading || !quote?.canPaperTrade || blockers.length > 0;

  const copyMint = async () => {
    await navigator.clipboard?.writeText(token.mint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };

  return (
    <aside className="decision-inspector" aria-label="Decision inspector">
      <div className="inspector-token">
        <div>
          <span className={`token-orb risk-bg-${token.riskLevel.toLowerCase().replace("-", "")}`}>{token.symbol.slice(0, 2)}</span>
          <div>
            <h2>{token.symbol}</h2>
            <span>{token.name}</span>
          </div>
        </div>
        <button aria-label="Close inspector" className="icon-button" onClick={onClose}><X size={18} /></button>
      </div>
      <button className="mint-address" onClick={copyMint} title={token.mint}>
        {token.mint.slice(0, 8)}…{token.mint.slice(-5)}
        {copied ? <Check size={13} /> : <Clipboard size={13} />}
      </button>

      <div className="mini-market">
        <div>
          <strong>{formatPrice(token.priceUsd)} <small>USD</small></strong>
          <span className={token.change5mPct >= 0 ? "text-positive" : "text-danger"}>
            {token.change5mPct >= 0 ? "+" : ""}{token.change5mPct.toFixed(2)}% (5m)
          </span>
        </div>
        <Sparkline token={token} />
      </div>

      <div className="model-summary">
        <div>
          <span>Raw model score</span>
          <strong>{token.modelScore.toFixed(2)}</strong>
          <small>Uncalibrated baseline</small>
        </div>
        <div>
          <span>Edge threshold</span>
          <strong className={token.modelScore >= 0.68 ? "text-positive" : "text-amber"}>
            {token.modelScore >= 0.68 ? "Pass" : "Abstain"}
          </strong>
          <small>Paper signal only</small>
        </div>
      </div>

      <section className="execution-estimate">
        <h3>Launch pattern · research rules</h3>
        <strong className={launchPattern ? "text-positive" : "text-amber"}>{launchPattern === "breakout" ? "Orderly breakout" : launchPattern === "pullback-reclaim" ? "Pullback recovery" : "No confirmed pattern"}</strong>
        <p>{launchPatternDetail ?? "Waiting for fresh launch observations"}</p>
      </section>

      <section className="execution-estimate">
        <h3>Execution estimate</h3>
        <dl>
          <div><dt>Est. fill price</dt><dd>{quote ? formatPrice(quote.expectedPriceUsd) : "—"}</dd></div>
          <div><dt>Price impact</dt><dd className={(quote?.priceImpactPct ?? 0) > maxPriceImpactPct ? "text-amber" : "text-positive"}>{quote ? `${quote.priceImpactPct.toFixed(2)}%` : "—"}</dd></div>
          <div><dt>Fees</dt><dd>{quote ? formatMoney(quote.feeUsd, 2) : "—"}</dd></div>
          <div><dt>Route</dt><dd>{quote?.route ?? "Calculating…"}</dd></div>
        </dl>
      </section>

      <section className="safety-checks">
        <div className="subhead"><h3>Safety checks</h3><ShieldCheck size={15} /></div>
        <ul>
          <CheckRow passed={safety.mintAuthorityRevoked} label="Mint authority" value={safety.mintAuthorityRevoked ? "Revoked" : "Active / unknown"} />
          <CheckRow passed={safety.freezeAuthorityRevoked} label="Freeze authority" value={safety.freezeAuthorityRevoked ? "Revoked" : "Active / unknown"} />
          <CheckRow passed={safety.topTenHolderPct <= 35} label="Top 10 holders" value={`${safety.topTenHolderPct.toFixed(1)}%`} />
          <CheckRow passed={safety.liquidityLocked} label="Liquidity lock" value={safety.liquidityLocked === null ? "Unknown" : safety.liquidityLocked ? "Observed" : "Not proven"} />
          <CheckRow passed={quote ? quote.priceImpactPct <= maxPriceImpactPct : null} label="Price impact" value={quote ? `${quote.priceImpactPct.toFixed(2)}% / ${maxPriceImpactPct}% max` : "…"} />
          <CheckRow passed={safety.transferTaxPct <= 1} label="Transfer tax" value={safety.transferTaxUnknown ? "Unverified / blocked" : `${safety.transferTaxPct.toFixed(1)}%`} />
        </ul>
      </section>

      <section className="order-ticket">
        <label htmlFor="paper-size">Position size (USD)</label>
        <div className="money-input">
          <span>$</span>
          <input
            id="paper-size"
            type="number"
            min="5"
            max="250"
            step="5"
            value={sizeUsd}
            onChange={(event) => onSizeChange(Number(event.target.value))}
          />
        </div>
        <div className="quick-sizes">
          {[5, 25, 100].map((value) => (
            <button key={value} className={sizeUsd === value ? "is-active" : ""} onClick={() => onSizeChange(value)}>${value}</button>
          ))}
        </div>
        <div className="token-estimate"><span>Est. tokens</span><strong>{quote ? Math.round(quote.expectedTokens).toLocaleString() : "—"}</strong></div>
      </section>

      {blockers.length > 0 && (
        <div className="blocker-note" role="status" aria-live="polite">
          <XCircle size={15} />
          <div>
            <strong>Paper buy unavailable</strong>
            <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
          </div>
        </div>
      )}

      <button className="paper-buy" disabled={blocked} onClick={onPaperBuy}>
        <LockKeyhole size={17} />
        {killSwitch ? "TRADING STOPPED" : quoteLoading ? "CHECKING…" : blocked ? "PAPER BUY BLOCKED" : "PAPER BUY"}
      </button>
      <LiveCanaryPanel
        status={liveCanaryStatus}
        preview={livePreview}
        execution={liveExecution}
        busy={liveBusy}
        onPreviewBuy={onPreviewLiveBuy}
        onPreviewSell={onPreviewLiveSell}
        onExecute={onExecuteLive}
        onCancel={onCancelLivePreview}
      />
    </aside>
  );
}

function blockerFamily(blocker: string) {
  const normalized = blocker.toLowerCase();
  if (normalized.includes("liquidity")) return "liquidity";
  if (normalized.includes("impact")) return "impact";
  if (normalized.includes("authority") || normalized.includes("authorities")) return "authority";
  if (normalized.includes("top-holder")) return "holders";
  if (normalized.includes("transfer tax")) return "tax";
  return normalized;
}
