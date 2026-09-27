import {
  AlertTriangle,
  Activity,
  ArrowRight,
  CircleGauge,
  CloudCog,
  Copy,
  Database,
  Download,
  KeyRound,
  LockKeyhole,
  RotateCcw,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useListKeyboardNavigation } from "../hooks/useListKeyboardNavigation";
import { compareNullableNumber, compareText, directedComparison, nextSortState, type SortState } from "../lib/sorting";
import { formatAge, formatMoney } from "../lib/strategy";
import type { PaperEvidence } from "../lib/paperView";
import type { ShadowLabState, ShadowPolicyId, ShadowPolicyMetrics } from "../lib/shadowLab";
import {
  AutomationPanel,
  DEFAULT_PAPER_AUTOMATION_SETTINGS,
  type PaperAutomationSettings,
} from "./AutomationPanel";
import {
  PaperPositionsView,
  type PaperExitRecord,
  type PaperPositionCloseRequest,
} from "./PaperPositionsView";
import { SortHeader, SortReset } from "./SortControls";
import { TokenIdentity } from "./TokenIdentity";
import type {
  CalibrationStatus,
  LiveCanaryStatus,
  MarketSnapshot,
  NavView,
  PaperAccount,
  RuntimeInfo,
  WalletPortfolio,
  WalletStatus,
} from "../types";

export interface WorkspaceViewProps {
  view: Exclude<NavView, "market" | "live-wallet">;
  snapshot: MarketSnapshot;
  account: PaperAccount;
  equityUsd: number;
  unrealizedPnlUsd: number;
  runtime: RuntimeInfo;
  walletStatus: WalletStatus;
  walletPortfolio: WalletPortfolio | null;
  walletBusy: boolean;
  onImportWallet: () => Promise<void>;
  onForgetWallet: () => Promise<void>;
  onRefreshWallet: () => Promise<void>;
  paperExits?: readonly PaperExitRecord[];
  onClosePaperPosition?: (request: PaperPositionCloseRequest) => void | Promise<void>;
  automationSettings?: PaperAutomationSettings;
  onAutomationSettingsChange?: (settings: PaperAutomationSettings) => void;
  paperEvidence?: PaperEvidence;
  currentPaperCapitalUsd?: number;
  automationStatus?: string;
  onResetPaperAccount?: () => void;
  calibrationStatus?: CalibrationStatus;
  onExportCalibration?: () => void | Promise<void>;
  onImportResearchArtifact?: () => void | Promise<void>;
  onForgetResearchArtifact?: () => void | Promise<void>;
  shadowLab?: ShadowLabState;
  shadowMetrics?: readonly ShadowPolicyMetrics[];
  onResetShadowLab?: () => void;
  liveCanaryStatus?: LiveCanaryStatus;
  liveCanaryBusy?: boolean;
  onArmLiveCanary?: (acknowledgement: string) => void | Promise<void>;
  onDisarmLiveCanary?: () => void | Promise<void>;
}

export function WorkspaceView(props: WorkspaceViewProps) {
  if (props.view === "signals") return <SignalsView {...props} />;
  if (props.view === "positions") return <PositionsView {...props} />;
  if (props.view === "models") return <ModelsView {...props} />;
  if (props.view === "backtests") return <StrategyLabView {...props} />;
  return <SettingsView {...props} />;
}

function ViewHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="view-header"><div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function SignalsView({ snapshot }: WorkspaceViewProps) {
  const [sort, setSort] = useState<SortState<SignalSortKey> | null>(null);
  const [activeSignalMint, setActiveSignalMint] = useState<string | null>(null);
  const ranked = useMemo(() => [...snapshot.tokens].sort((a, b) => {
    if (sort === null) return b.modelScore - a.modelScore || compareText(a.mint, b.mint);
    const aVeto = hasSignalVeto(a);
    const bVeto = hasSignalVeto(b);
    let comparison = 0;
    if (sort.key === "candidate") comparison = compareText(a.symbol, b.symbol);
    if (sort.key === "model") comparison = a.modelScore - b.modelScore;
    if (sort.key === "liquidity") comparison = a.liquidityUsd - b.liquidityUsd;
    if (sort.key === "veto") comparison = Number(aVeto) - Number(bVeto);
    if (sort.key === "decision") comparison = compareText(signalDecision(a, aVeto), signalDecision(b, bVeto));
    return directedComparison(comparison, sort.direction) || compareText(a.mint, b.mint);
  }), [snapshot.tokens, sort]);
  const signalMints = useMemo(() => ranked.map((token) => token.mint), [ranked]);
  const signalNavigation = useListKeyboardNavigation({
    keys: signalMints,
    activeKey: activeSignalMint,
    onActivate: setActiveSignalMint,
  });
  return (
    <div className="workspace-view">
      <ViewHeader
        title="Signals"
        description="Every model score is subordinate to deterministic safety and cost gates."
        action={<SortReset active={sort !== null} onReset={() => setSort(null)} />}
      />
      <div className="signal-list">
        <div className="signal-head">
          <SortHeader label="Candidate" active={sort?.key === "candidate"} direction={sort?.direction ?? "asc"} onSort={() => setSort(nextSortState(sort, "candidate"))} />
          <SortHeader label="Model" active={sort?.key === "model"} direction={sort?.direction ?? "desc"} onSort={() => setSort(nextSortState(sort, "model", "desc"))} />
          <SortHeader label="Liquidity" active={sort?.key === "liquidity"} direction={sort?.direction ?? "desc"} onSort={() => setSort(nextSortState(sort, "liquidity", "desc"))} />
          <SortHeader label="Safety veto" active={sort?.key === "veto"} direction={sort?.direction ?? "asc"} onSort={() => setSort(nextSortState(sort, "veto"))} />
          <SortHeader label="Decision" active={sort?.key === "decision"} direction={sort?.direction ?? "asc"} onSort={() => setSort(nextSortState(sort, "decision"))} />
        </div>
        {ranked.map((token) => {
          const veto = hasSignalVeto(token);
          const decision = signalDecision(token, veto);
          const keyboard = signalNavigation.rowProps(token.mint);
          return (
            <div
              className={`signal-row ${signalNavigation.resolvedActiveKey === token.mint ? "is-keyboard-selected" : ""}`}
              key={token.mint}
              ref={keyboard.ref}
              tabIndex={keyboard.tabIndex}
              onKeyDown={keyboard.onKeyDown}
              onClick={() => setActiveSignalMint(token.mint)}
            >
              <span><TokenIdentity symbol={token.symbol} name={`${token.name} · ${formatAge(token.ageSeconds)} old`} mint={token.mint} iconUrl={token.iconUrl} compact /></span>
              <span className={token.modelScore >= 0.68 ? "text-positive" : "text-amber"}>{token.modelScore.toFixed(2)}</span>
              <span>{formatMoney(token.liquidityUsd)}</span>
              <span className={veto ? "text-danger" : "text-positive"}>{veto ? "Active" : "Clear"}</span>
              <span><i className={decision === "Paper eligible" ? "decision-pass" : "decision-wait"} />{decision}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type SignalSortKey = "candidate" | "model" | "liquidity" | "veto" | "decision";

function hasSignalVeto(token: MarketSnapshot["tokens"][number]) {
  return !token.safety.mintAuthorityRevoked
    || !token.safety.freezeAuthorityRevoked
    || token.safety.topTenHolderPct > 35
    || token.liquidityUsd < 50_000;
}

function signalDecision(token: MarketSnapshot["tokens"][number], veto = hasSignalVeto(token)) {
  return !veto && token.modelScore >= 0.68 ? "Paper eligible" : "Abstain";
}

function PositionsView({ snapshot, account, equityUsd, unrealizedPnlUsd, paperExits, onClosePaperPosition }: WorkspaceViewProps) {
  return (
    <div className="workspace-view">
      <ViewHeader title="Paper portfolio" description="Fills include an explicit fee and impact estimate; they do not model real queue position or MEV." />
      <PaperPositionsView
        account={account}
        equityUsd={equityUsd}
        unrealizedPnlUsd={unrealizedPnlUsd}
        exits={paperExits}
        tokens={snapshot.tokens}
        onClosePosition={onClosePaperPosition}
      />
    </div>
  );
}

function ModelsView({ runtime, calibrationStatus, onExportCalibration, onImportResearchArtifact, onForgetResearchArtifact }: WorkspaceViewProps) {
  const calibration = calibrationStatus;
  const artifact = calibration?.researchArtifact;
  const championLabel = artifact?.champion === "histGradientBoosting" ? "Histogram gradient boosting" : "Random Forest";
  return (
    <div className="workspace-view">
      <ViewHeader title="Model registry" description="Training remains off-path. Imported research reports are visible here but cannot silently change paper decisions." />
      <div className="model-layout">
        <section className="model-primary">
          <div className="model-title"><CircleGauge size={22} /><div><h2>Compact GBDT-style baseline</h2><span>Shipped ranking control</span></div><span className="status-tag status-tag--warning">RAW · UNCALIBRATED</span></div>
          <p>The shipped leaves are hand-authored to exercise inference and safety plumbing. Its output is a raw ranking score, not a probability, and cannot unlock live automation.</p>
          <dl className="model-metadata">
            <div><dt>Runtime</dt><dd>Rust · fixed float vector</dd></div>
            <div><dt>Hot-path allocation</dt><dd>None</dd></div>
            <div><dt>Status</dt><dd>{runtime.modelStatus}</dd></div>
            <div><dt>Planned target</dt><dd>45m net forward markout</dd></div>
          </dl>
          <div className="feature-strip">
            {["5m momentum", "Liquidity", "Volume / liquidity", "Buy ratio", "Pool age", "Holder concentration", "Authorities", "Verification"].map((feature) => <span key={feature}>{feature}</span>)}
          </div>
        </section>
        <aside className="model-challenger">
          <h3>{artifact ? `${championLabel} research champion` : "Random Forest + GBDT challengers"}</h3>
          {artifact ? (
            <>
              <p>Calibrated offline on chronological evidence. It is a research result only and is not loaded into the paper execution path.</p>
              <dl className="research-artifact-metrics">
                <div><dt>Evidence</dt><dd>{artifact.datasetRows.toLocaleString()} rows · {artifact.observationSpanDays.toFixed(1)}d</dd></div>
                <div><dt>Untouched test</dt><dd>{artifact.testRows.toLocaleString()} rows</dd></div>
                <div><dt>ROC AUC</dt><dd>{artifact.calibratedRocAuc?.toFixed(3) ?? "—"} <small>vs {artifact.baselineRocAuc?.toFixed(3) ?? "—"} raw</small></dd></div>
                <div><dt>Cost-stressed picks</dt><dd className={artifact.costStressedMeanReturnPct > 0 ? "text-positive" : "text-danger"}>{artifact.selectedObservations} · {artifact.costStressedMeanReturnPct >= 0 ? "+" : ""}{artifact.costStressedMeanReturnPct.toFixed(2)}%</dd></div>
              </dl>
              <div className="research-artifact-actions">
                <button onClick={onImportResearchArtifact}><Download size={15} /> Replace report</button>
                <button onClick={onForgetResearchArtifact}><Trash2 size={15} /> Remove</button>
              </div>
            </>
          ) : (
            <>
              <p>Both candidates can now be compared and calibrated by the offline trainer. Import its JSON report to show the result here; importing never promotes it.</p>
              <button onClick={onImportResearchArtifact}><Download size={15} /> Import research report</button>
            </>
          )}
        </aside>
      </div>
      <section className="calibration-evidence">
        <div className="calibration-evidence__header">
          <div><Database size={19} /><span><strong>Point-in-time evidence recorder</strong><small>{calibration?.status ?? "Loading recorder status"}</small></span></div>
          <button onClick={onExportCalibration} disabled={!calibration || calibration.observationCount === 0}><Download size={14} />Export CSV</button>
        </div>
        <div className="calibration-evidence__metrics">
          <div><span>Snapshots</span><strong>{calibration?.observationCount.toLocaleString() ?? "0"}</strong></div>
          <div><span>45m labels</span><strong>{calibration?.labeledCount.toLocaleString() ?? "0"}</strong></div>
          <div><span>Positive / negative</span><strong>{calibration ? `${calibration.positiveCount} / ${calibration.negativeCount}` : "0 / 0"}</strong></div>
          <div><span>Unavailable outcomes</span><strong>{calibration?.unavailableCount.toLocaleString() ?? "0"}</strong></div>
          <div><span>Observation span</span><strong>{(calibration?.observationDays ?? 0).toFixed(1)}d</strong></div>
          <div><span>Quote probes</span><strong>{calibration?.quoteSampleCount.toLocaleString() ?? "0"}</strong></div>
          <div><span>Quote coverage</span><strong>{calibration?.realQuoteCoveragePct == null ? "—" : `${calibration.realQuoteCoveragePct.toFixed(1)}%`}</strong></div>
          <div><span>Median round-trip cost</span><strong>{calibration?.medianRoundTripCostPct == null ? "—" : `${calibration.medianRoundTripCostPct.toFixed(2)}%`}</strong></div>
          <div><span>Model-score drift</span><strong className={calibration?.driftStatus === "Stable" ? "text-positive" : calibration?.driftStatus === "Drift alert" ? "text-danger" : "text-amber"}>{calibration?.driftStatus ?? "Insufficient"}</strong></div>
          <div><span>Outcome QA</span><strong className={calibration?.invalidOutcomeCount ? "text-danger" : "text-positive"}>{calibration ? `${calibration.invalidOutcomeCount} excluded · ${calibration.boundedOutcomeCount} bounded` : "—"}</strong></div>
          <div><span>Research calibration gate</span><strong className={calibration?.readyForFirstCalibration ? "text-positive" : "text-amber"}>{calibration?.readyForFirstCalibration ? "READY" : "COLLECTING"}</strong></div>
        </div>
        <p>PulseForge records every live candidate once per minute, including abstentions. Labels replay the fixed evidence policy and bound gap returns to protect training from bad provider ticks. The one-day gate permits an early research run only; promotion still requires at least {calibration?.promotionEvidenceDays ?? 30} calendar days plus untouched cost-stressed evidence. Unsigned $20 route probes never build or submit a transaction.</p>
      </section>
      <div className="model-callout"><AlertTriangle size={18} /><div><strong>{artifact?.promotionEligible ? "Research checks passed; manual review still required" : "Model promotion remains locked"}</strong><span>{artifact ? `The imported ${championLabel} report is ${artifact.promotionEligible ? "eligible for review, not automatic activation" : "not profitable after the configured cost stress or lacks enough chronological evidence"}.` : "Run the offline comparison, import its report, then accumulate independent forward-shadow evidence."}</span></div></div>
    </div>
  );
}

const EXIT_REASONS = [
  ["stop_loss", "Stop loss"],
  ["trailing_stop", "Trailing stop"],
  ["take_profit", "Take profit"],
  ["profit_lock", "Profit lock"],
  ["liquidity_drawdown", "Liquidity drawdown"],
  ["buy_ratio_deterioration", "Flow deterioration"],
  ["momentum_reversal", "Momentum reversal"],
  ["volume_fade", "Volume fade"],
  ["max_hold", "Max hold"],
] as const;

function formatHold(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "—";
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

type LeaderboardSortKey = "policy" | "status" | "exits" | "winRate" | "pnl" | "expectancy" | "drawdown" | "cost" | "drift";
type AttributionSortKey = "reason" | "exits" | "winRate" | "pnl" | "hold";

function StrategyLabView({ shadowLab, shadowMetrics = [], calibrationStatus, onResetShadowLab }: WorkspaceViewProps) {
  const [selectedPolicy, setSelectedPolicy] = useState<ShadowPolicyId>("conservative");
  const [selectedAttribution, setSelectedAttribution] = useState<string | null>(null);
  const [leaderboardSort, setLeaderboardSort] = useState<SortState<LeaderboardSortKey> | null>(null);
  const [attributionSort, setAttributionSort] = useState<SortState<AttributionSortKey> | null>(null);
  const policy = shadowLab?.policies.find((candidate) => candidate.id === selectedPolicy);
  const selectedMetrics = shadowMetrics.find((candidate) => candidate.id === selectedPolicy);
  const calibrationReady = calibrationStatus?.readyForFirstCalibration ?? false;
  const sortedMetrics = useMemo(() => [...shadowMetrics].sort((a, b) => {
    if (leaderboardSort === null) return 0;
    let comparison = 0;
    if (leaderboardSort.key === "policy") comparison = compareText(a.label, b.label);
    if (leaderboardSort.key === "status") comparison = 0;
    if (leaderboardSort.key === "exits") comparison = a.completedExits - b.completedExits;
    if (leaderboardSort.key === "winRate") comparison = compareNullableNumber(a.winRatePct, b.winRatePct);
    if (leaderboardSort.key === "pnl") comparison = a.netPnlUsd - b.netPnlUsd;
    if (leaderboardSort.key === "expectancy") comparison = compareNullableNumber(a.expectancyUsd, b.expectancyUsd);
    if (leaderboardSort.key === "drawdown") comparison = a.maxDrawdownUsd - b.maxDrawdownUsd;
    if (leaderboardSort.key === "cost") comparison = a.costDragUsd - b.costDragUsd;
    if (leaderboardSort.key === "drift") comparison = compareText(calibrationStatus?.driftStatus ?? "Insufficient", calibrationStatus?.driftStatus ?? "Insufficient");
    return directedComparison(comparison, leaderboardSort.direction) || compareText(a.id, b.id);
  }), [calibrationStatus?.driftStatus, leaderboardSort, shadowMetrics]);
  const attributionRows = useMemo(() => EXIT_REASONS.map(([reason, label]) => {
    const row = policy?.exitAttribution[reason];
    return {
      reason,
      label,
      exits: row?.exits ?? 0,
      winRatePct: row?.exits ? row.wins / row.exits * 100 : null,
      netPnlUsd: row?.netPnlUsd ?? null,
      avgHoldMs: row?.exits ? row.totalHoldMs / row.exits : null,
    };
  }).sort((a, b) => {
    if (attributionSort === null) return 0;
    let comparison = 0;
    if (attributionSort.key === "reason") comparison = compareText(a.label, b.label);
    if (attributionSort.key === "exits") comparison = a.exits - b.exits;
    if (attributionSort.key === "winRate") comparison = compareNullableNumber(a.winRatePct, b.winRatePct);
    if (attributionSort.key === "pnl") comparison = compareNullableNumber(a.netPnlUsd, b.netPnlUsd);
    if (attributionSort.key === "hold") comparison = compareNullableNumber(a.avgHoldMs, b.avgHoldMs);
    return directedComparison(comparison, attributionSort.direction) || compareText(a.reason, b.reason);
  }), [attributionSort, policy]);
  const policyKeys = useMemo(() => sortedMetrics.map((metric) => metric.id), [sortedMetrics]);
  const policyNavigation = useListKeyboardNavigation({
    keys: policyKeys,
    activeKey: selectedPolicy,
    onActivate: (key) => setSelectedPolicy(key as ShadowPolicyId),
  });
  const attributionKeys = useMemo(() => attributionRows.map((row) => row.reason), [attributionRows]);
  const attributionNavigation = useListKeyboardNavigation({
    keys: attributionKeys,
    activeKey: selectedAttribution,
    onActivate: setSelectedAttribution,
  });
  return (
    <div className="workspace-view strategy-lab-view">
      <div className="view-header strategy-lab-header">
        <div><h1>Strategy Lab</h1><p>Compare every policy on the same live market observations before promotion.</p></div>
        <button className="strategy-reset" onClick={onResetShadowLab}><RotateCcw size={14} />Reset shadow ledgers</button>
      </div>

      <section className="strategy-panel shadow-leaderboard" aria-labelledby="shadow-leaderboard-title">
        <div className="strategy-panel-title"><div><Activity size={16} /><h2 id="shadow-leaderboard-title">Shadow policy leaderboard</h2></div><div className="strategy-panel-tools"><span>No capital · live observations only</span><SortReset active={leaderboardSort !== null} onReset={() => setLeaderboardSort(null)} /></div></div>
        <div className="shadow-head">
          <SortHeader label="Policy" active={leaderboardSort?.key === "policy"} direction={leaderboardSort?.direction ?? "asc"} onSort={() => setLeaderboardSort(nextSortState(leaderboardSort, "policy"))} />
          <SortHeader label="Status" active={leaderboardSort?.key === "status"} direction={leaderboardSort?.direction ?? "asc"} onSort={() => setLeaderboardSort(nextSortState(leaderboardSort, "status"))} />
          <SortHeader label="Exits" active={leaderboardSort?.key === "exits"} direction={leaderboardSort?.direction ?? "desc"} onSort={() => setLeaderboardSort(nextSortState(leaderboardSort, "exits", "desc"))} />
          <SortHeader label="Win rate" active={leaderboardSort?.key === "winRate"} direction={leaderboardSort?.direction ?? "desc"} onSort={() => setLeaderboardSort(nextSortState(leaderboardSort, "winRate", "desc"))} />
          <SortHeader label="Net P&L" active={leaderboardSort?.key === "pnl"} direction={leaderboardSort?.direction ?? "desc"} onSort={() => setLeaderboardSort(nextSortState(leaderboardSort, "pnl", "desc"))} />
          <SortHeader label="Expectancy" active={leaderboardSort?.key === "expectancy"} direction={leaderboardSort?.direction ?? "desc"} onSort={() => setLeaderboardSort(nextSortState(leaderboardSort, "expectancy", "desc"))} />
          <SortHeader label="Max drawdown" active={leaderboardSort?.key === "drawdown"} direction={leaderboardSort?.direction ?? "asc"} onSort={() => setLeaderboardSort(nextSortState(leaderboardSort, "drawdown"))} />
          <SortHeader label="Cost drag" active={leaderboardSort?.key === "cost"} direction={leaderboardSort?.direction ?? "asc"} onSort={() => setLeaderboardSort(nextSortState(leaderboardSort, "cost"))} />
          <SortHeader label="Drift" active={leaderboardSort?.key === "drift"} direction={leaderboardSort?.direction ?? "asc"} onSort={() => setLeaderboardSort(nextSortState(leaderboardSort, "drift"))} />
        </div>
        {sortedMetrics.map((metric) => {
          const keyboard = policyNavigation.rowProps(metric.id);
          return <button
            className={`shadow-row ${metric.id === selectedPolicy ? "is-selected" : ""}`}
            key={metric.id}
            ref={keyboard.ref as (node: HTMLButtonElement | null) => void}
            tabIndex={keyboard.tabIndex}
            onKeyDown={keyboard.onKeyDown}
            onClick={() => setSelectedPolicy(metric.id)}
          >
            <span><strong>{metric.label}</strong><small>{metric.description}</small></span>
            <span><i className="strategy-status-dot" />Collecting</span>
            <span>{metric.completedExits}</span>
            <span className={metric.winRatePct != null && metric.winRatePct >= 50 ? "text-positive" : ""}>{metric.winRatePct == null ? "—" : `${metric.winRatePct.toFixed(1)}%`}</span>
            <span className={metric.netPnlUsd > 0 ? "text-positive" : metric.netPnlUsd < 0 ? "text-danger" : ""}>{formatMoney(metric.netPnlUsd, 2)}</span>
            <span className={(metric.expectancyUsd ?? 0) > 0 ? "text-positive" : (metric.expectancyUsd ?? 0) < 0 ? "text-danger" : ""}>{metric.expectancyUsd == null ? "—" : formatMoney(metric.expectancyUsd, 2)}</span>
            <span className={metric.maxDrawdownUsd > 0 ? "text-danger" : ""}>{formatMoney(metric.maxDrawdownUsd, 2)}</span>
            <span>{formatMoney(metric.costDragUsd, 2)}</span>
            <span className={calibrationStatus?.driftStatus === "Drift alert" ? "text-danger" : calibrationStatus?.driftStatus === "Stable" ? "text-positive" : "text-amber"}>{calibrationStatus?.driftStatus ?? "Insufficient"}</span>
          </button>;
        })}
      </section>

      <div className="strategy-detail-grid">
        <section className="strategy-panel attribution-panel">
          <div className="strategy-panel-title"><div><h2>Exit attribution</h2></div><div className="strategy-panel-tools"><span>{selectedMetrics?.label ?? "Conservative v1"}</span><SortReset active={attributionSort !== null} onReset={() => setAttributionSort(null)} /></div></div>
          <div className="attribution-head">
            <SortHeader label="Exit reason" active={attributionSort?.key === "reason"} direction={attributionSort?.direction ?? "asc"} onSort={() => setAttributionSort(nextSortState(attributionSort, "reason"))} />
            <SortHeader label="Exits" active={attributionSort?.key === "exits"} direction={attributionSort?.direction ?? "desc"} onSort={() => setAttributionSort(nextSortState(attributionSort, "exits", "desc"))} />
            <SortHeader label="Win rate" active={attributionSort?.key === "winRate"} direction={attributionSort?.direction ?? "desc"} onSort={() => setAttributionSort(nextSortState(attributionSort, "winRate", "desc"))} />
            <SortHeader label="Net P&L" active={attributionSort?.key === "pnl"} direction={attributionSort?.direction ?? "desc"} onSort={() => setAttributionSort(nextSortState(attributionSort, "pnl", "desc"))} />
            <SortHeader label="Avg hold" active={attributionSort?.key === "hold"} direction={attributionSort?.direction ?? "desc"} onSort={() => setAttributionSort(nextSortState(attributionSort, "hold", "desc"))} />
          </div>
          {attributionRows.map((row) => {
            const keyboard = attributionNavigation.rowProps(row.reason);
            return <div
              className={`attribution-row ${attributionNavigation.resolvedActiveKey === row.reason ? "is-keyboard-selected" : ""}`}
              key={row.reason}
              ref={keyboard.ref}
              tabIndex={keyboard.tabIndex}
              onKeyDown={keyboard.onKeyDown}
              onClick={() => setSelectedAttribution(row.reason)}
            ><span>{row.label}</span><span>{row.exits}</span><span>{row.winRatePct == null ? "—" : `${row.winRatePct.toFixed(1)}%`}</span><span className={(row.netPnlUsd ?? 0) >= 0 ? "text-positive" : "text-danger"}>{row.netPnlUsd == null ? "—" : formatMoney(row.netPnlUsd, 2)}</span><span>{row.avgHoldMs == null ? "—" : formatHold(row.avgHoldMs)}</span></div>;
          })}
        </section>

        <aside className="strategy-panel execution-evidence">
          <div className="strategy-panel-title"><div><h2>Execution evidence</h2></div><span>Jupiter quote-only probes</span></div>
          <dl>
            <div><dt>Real quote coverage</dt><dd>{calibrationStatus?.realQuoteCoveragePct == null ? "—" : `${calibrationStatus.realQuoteCoveragePct.toFixed(1)}%`}</dd></div>
            <div><dt>Median round-trip cost</dt><dd>{calibrationStatus?.medianRoundTripCostPct == null ? "—" : `${calibrationStatus.medianRoundTripCostPct.toFixed(2)}%`}</dd></div>
            <div><dt>Route failures</dt><dd>{calibrationStatus?.quoteFailureCount ?? 0}</dd></div>
            <div><dt>Quote samples</dt><dd>{calibrationStatus?.quoteSampleCount ?? 0}</dd></div>
            <div><dt>Recorded fee + impact</dt><dd>{formatMoney(policy ? policy.totalFeesUsd + policy.totalImpactCostUsd : 0, 2)}</dd></div>
            <div><dt>Open shadow positions</dt><dd>{selectedMetrics?.openPositions ?? 0}</dd></div>
          </dl>
        </aside>
      </div>

      <section className="strategy-panel chronological-evidence">
        <div className="strategy-panel-title"><div><h2>Chronological evidence</h2></div><span>Same observations · no random shuffle</span></div>
        <div className="evidence-stages">
          <div><span>1</span><strong>Training</strong><small>{calibrationReady ? "Dataset ready" : "Waiting for evidence"}</small></div>
          <ArrowRight size={16} />
          <div><span>2</span><strong>Calibration</strong><small>{calibrationReady ? "Offline run required" : "Locked"}</small></div>
          <ArrowRight size={16} />
          <div><span>3</span><strong>Untouched test</strong><small>Locked</small></div>
          <ArrowRight size={16} />
          <div className="is-collecting"><span>4</span><strong>Forward shadow</strong><small>{shadowMetrics[0]?.completedExits ?? 0} completed exits</small></div>
        </div>
        <div className="promotion-lock"><LockKeyhole size={16} /><strong>Model promotion is locked</strong><span>Requires a passing untouched test, stable drift, cost stress, and seven consecutive forward-shadow days.</span></div>
      </section>
    </div>
  );
}

function SettingsView({
  runtime,
  walletStatus,
  walletPortfolio,
  walletBusy,
  onImportWallet,
  onForgetWallet,
  onRefreshWallet,
  automationSettings,
  onAutomationSettingsChange,
  currentPaperCapitalUsd,
  automationStatus,
  onResetPaperAccount,
  liveCanaryStatus,
  liveCanaryBusy,
  onArmLiveCanary,
  onDisarmLiveCanary,
}: WorkspaceViewProps) {
  const [showImport, setShowImport] = useState(false);
  const [walletError, setWalletError] = useState("");
  const [liveAcknowledgement, setLiveAcknowledgement] = useState("");
  const [liveError, setLiveError] = useState("");
  const [localAutomationSettings, setLocalAutomationSettings] = useState<PaperAutomationSettings>(() => ({
    ...DEFAULT_PAPER_AUTOMATION_SETTINGS,
  }));
  const activeAutomationSettings = automationSettings ?? localAutomationSettings;

  const updateAutomationSettings = (next: PaperAutomationSettings) => {
    if (automationSettings === undefined) setLocalAutomationSettings(next);
    onAutomationSettingsChange?.(next);
  };

  const importSecret = async () => {
    setWalletError("");
    try {
      await onImportWallet();
      setShowImport(false);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : String(error));
    }
  };

  const armManualLive = async () => {
    setLiveError("");
    try {
      await onArmLiveCanary?.(liveAcknowledgement);
      setLiveAcknowledgement("");
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="workspace-view settings-view">
      <ViewHeader title="Settings" description="Configure paper automation, provider access, and the separately gated manual live canary." />
      <div className="settings-grid">
        <AutomationPanel
          settings={activeAutomationSettings}
          onChange={updateAutomationSettings}
          currentPaperCapitalUsd={currentPaperCapitalUsd}
          automationStatus={automationStatus}
          onResetPaperAccount={onResetPaperAccount}
        />

        <section className="settings-section wallet-section">
          <div className="settings-title"><div><KeyRound size={19} /><h2>Live hot wallet</h2></div><span className={`status-tag ${walletStatus.imported ? "status-tag--ok" : ""}`}>{walletStatus.imported ? "IMPORTED" : "NOT IMPORTED"}</span></div>
          {walletStatus.imported ? (
            <>
              <div className="wallet-address"><span>Public address</span><strong>{walletStatus.address?.slice(0, 9)}…{walletStatus.address?.slice(-8)}</strong><button onClick={() => navigator.clipboard?.writeText(walletStatus.address ?? "")}><Copy size={14} /></button></div>
              <div className="wallet-balance-grid">
                <div><span>Portfolio estimate</span><strong>{walletPortfolio?.estimatedTotalValueUsd != null ? formatMoney(walletPortfolio.estimatedTotalValueUsd, 2) : "—"}</strong></div>
                <div><span>Native SOL</span><strong>{walletPortfolio?.solBalance?.toFixed(5) ?? "—"}</strong></div>
                <div><span>After 0.02 SOL reserve</span><strong>{walletPortfolio?.availableAfterGasUsd != null ? formatMoney(walletPortfolio.availableAfterGasUsd, 2) : "—"}</strong></div>
              </div>
              <div className="wallet-actions"><button onClick={onRefreshWallet} disabled={walletBusy}><RefreshCw size={14} className={walletBusy ? "spin" : ""} />Refresh</button><button className="danger-quiet" onClick={onForgetWallet}><Trash2 size={14} />Forget locally</button></div>
              {walletPortfolio?.warning && <p className="settings-warning"><AlertTriangle size={14} />{walletPortfolio.warning}</p>}
            </>
          ) : showImport ? (
            <div className="wallet-import">
              <div className="security-note"><ShieldCheck size={18} /><div><strong>Import only an isolated hot wallet</strong><span>Never paste your main savings-wallet key. PulseForge will have signing access while you are logged in to Windows.</span></div></div>
              <p className="native-import-copy">PulseForge opens a native picker for a Solana CLI JSON keypair or a text file containing one base58 keypair. File contents never enter the WebView.</p>
              <div className="wallet-actions"><button className="primary-small" disabled={walletBusy} onClick={importSecret}><KeyRound size={14} />Choose keypair file</button><button onClick={() => setShowImport(false)}>Cancel</button></div>
              {walletError && <p className="settings-error"><X size={14} />{walletError}</p>}
            </div>
          ) : (
            <div className="empty-wallet"><KeyRound size={27} /><div><strong>No signing wallet imported</strong><span>Market scanning and paper trading work without one.</span></div><button className="primary-small" onClick={() => setShowImport(true)}>Import isolated wallet</button></div>
          )}
        </section>

        <section className="settings-section provider-section">
          <div className="settings-title"><div><CloudCog size={19} /><h2>Data & execution providers</h2></div></div>
          <div className="provider-row"><span><i className={runtime.jupiterConfigured ? "provider-ok" : ""} />Jupiter API</span><strong>{runtime.jupiterConfigured ? "Configured" : "JUPITER_API_KEY missing"}</strong></div>
          <div className="provider-row"><span><i className={runtime.heliusConfigured ? "provider-ok" : ""} />Helius RPC</span><strong>{runtime.heliusConfigured ? "Configured" : "HELIUS_API_KEY missing"}</strong></div>
          <div className="provider-row"><span><i className={runtime.laserstreamConfigured ? "provider-ok" : ""} />LaserStream</span><strong>{runtime.laserstreamConfigured ? "Configured" : "Endpoint missing"}</strong></div>
          <p className="provider-help">Set secrets in Windows user environment variables, then restart PulseForge. Do not place them in <code>.env</code> beside the executable.</p>
        </section>

        <section className="settings-section execution-section live-canary-settings">
          <div className="settings-title">
            <div><LockKeyhole size={19} /><h2>Manual live canary</h2></div>
            <span className={`status-tag ${liveCanaryStatus?.armed ? "status-tag--danger" : liveCanaryStatus?.available ? "status-tag--warning" : ""}`}>
              {liveCanaryStatus?.armed ? "ARMED" : liveCanaryStatus?.available ? "DISARMED" : "BLOCKED"}
            </span>
          </div>
          <p>This is a separate, manual-only execution path. It never follows paper automation: each real swap requires a fresh Jupiter route, a short-lived preview, and its exact confirmation phrase.</p>
          <dl>
            <div><dt>Per buy</dt><dd>${liveCanaryStatus?.maxOrderUsd.toFixed(2) ?? "10.00"} hard max</dd></div>
            <div><dt>UTC buy cap</dt><dd>${liveCanaryStatus?.dailyBuyUsedUsd.toFixed(2) ?? "0.00"} / ${liveCanaryStatus?.dailyBuyCapUsd.toFixed(2) ?? "25.00"}</dd></div>
            <div><dt>Route limits</dt><dd>{liveCanaryStatus?.maxPriceImpactPct ?? 1}% impact · {liveCanaryStatus?.maxSlippageBps ?? 100} bps</dd></div>
            <div><dt>Cooldown</dt><dd>{liveCanaryStatus?.cooldownRemainingSeconds ? `${liveCanaryStatus.cooldownRemainingSeconds}s remaining` : `${liveCanaryStatus?.cooldownSeconds ?? 60}s after success`}</dd></div>
            <div><dt>Live automation</dt><dd>Separate Live wallet session</dd></div>
            <div><dt>Session reset</dt><dd>Disarms on app restart</dd></div>
          </dl>
          {liveCanaryStatus?.blocker && <p className="settings-error"><X size={14} />{liveCanaryStatus.blocker}</p>}
          {liveCanaryStatus?.armed ? (
            <div className="live-arm-row">
              <div><strong>Real signing is enabled for manual previews</strong><span>Use the selected token’s Market inspector to preview a buy or wallet-token sale.</span></div>
              <button className="danger-quiet" disabled={liveCanaryBusy} onClick={() => onDisarmLiveCanary?.()}>Disarm now</button>
            </div>
          ) : (
            <div className="live-arm-form">
              <label htmlFor="live-arm-ack">To arm this session, type exactly:</label>
              <code>{liveCanaryStatus?.acknowledgementPhrase ?? "I UNDERSTAND LIVE TRADES USE REAL FUNDS"}</code>
              <div>
                <input
                  id="live-arm-ack"
                  value={liveAcknowledgement}
                  onChange={(event) => setLiveAcknowledgement(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!liveCanaryStatus?.available || liveCanaryBusy}
                />
                <button
                  className="live-arm-button"
                  disabled={!liveCanaryStatus?.available || liveCanaryBusy || liveAcknowledgement !== liveCanaryStatus.acknowledgementPhrase}
                  onClick={armManualLive}
                >Arm manual live</button>
              </div>
              {liveError && <p className="settings-error"><X size={14} />{liveError}</p>}
            </div>
          )}
          {(liveCanaryStatus?.recentTrades.length ?? 0) > 0 && (
            <div className="live-journal">
              <strong>Local live journal</strong>
              {liveCanaryStatus?.recentTrades.slice(0, 5).map((trade) => (
                <div key={trade.id}>
                  <span>{new Date(trade.createdAt).toLocaleString("en-GB")} · {trade.side} {trade.symbol}</span>
                  <em className={trade.status === "Success" ? "text-positive" : "text-danger"}>{trade.status}</em>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
