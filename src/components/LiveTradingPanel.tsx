import { useEffect, useState, type FormEvent } from "react";
import { ArrowDownUp, ExternalLink, Pause, Play, RefreshCw, ShieldCheck, Square, Wallet } from "lucide-react";
import { defaultLiveTradingConfig, hasFreshLiveMark, LIVE_ENTRY_SAFETY, type LiveTradingConfig, type LiveTradingStatus, type PaperEntryCriteria } from "../lib/liveTrading";
import type { WalletPortfolio } from "../types";
import "./LiveTradingPanel.css";

export interface LiveTradingPanelProps {
  status: LiveTradingStatus | null;
  busy: boolean;
  message: string;
  pauseEntries: boolean;
  onPauseEntries: (paused: boolean) => void;
  onArm: (config: LiveTradingConfig, acknowledgement: string) => Promise<void>;
  onDisarm: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onClosePosition: (positionId: string) => Promise<void>;
  onQuarantinePosition?: (positionId: string) => Promise<void>;
  strategyLabel: string;
  walletPortfolio: WalletPortfolio | null;
  canArm: boolean;
  paperEntryCriteria?: PaperEntryCriteria;
}

type NumberConfigKey = {
  [Key in keyof LiveTradingConfig]-?: LiveTradingConfig[Key] extends number ? Key : never;
}[keyof LiveTradingConfig];

const CONFIG_FIELDS: ReadonlyArray<{
  key: NumberConfigKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: "maxOrderUsd", label: "Maximum per buy", unit: "USD", min: 1, max: 1_000, step: 0.01 },
  { key: "dailyBuyCapUsd", label: "Daily buy input cap", unit: "USD", min: 1, max: 10_000, step: 0.01 },
  { key: "maxOpenPositions", label: "Open position limit", unit: "positions", min: 1, max: 25, step: 1 },
  { key: "dailyLossLimitUsd", label: "Daily loss limit", unit: "USD", min: 1, max: 10_000, step: 0.01 },
  { key: "maxSlippageBps", label: "Maximum slippage", unit: "bps", min: 1, max: 500, step: 1 },
  { key: "maxPriceImpactPct", label: "Maximum price impact", unit: "%", min: 0.01, max: 5, step: 0.01 },
  { key: "minLiquidityUsd", label: "Minimum liquidity", unit: "USD", min: LIVE_ENTRY_SAFETY.minLiquidityUsd, max: 100_000_000, step: 1 },
];

function money(value: number | null | undefined): string {
  return value != null && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    : "—";
}

function timestamp(value: number): string {
  return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : "—";
}

function rawQuantity(raw: string, decimals: number): string | null {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const digits = raw.replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  if (decimals === 0) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

function shortQuantity(value: string | null): string {
  if (value == null) return "—";
  if (value.length <= 18) return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 }).format(numeric) : `${value.slice(0, 16)}…`;
}

function signatureUrl(signature: string | null | undefined): string | null {
  if (!signature || signature.length > 88 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(signature)) return null;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const character of signature) value = value * 58n + BigInt(alphabet.indexOf(character));
  const zeroBytes = signature.match(/^1*/)?.[0].length ?? 0;
  const byteLength = value === 0n ? 0 : Math.ceil(value.toString(16).length / 2);
  return zeroBytes + byteLength === 64 ? `https://solscan.io/tx/${signature}` : null;
}

