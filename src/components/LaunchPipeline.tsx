import { Activity, ArrowRight, Radar, Rocket, Settings2, ShieldCheck } from "lucide-react";
import type { PaperAutomationSettings } from "../lib/automationSettings";
import { evaluatePaperEntry, type PaperEngineState, type PaperMarketObservation } from "../lib/paperEngine";
import { paperConfig } from "../lib/paperRuntime";
import type { FeedMode } from "../types";

interface LaunchPipelineProps {
  observations: readonly PaperMarketObservation[];
  settings: PaperAutomationSettings;
  state: PaperEngineState;
  nowMs: number;
  mode: FeedMode;
  killSwitch: boolean;
  feedWaiting?: boolean;
  onOpenSettings: () => void;
}

// Categorize the engine's reported blockers; the engine owns all gate thresholds.
const SAFETY_BLOCKER = /^(Price is|Observation is|Liquidity is|Risk |Audit |Mint authority|Freeze authority|Liquidity lock|Token is not verified|Top-holder|Transfer tax|Entry impact)/;

export function LaunchPipeline({ observations, settings, state, nowMs, mode, killSwitch, feedWaiting = false, onOpenSettings }: LaunchPipelineProps) {
  const config = paperConfig(settings, state);
  const candidates = observations.filter((observation) => Number.isFinite(observation.ageSeconds)
    && observation.ageSeconds > 0 && observation.ageSeconds <= config.maxTokenAgeSeconds);
  const evaluations = candidates.map((observation) => ({
    observation,
    entry: evaluatePaperEntry(state, observation, nowMs, config),
  }));
  const safetyBlocked = evaluations.filter(({ entry }) => entry.blockers.some((blocker) => SAFETY_BLOCKER.test(blocker))).length;
  const warming = evaluations.filter(({ observation, entry }) => entry.blockers.some((blocker) => blocker.includes("warming up")
    || blocker === "Launch pattern is still forming"
    || (blocker.startsWith("Pool age") && observation.ageSeconds < config.minTokenAgeSeconds))).length;
  const ready = evaluations.filter(({ entry }) => entry.eligible).length;
  const patterns = candidates.filter((observation) => observation.launchPattern === "breakout" || observation.launchPattern === "pullback-reclaim").length;
  const blockerCounts = new Map<string, number>();
  for (const { entry } of evaluations) {
    for (const blocker of entry.blockers) blockerCounts.set(blocker, (blockerCounts.get(blocker) ?? 0) + 1);
  }
  const commonBlockers = [...blockerCounts.entries()].sort((a, b) => b[1] - a[1]);
  const leadingSafetyBlocker = commonBlockers.find(([blocker]) => SAFETY_BLOCKER.test(blocker));
  const blockedDetails = commonBlockers.map(([blocker, count]) => `${count}: ${blocker}`).join("\n");
  const displayedBlockers = commonBlockers
    .filter(([blocker]) => blocker !== "Audit eligibility is not confirmed")
    .slice(0, 3);
  const unverifiedFees = candidates.filter((observation) => observation.safety.transferTaxUnknown).length;
  const strategyName = settings.strategyId === "launch-flow" ? settings.takeProfitPct === 0 ? "Launch runner" : "High-risk launch scout" : settings.strategyId === "pump-scalp" ? "Pump scalp" : "Conservative";
  const dailyStopped = state.dailyLossLockedDay === new Date(nowMs).toISOString().slice(0, 10);
  const active = settings.enabled && !killSwitch && !dailyStopped && !feedWaiting;
  const status = feedWaiting ? "Waiting for live feed" : killSwitch ? "Paper stopped" : !settings.enabled ? "Paper paused" : dailyStopped ? "Paper daily stop" : "Paper active";
  const shortExitRules = [
    Number.isFinite(config.exitShortMomentumBelowPct) ? `Price ≤ ${config.exitShortMomentumBelowPct}%` : null,
    Number.isFinite(config.exitShortVolumeGrowthBelowPct) ? `volume ≤ ${config.exitShortVolumeGrowthBelowPct}%` : null,
  ].filter(Boolean).join(" · ");

  return (
    <section className="launch-pipeline" aria-label="Launch scanning and paper automation workflow">
      <div className="launch-pipeline-header">
        <strong>{strategyName}</strong>
        <span className={active ? "text-positive" : "text-amber"}>{status}</span>
        <span>{mode === "demo" ? "Demo feed" : "Live feed"} · simulated orders</span>
        <button type="button" onClick={onOpenSettings}><Settings2 size={12} /> Configure rules</button>
      </div>
      <ol className="launch-pipeline-stages">
        <li>
          <div className="launch-stage-label"><Radar size={14} /><span>1. Scan launches</span><ArrowRight size={12} /></div>
          <strong>{candidates.length} <span>new candidate{candidates.length === 1 ? "" : "s"}</span></strong>
          <small>Pool age ≤ {settings.maxTokenAgeMinutes}m · {observations.length} in feed</small>
        </li>
        <li>
          <div className="launch-stage-label"><ShieldCheck size={14} /><span>2. Safety checks</span><ArrowRight size={12} /></div>
          <strong className={safetyBlocked > 0 ? "text-amber" : ""}>{safetyBlocked} <span>safety blocked</span></strong>
          <small title={leadingSafetyBlocker?.[0]}>{leadingSafetyBlocker ? leadingSafetyBlocker[0] : "Audit, authority, holders & impact gates"}</small>
        </li>
        <li title={blockedDetails || (candidates.length > 0 ? "All current candidates pass the configured paper entry rules." : "No candidates are inside the configured pool-age window.")}>
          <div className="launch-stage-label"><Rocket size={14} /><span>3. Early entry</span><ArrowRight size={12} /></div>
          <strong className={ready > 0 ? "text-positive" : ""}>{ready} <span>rule-ready · {warming} warming</span></strong>
          <small>{settings.strategyId === "launch-flow" ? `${patterns} patterns · ` : ""}age ≥ {settings.minTokenAgeMinutes}m · ${config.entryNotionalUsd.toFixed(2)} cap</small>
        </li>
        <li>
          <div className="launch-stage-label"><Activity size={14} /><span>4. Momentum exits</span></div>
          <strong>{state.positions.length} <span>open · {feedWaiting ? "exits waiting for live marks" : active ? "monitoring" : killSwitch || (settings.enabled && dailyStopped) ? "exit pending" : "exits paused"}</span></strong>
          <small title="Short-window exits require fresh quotes and a measured observation window. Stops, liquidity loss and maximum hold also apply while automation runs.">{shortExitRules || `Short exits off · ${settings.maxHoldMinutes}m hold limit`}</small>
        </li>
      </ol>
      {settings.enabled && ready === 0 && candidates.length > 0 && (
        <details className="launch-entry-diagnostics">
          <summary>No entry yet: {displayedBlockers.map(([blocker, count]) => `${count} ${blocker}`).join(" · ")}</summary>
          {unverifiedFees > 0 && <p>{unverifiedFees} token{unverifiedFees === 1 ? " needs" : "s need"} verified mint fee data. Unverified tokens remain blocked.</p>}
          <p>Automatic order size adjusts to the impact limit, up to your allocation cap. A candidate must pass every entry rule.</p>
          <ul>{commonBlockers.map(([blocker, count]) => <li key={blocker}>{count} candidate{count === 1 ? "" : "s"}: {blocker}</li>)}</ul>
          {settings.strategyId === "launch-flow" && settings.takeProfitPct === 0 && (
            <ul>{evaluations.slice(0, 5).map(({ observation }) => <li key={observation.mint}>{observation.symbol}: {observation.launchPatternDetail}</li>)}</ul>
          )}
        </details>
      )}
    </section>
  );
}
