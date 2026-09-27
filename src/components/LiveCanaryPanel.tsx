import { AlertTriangle, ExternalLink, Flame, RefreshCw, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { LiveCanaryExecution, LiveCanaryPreview, LiveCanaryStatus } from "../types";

interface Props {
  status: LiveCanaryStatus;
  preview: LiveCanaryPreview | null;
  execution: LiveCanaryExecution | null;
  busy: boolean;
  onPreviewBuy: (amountUsd: number) => void | Promise<void>;
  onPreviewSell: (percent: 25 | 50 | 100) => void | Promise<void>;
  onExecute: (confirmation: string) => void | Promise<void>;
  onCancel: () => void;
}

export function LiveCanaryPanel({ status, preview, execution, busy, onPreviewBuy, onPreviewSell, onExecute, onCancel }: Props) {
  const [amountUsd, setAmountUsd] = useState(5);
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => setConfirmation(""), [preview?.challengeId]);

  return (
    <section className="live-canary-ticket" aria-label="Manual live canary">
      <div className="live-canary-heading">
        <div><Flame size={14} /><strong>Manual live canary</strong></div>
        <span className={status.armed ? "is-armed" : ""}>{status.armed ? "ARMED" : "DISARMED"}</span>
      </div>
      <p>Real funds · manual confirmation per swap. Manage automatic sessions in Live wallet.</p>

      {!status.armed ? (
        <div className="live-canary-locked">
          <ShieldAlert size={15} />
          <span>{status.blocker ?? "Arm manual live canary in Settings for this app session."}</span>
        </div>
      ) : preview ? (
        <div className="live-preview-card">
          <button className="live-preview-close" onClick={onCancel} aria-label="Cancel live preview"><X size={13} /></button>
          <strong>{preview.side} {preview.symbol} — REAL SWAP</strong>
          <dl>
            <div><dt>Exact input</dt><dd>{preview.inputLabel}</dd></div>
            <div><dt>Expected output</dt><dd>{preview.expectedOutputLabel}</dd></div>
            <div><dt>Impact / slippage</dt><dd>{preview.priceImpactPct.toFixed(2)}% / {preview.slippageBps} bps</dd></div>
            <div><dt>Jupiter fee / router</dt><dd>{preview.feeBps} bps / {preview.router}</dd></div>
            <div><dt>Preview expires</dt><dd>{new Date(preview.expiresAt).toLocaleTimeString("en-GB", { hour12: false })}</dd></div>
          </dl>
          <label htmlFor="live-confirmation">Type <code>{preview.confirmationPhrase}</code></label>
          <input
            id="live-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className="submit-live-swap"
            disabled={busy || confirmation !== preview.confirmationPhrase}
            onClick={() => onExecute(confirmation)}
          >
            {busy ? <RefreshCw size={14} className="spin" /> : <AlertTriangle size={14} />}
            {busy ? "SUBMITTING…" : "SUBMIT REAL SWAP"}
          </button>
        </div>
      ) : execution ? (
        <div className="live-execution-success">
          <strong>{execution.side} {execution.symbol} confirmed</strong>
          <a href={execution.explorerUrl} target="_blank" rel="noreferrer">View transaction <ExternalLink size={12} /></a>
        </div>
      ) : (
        <>
          <div className="live-buy-line">
            <label htmlFor="live-buy-amount">Live buy USD</label>
            <input
              id="live-buy-amount"
              type="number"
              min="1"
              max={status.maxOrderUsd}
              step="1"
              value={amountUsd}
              onChange={(event) => setAmountUsd(Number(event.target.value))}
            />
            <button disabled={busy || status.cooldownRemainingSeconds > 0} onClick={() => onPreviewBuy(amountUsd)}>Preview buy</button>
          </div>
          <div className="live-sell-line">
            <span>Sell selected wallet token</span>
            {[25, 50, 100].map((percent) => (
              <button key={percent} disabled={busy || status.cooldownRemainingSeconds > 0} onClick={() => onPreviewSell(percent as 25 | 50 | 100)}>{percent}%</button>
            ))}
          </div>
          <small>
            ${status.dailyBuyUsedUsd.toFixed(2)} / ${status.dailyBuyCapUsd.toFixed(2)} UTC buy cap used
            {status.cooldownRemainingSeconds > 0 ? ` · ${status.cooldownRemainingSeconds}s cooldown` : ""}
          </small>
        </>
      )}
    </section>
  );
}