function LiveSessionForm({
  config,
  status,
  busy,
  canArm,
  strategyLabel,
  paperEntryCriteria,
  onArm,
}: {
  config: LiveTradingConfig;
  status: LiveTradingStatus | null;
  busy: boolean;
  canArm: boolean;
  strategyLabel: string;
  paperEntryCriteria?: PaperEntryCriteria;
  onArm: LiveTradingPanelProps["onArm"];
}) {
  const [entryMode, setEntryMode] = useState<NonNullable<LiveTradingConfig["entryMode"]>>(config.entryMode ?? "guardedDiscovery");
  const [values, setValues] = useState<Record<NumberConfigKey, string>>(() => Object.fromEntries(
    CONFIG_FIELDS.map(({ key, min }) => [key, String(key === "minLiquidityUsd"
      ? Math.max(config.entryMode === "paperSignals" ? 2_000 : min, config[key]) : config[key])]),
  ) as Record<NumberConfigKey, string>);
  const [allowHighRisk, setAllowHighRisk] = useState(config.allowHighRisk);
  const [acknowledgement, setAcknowledgement] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const armed = status?.armed ?? false;
  const locked = armed || busy || starting;
  const phrase = status?.acknowledgementPhrase ?? "";
  const followsPaper = entryMode === "paperSignals";
  const liquidityFloor = followsPaper ? 2_000 : LIVE_ENTRY_SAFETY.minLiquidityUsd;
  const entryCriteria = armed ? config.paperEntryCriteria : paperEntryCriteria ?? config.paperEntryCriteria;
  const parsed = Object.fromEntries(CONFIG_FIELDS.map(({ key }) => [key, Number(values[key])])) as Record<NumberConfigKey, number>;
  const invalidField = CONFIG_FIELDS.find(({ key, min, max, step }) => values[key].trim() === ""
    || !Number.isFinite(parsed[key]) || parsed[key] < (key === "minLiquidityUsd" ? liquidityFloor : min) || parsed[key] > max
    || (step === 1 && !Number.isInteger(parsed[key])));
  const limitsError = invalidField ? `Enter a valid ${invalidField.label.toLowerCase()}.`
    : parsed.maxOrderUsd > parsed.dailyBuyCapUsd ? "The daily buy cap must cover at least one maximum buy."
      : followsPaper && !entryCriteria ? "Waiting for the current paper entry criteria." : "";
  const effectiveLiquidityUsd = Number.isFinite(parsed.minLiquidityUsd)
    ? Math.max(parsed.minLiquidityUsd, liquidityFloor, followsPaper ? entryCriteria?.minLiquidityUsd ?? 0 : 0) : null;
  const ready = !locked && canArm && status?.available && !!status.owner && status.pendingCount === 0
    && !!phrase && acknowledgement === phrase && !limitsError;

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || starting) return;
    setStarting(true);
    setError("");
    try {
      await onArm({ ...parsed, allowHighRisk, entryMode, paperEntryCriteria: followsPaper ? entryCriteria ?? null : null }, acknowledgement);
      setAcknowledgement("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
    <form className="live-wallet-setup" onSubmit={start}>
      <fieldset className="live-wallet-limits" disabled={locked}>
        <legend>Live limits</legend>
        <p>Independent of paper capital. Buy amounts are swap principal, plus network fees and token-account rent.</p>
        <label className="live-wallet-field live-wallet-entry-source">
          <span>Trade source</span>
          <select value={entryMode} onChange={(event) => setEntryMode(event.target.value === "paperSignals" ? "paperSignals" : "guardedDiscovery")}>
            <option value="paperSignals">Follow paper trades</option>
            <option value="guardedDiscovery">Guarded discovery</option>
          </select>
          <small>{followsPaper
            ? "Follow new automatic paper trades after this live session starts, within your live limits."
            : "Discover entries independently with mature-pool and observed-liquidity checks."}</small>
        </label>
        <div className="live-wallet-fields">
          {CONFIG_FIELDS.map(({ key, label, unit, min, max, step }) => (
            <label className="live-wallet-field" key={key}>
              <span>{label}</span>
              <span className="live-wallet-input">
                <input type="number" value={values[key]} min={key === "minLiquidityUsd" ? liquidityFloor : min} max={max} step={step}
                  onChange={(event) => setValues((previous) => ({ ...previous, [key]: event.target.value }))} />
                <small>{unit}</small>
              </span>
            </label>
          ))}
          <label className="live-wallet-risk-opt-in">
            <input type="checkbox" checked={allowHighRisk} onChange={(event) => setAllowHighRisk(event.target.checked)} />
            <span>Allow elevated-risk classifications<small>{followsPaper
              ? "Paper entry criteria and live execution checks still apply."
              : "The mature-pool, liquidity, holder and observation requirements always apply."}</small></span>
          </label>
        </div>
        <p className="live-wallet-field-note">100 bps = 1% slippage. Daily caps use UTC days; selling does not restore the buy allowance.</p>
      </fieldset>
      <div className="live-wallet-start">
        <div className="live-wallet-section-title"><ShieldCheck size={17} /><h2>{armed ? "Live signing armed" : "Start a live session"}</h2></div>
        <p>Trade source: <strong>{followsPaper ? "Follow paper trades" : "Guarded discovery"}</strong>. Strategy: <strong>{strategyLabel}</strong>. Buys spend SOL; managed positions sell back to SOL.</p>
        <p>Buy limits cover swap input. Each transaction may additionally spend up to <strong>0.02 SOL on fees and rent</strong>, while leaving 0.02 SOL in the wallet.</p>
        {armed ? (
          <p>Limits are locked while armed. Pausing entries keeps automatic exit checks enabled. Stop the session before changing limits.</p>
        ) : (
          <>
            <p>Starting authorizes automatic real swaps within these limits while the app is open and the computer is awake. Live automation stays off after restart.</p>
            {phrase && <label className="live-wallet-acknowledgement">
              <span>Type <strong>{phrase}</strong> to start</span>
              <input type="text" autoComplete="off" spellCheck={false} value={acknowledgement} disabled={busy || starting}
                onChange={(event) => setAcknowledgement(event.target.value)} placeholder="Session acknowledgement" />
            </label>}
            <button className="live-wallet-button live-wallet-button--start" type="submit" disabled={!ready}>
              <Play size={14} />{starting ? "Starting…" : "Start live automation"}
            </button>
            {limitsError && <p className="live-wallet-error" role="alert">{limitsError}</p>}
            {!canArm && status?.available && <p className="live-wallet-field-note">A fresh live feed and a cleared global stop are required to start.</p>}
          </>
        )}
        {error && <p className="live-wallet-error" role="alert">{error}</p>}
      </div>
    </form>
    <section className="live-wallet-section live-wallet-protection" aria-label={followsPaper ? "Following paper trades" : "Automatic buy protection"}>
      <div className="live-wallet-section-heading"><div>
        {followsPaper ? <>
          <h2>Following paper trades</h2>
          <p>Only new automatic paper BUY events after this session starts can trigger new live buys. Matching automatic paper SELL events are also followed. Earlier trades and manual paper trades are not copied. A paper SELL can close only its matching managed live position.</p>
          <p>Existing live exit checks remain active for managed positions and may sell earlier based on actual live fills and costs.</p>
          <p>Effective live minimum liquidity: <strong>{money(effectiveLiquidityUsd)}</strong>. This is the higher of your live minimum and the paper entry minimum. Paper buys in smaller pools are skipped.</p>
          {entryCriteria ? <p>{armed ? "Captured" : "Current"} paper entry criteria: pool age {entryCriteria.minTokenAgeSeconds.toLocaleString()}–{entryCriteria.maxTokenAgeSeconds.toLocaleString()} seconds; top ten holders at most {entryCriteria.maxTopTenHolderPct}%; at least {entryCriteria.minTraders5m} traders and {entryCriteria.minSells5m} sells in five minutes. {armed ? "These criteria stay fixed for this session." : "The current criteria are captured when the session starts."}</p>
            : <p>Waiting for the current paper entry criteria before a session can start.</p>}
          <p>Live spending limits, fresh market data, contract checks, quotes and transaction simulations still apply and may block a trade. Paper fills do not guarantee live fills or matching returns.</p>
        </> : <>
          <h2>Automatic buy protection</h2>
          <p>Discovery continues automatically. Real buys require all of these additional checks:</p>
          <ul>
            <li>Pool history of at least 24 hours, replacing the paper strategy's launch-age window.</li>
            <li>At least {money(effectiveLiquidityUsd)} liquidity and no more than 20% held by the top ten addresses.</li>
            <li>At least 25 traders and 10 sells in the latest five-minute activity report.</li>
            <li>Five minutes of fresh, distinct native observations with no liquidity drop greater than 10% from an observed peak.</li>
          </ul>
          <p>A failed check or missing history blocks a buy. Observation history warms up again after restart. Entry signals, contract checks and sell-route preflight still apply; existing exit rules are unchanged.</p>
          <p>Observed liquidity stability does not verify that liquidity is locked or guarantee that a later sale will succeed.</p>
          <p>{status?.entrySafety
            ? `${Object.values(status.entrySafety).filter(check => check.ready).length} observed tokens currently pass the additional buy checks; an entry signal is still required.`
            : "Waiting for native buy-protection checks."}</p>
        </>}
      </div></div>
    </section>
    </>
  );
}

export function LiveTradingPanel({ status, busy, message, pauseEntries, onPauseEntries, onArm, onDisarm, onRefresh,
  onClosePosition, onQuarantinePosition, strategyLabel, walletPortfolio, canArm, paperEntryCriteria }: LiveTradingPanelProps) {
  const [actionError, setActionError] = useState("");
  const [quarantineId, setQuarantineId] = useState<string | null>(null);
  const [clockMs, setClockMs] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  const [action, setAction] = useState<string | null>(null);
  const armed = status?.armed ?? false;
  const blocked = !status?.available;
  const working = busy || action !== null;
  const config = status?.config ?? defaultLiveTradingConfig;
  const owner = status?.owner ?? walletPortfolio?.address ?? null;
  const portfolioMatches = !!owner && walletPortfolio?.address === owner;
  const positions = status?.positions ?? [];
  const orders = status?.recentOrders ?? [];
  const quarantined = status?.quarantinedPositions ?? [];
  const quarantineTarget = positions.find(position => position.id === quarantineId);
  const pendingCount = status?.pendingCount ?? 0;

  const runAction = async (name: string, callback: () => Promise<void>) => {
    if (action && name !== "stop") return;
    setAction(name);
    setActionError("");
    try { await callback(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setAction((current) => current === name ? null : current); }
  };

  return (
    <div className="workspace-view live-wallet-view">
      <header className="view-header live-wallet-header">
        <div><h1><Wallet size={22} />Live wallet</h1><p>Automatic trading from your imported wallet, using the selected strategy and separate live limits.</p></div>
        <div className="live-wallet-header-actions">
          <span className={`live-wallet-state ${armed ? "live-wallet-state--armed" : ""}`}>
            <i />{armed ? pauseEntries ? "ARMED · ENTRIES PAUSED" : "ARMED" : blocked ? status ? "UNAVAILABLE" : "LOADING" : "STOPPED"}
          </span>
          <button className="live-wallet-button" type="button" disabled={working} onClick={() => void runAction("refresh", onRefresh)}>
            <RefreshCw size={14} className={action === "refresh" ? "spin" : ""} />Refresh
          </button>
        </div>
      </header>

      <section className="live-wallet-balance" aria-label="Signing wallet and live limits usage">
        <div className="live-wallet-owner"><span>Signing wallet</span><strong title={owner ?? undefined}>{owner ?? "Import a wallet in Settings"}</strong></div>
        <div><span>Native SOL balance</span><strong>{portfolioMatches && walletPortfolio?.solBalance != null ? `${walletPortfolio.solBalance.toFixed(5)} SOL` : "—"}</strong><small>0.02 SOL reserved for transaction costs</small></div>
        <div><span>Daily buy inputs / cap</span><strong>{money(status?.dailyBuyUsedUsd)} <small>/ {money(config.dailyBuyCapUsd)}</small></strong><small>UTC day · includes reserved pending buys</small></div>
        <div><span>Daily realized P&amp;L</span><strong className={(status?.dailyRealizedPnlUsd ?? 0) < 0 ? "live-wallet-negative" : ""}>{money(status?.dailyRealizedPnlUsd)}</strong><small>Daily loss limit {money(config.dailyLossLimitUsd)}</small><small>Quarantine risk loss today: {money(status?.dailyQuarantineLossUsd ?? 0)} (separate from realized P&amp;L)</small></div>
      </section>

      {(status?.blocker || message || actionError || walletPortfolio?.warning) && <div className="live-wallet-notices" aria-live="polite">
        {status?.blocker && <p>{status.blocker}</p>}
        {message && message !== status?.blocker && <p>{message}</p>}
        {portfolioMatches && walletPortfolio?.warning && <p>{walletPortfolio.warning}</p>}
        {actionError && <p className="live-wallet-error" role="alert">{actionError}</p>}
      </div>}

      {(armed || busy) && <section className="live-wallet-session-controls" aria-label="Live session controls">
        <div><strong>{!armed ? "Live action in progress." : pauseEntries ? "Live signing armed; entries paused." : "Live signing armed."}</strong>
          <p>The status message above shows current trading activity or blockers. Stopping ends new submissions, including exits. Transactions already submitted may still land.</p></div>
        <div className="live-wallet-actions">
          {armed && <button className="live-wallet-button" type="button" disabled={working} onClick={() => onPauseEntries(!pauseEntries)}>
            {pauseEntries ? <Play size={14} /> : <Pause size={14} />}{pauseEntries ? "Resume entries" : "Pause entries"}
          </button>}
          <button className="live-wallet-button live-wallet-button--stop" type="button" disabled={action === "stop"} onClick={() => void runAction("stop", onDisarm)}>
            <Square size={13} />{action === "stop" ? "Stopping…" : "Stop live session"}
          </button>
        </div>
      </section>}

      <LiveSessionForm key={`${owner ?? "none"}:${armed}:${JSON.stringify(config)}`} config={config} status={status}
        busy={working} canArm={canArm} strategyLabel={strategyLabel} paperEntryCriteria={paperEntryCriteria} onArm={onArm} />

      <section className="live-wallet-section" aria-labelledby="live-managed-positions">
        <div className="live-wallet-section-heading"><div><h2 id="live-managed-positions">Managed live positions <span>{positions.length} / {config.maxOpenPositions}</span></h2>
          <p>Only positions opened by this live automation are managed. Tokens already in the wallet are not automatically sold.</p></div>
          <span className="live-wallet-pending">{pendingCount} pending {pendingCount === 1 ? "order" : "orders"}</span>
        </div>
        {positions.length === 0 ? <div className="live-wallet-empty"><ArrowDownUp size={23} /><div><strong>No managed live positions</strong><p>Confirmed buys will appear here. A submitted transaction is not yet a fill.</p></div></div> : (
          <div className="live-wallet-table-wrap"><table className="live-wallet-table">
            <thead><tr><th scope="col">Token / opened</th><th scope="col">Quantity</th><th scope="col">Cost basis</th><th scope="col">Estimated value</th><th scope="col">Estimated P&amp;L</th><th scope="col">Action</th></tr></thead>
            <tbody>{positions.map((position) => {
              const quantity = rawQuantity(position.quantityRaw, position.decimals);
              const fresh = hasFreshLiveMark(position, clockMs);
              const mark = fresh && quantity != null ? Number(quantity) * position.lastPriceUsd : null;
              const pnl = mark != null && Number.isFinite(mark) ? mark - position.costBasisUsd : null;
              return <tr key={position.id}>
                <td><strong title={position.mint}>{position.symbol || "Unknown token"}</strong><small>{timestamp(position.openedAtMs)}</small></td>
                <td className="live-wallet-numeric" title={quantity ?? undefined}>{shortQuantity(quantity)}</td>
                <td className="live-wallet-numeric">{money(position.costBasisUsd)}</td>
                <td className="live-wallet-numeric">{money(mark)}<small>{fresh ? `Mark: ${timestamp(position.lastMarkAtMs!)}` : position.lastMarkAtMs ? `Stale mark: ${timestamp(position.lastMarkAtMs)}` : "No fresh market mark"}</small></td>
                <td className={`live-wallet-numeric ${(pnl ?? 0) < 0 ? "live-wallet-negative" : (pnl ?? 0) > 0 ? "live-wallet-positive" : ""}`}>{money(pnl)}</td>
                <td><button className="live-wallet-button" type="button" disabled={!armed || working || pendingCount > 0}
                  aria-label={`Close 100% of managed ${position.symbol || "token"} position`}
                  onClick={() => void runAction(position.id, () => onClosePosition(position.id))}>{action === position.id ? "Submitting…" : "Close 100%"}</button>
                  {!fresh && onQuarantinePosition && <><button className="live-wallet-button" type="button" disabled={armed || working || pendingCount > 0}
                    aria-label={`Quarantine ${position.symbol || "token"} position`} onClick={() => setQuarantineId(position.id)}>Quarantine</button>
                    {armed && <small>Stop live session to quarantine</small>}</>}
                </td>
              </tr>;
            })}</tbody>
          </table></div>
        )}
        <p className="live-wallet-table-note">Marks are estimates before sell costs, not guaranteed proceeds. Value and P&amp;L are unavailable when the last mark is over 75 seconds old. A quote failure leaves the tokens held; closing is complete only after on-chain confirmation.</p>
      </section>

      {quarantineTarget && onQuarantinePosition && <section className="live-wallet-section" aria-label="Confirm quarantine">
        <div className="live-wallet-section-heading"><div><h2>Quarantine {quarantineTarget.symbol}?</h2>
          <p>Tokens stay in your wallet. Automatic exits stop for this holding, and automatic re-entry into this mint is blocked.</p>
          <p>The full {money(quarantineTarget.costBasisUsd)} cost counts against today's live loss limit. No sale, proceeds or realized P&amp;L will be recorded. Other entries can resume only within your remaining limits after you start a live session.</p>
          <p>Mint: {quarantineTarget.mint}</p></div></div>
        <div className="live-wallet-actions"><button className="live-wallet-button" disabled={working} onClick={() => setQuarantineId(null)}>Cancel quarantine</button>
          <button className="live-wallet-button" disabled={armed || working || pendingCount > 0 || hasFreshLiveMark(quarantineTarget, clockMs)}
            onClick={() => void runAction(`quarantine:${quarantineTarget.id}`, async () => { await onQuarantinePosition(quarantineTarget.id); setQuarantineId(null); })}>Confirm quarantine and count risk loss</button></div>
      </section>}

      {quarantined.length > 0 && <section className="live-wallet-section" aria-labelledby="live-quarantined-positions">
        <div className="live-wallet-section-heading"><div><h2 id="live-quarantined-positions">Quarantined holdings <span>{quarantined.length}</span></h2>
          <p>Tokens remain in the wallet. These holdings have no automatic exits and do not occupy active slots or block unrelated entries. Re-entry into these mints is disabled.</p></div></div>
        <div className="live-wallet-table-wrap"><table className="live-wallet-table"><thead><tr><th>Token / mint</th><th>Recorded quantity</th><th>Risk loss</th><th>Quarantined</th></tr></thead>
          <tbody>{quarantined.map(row => <tr key={row.position.id}><td><strong>{row.position.symbol}</strong><small>{row.position.mint}</small></td>
            <td>{shortQuantity(rawQuantity(row.position.quantityRaw, row.position.decimals))}</td><td>{money(row.riskLossUsd)}</td><td>{timestamp(row.quarantinedAtMs)}</td></tr>)}</tbody></table></div>
      </section>}

      <section className="live-wallet-section" aria-labelledby="live-recent-orders">
        <div className="live-wallet-section-heading"><div><h2 id="live-recent-orders">Recent live orders</h2><p>Transaction status is reconciled on chain; pending orders remain visible until their outcome is known.</p></div></div>
        {orders.length === 0 ? <div className="live-wallet-empty"><p>No live orders submitted.</p></div> : (
          <div className="live-wallet-table-wrap"><table className="live-wallet-table live-wallet-orders">
            <thead><tr><th scope="col">Time</th><th scope="col">Side / token</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Details</th><th scope="col">Transaction</th></tr></thead>
            <tbody>{orders.map((order) => {
              const url = signatureUrl(order.signature);
              return <tr key={order.id}>
                <td>{timestamp(order.createdAtMs)}</td>
                <td><strong title={order.mint}>{order.side} {order.symbol}</strong></td>
                <td className="live-wallet-numeric">{money(order.amountUsd)}</td>
                <td><span className="live-wallet-order-state">{order.status}</span></td>
                <td className="live-wallet-order-detail">{order.detail || "—"}</td>
                <td>{url ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`View ${order.side} ${order.symbol} transaction on Solscan`}>Solscan <ExternalLink size={12} /></a> : "—"}</td>
              </tr>;
            })}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
