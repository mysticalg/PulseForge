import { Bot, Flame, LockKeyhole, Rocket, RotateCcw, ShieldAlert, ShieldCheck, TrendingUp } from "lucide-react";
import {
  conservativeSettingsForBudget,
  DEFAULT_PAPER_AUTOMATION_SETTINGS,
  launchFlowSettingsForBudget,
  launchRunnerSettingsForBudget,
  pumpScalpSettingsForBudget,
  type PaperAutomationSettings,
} from "../lib/automationSettings";

export { DEFAULT_PAPER_AUTOMATION_SETTINGS };
export type { PaperAutomationSettings };

type NumericSettingKey = Exclude<
  keyof PaperAutomationSettings,
  "enabled" | "strategyId" | "allowHighRiskPaperEntries"
>;

interface FieldDefinition {
  key: NumericSettingKey;
  label: string;
  hint: string;
  suffix: string;
  min: number;
  max: number;
  step: number;
}

interface FieldGroup {
  title: string;
  description: string;
  fields: readonly FieldDefinition[];
}

const FIELD_GROUPS: readonly FieldGroup[] = [
  {
    title: "Capital",
    description: "Bound paper exposure before evaluating a candidate.",
    fields: [
      { key: "portfolioBudgetUsd", label: "Portfolio budget", hint: "Maximum paper capital in scope", suffix: "USD", min: 0, max: 1_000_000, step: 100 },
      { key: "maxOpenPositions", label: "Maximum open positions", hint: "Portfolio-wide simultaneous position cap", suffix: "positions", min: 1, max: 25, step: 1 },
      { key: "maxAllocationPerTokenPct", label: "Max allocation / token", hint: "Share of budget per mint", suffix: "%", min: 0.1, max: 100, step: 0.1 },
      { key: "reserveUsd", label: "Cash reserve", hint: "Held back from manual + automatic buys", suffix: "USD", min: 0, max: 1_000_000, step: 25 },
    ],
  },
  {
    title: "Exit rules",
    description: "Configure momentum breaks, profit protection and time limits while paper automation runs.",
    fields: [
      { key: "takeProfitPct", label: "Take profit", hint: "Close after gain from entry; 0 disables", suffix: "%", min: 0, max: 1_000, step: 0.1 },
      { key: "stopLossPct", label: "Stop loss", hint: "Close after loss from entry", suffix: "%", min: 0, max: 100, step: 0.1 },
      { key: "trailingStopPct", label: "Trailing stop", hint: "Trail from highest paper mark", suffix: "%", min: 0, max: 100, step: 0.1 },
      { key: "maxHoldMinutes", label: "Maximum hold", hint: "Time-based exit", suffix: "min", min: 0.25, max: 43_200, step: 0.25 },
      { key: "exitShortMomentumBelowPct", label: "Exit below short momentum", hint: "Observed ~30s price change; −100 disables", suffix: "%", min: -100, max: 0, step: 0.1 },
      { key: "exitShortVolumeGrowthBelowPct", label: "Exit below short volume growth", hint: "~30s change in rolling 5m volume; −100 disables", suffix: "%", min: -100, max: 0, step: 0.5 },
      { key: "momentumBreakCooldownMinutes", label: "Momentum-break cooldown", hint: "Wait before re-entering after reversal or volume fade", suffix: "min", min: 0, max: 10_080, step: 1 },
      { key: "exitBuyRatioBelow", label: "Exit below buy ratio", hint: "0.43 means 43%; 0 disables this exit", suffix: "ratio", min: 0, max: 1, step: 0.01 },
      { key: "buyRatioDeteriorationCooldownMinutes", label: "Buy-ratio exit cooldown", hint: "Wait before re-entering that mint", suffix: "min", min: 0, max: 10_080, step: 1 },
      { key: "exitLiquidityDrawdownPct", label: "Exit after liquidity loss", hint: "Percent below entry liquidity; 0 disables", suffix: "%", min: 0, max: 100, step: 1 },
      { key: "liquidityDrawdownCooldownMinutes", label: "Liquidity-exit cooldown", hint: "Wait before re-entering that mint", suffix: "min", min: 0, max: 10_080, step: 1 },
    ],
  },
  {
    title: "Momentum setup",
    description: "Momentum entries must pass the upstream 5m move and locally observed short-window evidence.",
    fields: [
      { key: "minTokenAgeMinutes", label: "Minimum pool age", hint: "Wait for initial safety and flow evidence", suffix: "min", min: 0, max: 43_200, step: 1 },
      { key: "maxTokenAgeMinutes", label: "Maximum pool age", hint: "Ignore older established pools", suffix: "min", min: 0.25, max: 43_200, step: 1 },
      { key: "minMomentum5mPct", label: "Minimum 5m momentum", hint: "Require an active upstream move", suffix: "%", min: -100, max: 1_000, step: 0.5 },
      { key: "maxMomentum5mPct", label: "Maximum 5m momentum", hint: "Avoid extremely extended entries", suffix: "%", min: -100, max: 1_000, step: 0.5 },
      { key: "minShortMomentumPct", label: "Minimum short momentum", hint: "Continuation over roughly 30 seconds", suffix: "%", min: -100, max: 1_000, step: 0.1 },
      { key: "maxShortMomentumPct", label: "Maximum short momentum", hint: "Reject a late vertical spike", suffix: "%", min: -100, max: 1_000, step: 0.1 },
      { key: "minShortVolumeGrowthPct", label: "Minimum short volume growth", hint: "30s increase in rolling 5m volume", suffix: "%", min: -100, max: 1_000, step: 0.5 },
      { key: "minVolumeToLiquidity", label: "Minimum turnover", hint: "5m volume divided by liquidity", suffix: "ratio", min: 0, max: 1_000, step: 0.1 },
    ],
  },
  {
    title: "Entry gates",
    description: "Every threshold must pass; elevated risk requires the explicit paper-only opt-in above.",
    fields: [
      { key: "minModelScore", label: "Minimum model score", hint: "Raw ranking threshold; not probability", suffix: "score", min: 0, max: 1, step: 0.01 },
      { key: "minBuyRatio", label: "Minimum buy ratio", hint: "Recent buy share", suffix: "ratio", min: 0, max: 1, step: 0.01 },
      { key: "maxBuyRatio", label: "Maximum buy ratio", hint: "Reject one-sided or synthetic 100% flow", suffix: "ratio", min: 0, max: 1, step: 0.01 },
      { key: "minLiquidityUsd", label: "Minimum liquidity", hint: "Observed pool liquidity", suffix: "USD", min: 0, max: 100_000_000, step: 1_000 },
      { key: "minVolume5mUsd", label: "Minimum 5m volume", hint: "Recent traded notional", suffix: "USD", min: 0, max: 100_000_000, step: 1_000 },
      { key: "minTraders5m", label: "Minimum 5m traders", hint: "Distinct recent traders", suffix: "traders", min: 0, max: 1_000_000, step: 1 },
      { key: "minOrganicBuyers5m", label: "Minimum organic buyers", hint: "Jupiter organic buyers in 5m", suffix: "buyers", min: 0, max: 1_000_000, step: 1 },
    ],
  },
  {
    title: "Circuit breakers",
    description: "Stop new entries when execution or session risk exceeds a limit.",
    fields: [
      { key: "maxPriceImpactPct", label: "Maximum price impact", hint: "Fresh paper quote threshold", suffix: "%", min: 0, max: 100, step: 0.05 },
      { key: "dailyLossLimitUsd", label: "Daily loss limit", hint: "Pause entries at realized + marked loss", suffix: "USD", min: 0, max: 1_000_000, step: 25 },
      { key: "cooldownMinutes", label: "Cooldown after exit", hint: "Wait before re-entering the mint", suffix: "min", min: 0, max: 10_080, step: 1 },
    ],
  },
];

export interface AutomationPanelProps {
  settings: PaperAutomationSettings;
  onChange: (settings: PaperAutomationSettings) => void;
  currentPaperCapitalUsd?: number;
  automationStatus?: string;
  onResetPaperAccount?: () => void;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function AutomationNumberField({
  definition,
  value,
  onChange,
}: {
  definition: FieldDefinition;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="automation-field">
      <span className="automation-field-copy">
        <strong>{definition.label}</strong>
        <small>{definition.hint}</small>
      </span>
      <span className="automation-input-wrap">
        <input
          type="number"
          min={definition.min}
          max={definition.max}
          step={definition.step}
          value={value}
          onChange={(event) => onChange(clamp(event.currentTarget.valueAsNumber, definition.min, definition.max))}
        />
        <i>{definition.suffix}</i>
      </span>
    </label>
  );
}

export function AutomationPanel({ settings, onChange, currentPaperCapitalUsd, automationStatus, onResetPaperAccount }: AutomationPanelProps) {
  const isRunner = settings.strategyId === "launch-flow" && settings.takeProfitPct === 0;
  const strategyName = isRunner ? "Launch runner" : settings.strategyId === "launch-flow"
    ? "High-risk launch scout"
    : settings.strategyId === "pump-scalp"
      ? "Pump scalp"
      : "Conservative";
  const preset = isRunner
    ? launchRunnerSettingsForBudget(settings.portfolioBudgetUsd, settings.enabled)
    : settings.strategyId === "launch-flow"
    ? launchFlowSettingsForBudget(settings.portfolioBudgetUsd, settings.enabled)
    : settings.strategyId === "pump-scalp"
      ? pumpScalpSettingsForBudget(settings.portfolioBudgetUsd, settings.enabled)
      : conservativeSettingsForBudget(settings.portfolioBudgetUsd, settings.enabled);
  const customizedFields = (Object.keys(settings) as Array<keyof PaperAutomationSettings>)
    .filter((key) => !["enabled", "strategyId", "portfolioBudgetUsd"].includes(key))
    .filter((key) => settings[key] !== preset[key]);
  const updateNumber = (key: NumericSettingKey, value: number) => {
    if (key === "maxOpenPositions") value = Math.round(value);
    const next = { ...settings, [key]: value };
    if (key === "minBuyRatio" && value > settings.maxBuyRatio) next.maxBuyRatio = value;
    if (key === "maxBuyRatio" && value < settings.minBuyRatio) next.minBuyRatio = value;
    if (key === "minTokenAgeMinutes" && value > settings.maxTokenAgeMinutes) next.maxTokenAgeMinutes = value;
    if (key === "maxTokenAgeMinutes" && value < settings.minTokenAgeMinutes) next.minTokenAgeMinutes = value;
    if (key === "minMomentum5mPct" && value > settings.maxMomentum5mPct) next.maxMomentum5mPct = value;
    if (key === "maxMomentum5mPct" && value < settings.minMomentum5mPct) next.minMomentum5mPct = value;
    if (key === "minShortMomentumPct" && value > settings.maxShortMomentumPct) next.maxShortMomentumPct = value;
    if (key === "maxShortMomentumPct" && value < settings.minShortMomentumPct) next.minShortMomentumPct = value;
    onChange(next);
  };

  return (
    <section className="settings-section automation-rules-section" aria-labelledby="paper-automation-title">
      <div className="automation-panel-header">
        <div className="settings-title">
          <div><Bot size={19} /><h2 id="paper-automation-title">Paper automation</h2></div>
          <span className={`status-tag ${settings.enabled && (automationStatus ?? "RUNNING") === "RUNNING" ? "status-tag--ok" : automationStatus && automationStatus !== "PAUSED" ? "status-tag--warning" : ""}`}>{automationStatus ?? (settings.enabled ? "RUNNING" : "PAUSED")}</span>
        </div>
        <div className="automation-mode-control">
          <div>
            <strong>{settings.enabled ? `${strategyName} paper entries enabled` : "Automatic paper entries paused"}</strong>
            <span>Rules affect simulated positions only and run while PulseForge is open and the PC is awake.</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Enable paper automation"
            className={`toggle-switch ${settings.enabled ? "is-on" : ""}`}
            onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
          >
            <span />
          </button>
        </div>
      </div>

      <div className="strategy-presets" aria-label="Paper strategy preset">
        <button
          type="button"
          className={settings.strategyId === "conservative" ? "is-active" : ""}
          onClick={() => onChange(conservativeSettingsForBudget(settings.portfolioBudgetUsd, false))}
        >
          <ShieldCheck size={17} />
          <span><strong>Conservative</strong><small>Deeper liquidity · 45m evidence policy</small></span>
        </button>
        <button
          type="button"
          className={settings.strategyId === "pump-scalp" ? "is-active strategy-preset--pump" : "strategy-preset--pump"}
          onClick={() => onChange(pumpScalpSettingsForBudget(settings.portfolioBudgetUsd, false))}
        >
          <Flame size={17} />
          <span><strong>Pump scalp</strong><small>30s continuation · configurable momentum exits</small></span>
        </button>
        <button
          type="button"
          className={settings.strategyId === "launch-flow" && !isRunner ? "is-active strategy-preset--launch" : "strategy-preset--launch"}
          onClick={() => onChange(launchFlowSettingsForBudget(settings.portfolioBudgetUsd, false))}
        >
          <Rocket size={17} />
          <span><strong>High-risk launch scout</strong><small>Young pools · safety gates · momentum exits</small></span>
        </button>
        <button
          type="button"
          className={isRunner ? "is-active strategy-preset--runner" : "strategy-preset--runner"}
          onClick={() => onChange(launchRunnerSettingsForBudget(settings.portfolioBudgetUsd, false))}
        >
          <TrendingUp size={17} />
          <span><strong>Launch runner</strong><small>No fixed target · follow momentum · paper only</small></span>
        </button>
      </div>

      {customizedFields.length > 0 && (
        <div className="strategy-customization-alert" role="status">
          <ShieldAlert size={18} />
          <div>
            <strong>Customized {strategyName} profile · {customizedFields.length} setting{customizedFields.length === 1 ? "" : "s"} differ</strong>
            <span>The strategy name does not guarantee the tested preset while its thresholds are edited. Click the {strategyName} card above to restore the evidence profile; applying it pauses automation.</span>
          </div>
        </div>
      )}

      <div className={`high-risk-entry-control ${settings.allowHighRiskPaperEntries ? "is-on" : ""}`}>
        <ShieldAlert size={18} />
        <div>
          <strong>Allow Med-High and High-risk paper entries</strong>
          <span>
            Clears only the risk-level and risk-eligibility vetoes for manual and automatic paper buys.
            Audit, authority, holder, liquidity, activity, price-impact, capital, and loss-limit gates still apply.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.allowHighRiskPaperEntries}
          aria-label="Allow high-risk paper entries"
          className={`toggle-switch ${settings.allowHighRiskPaperEntries ? "is-on" : ""}`}
          onClick={() => onChange({ ...settings, allowHighRiskPaperEntries: !settings.allowHighRiskPaperEntries })}
        >
          <span />
        </button>
      </div>

      <div className="automation-groups">
        {FIELD_GROUPS.filter((group) => group.title !== "Momentum setup" || settings.strategyId !== "conservative").map((group) => (
          <fieldset className="automation-group" key={group.title}>
            <legend>{group.title}</legend>
            <p>{group.description}</p>
            <div className="automation-fields">
              {group.fields.map((definition) => (
                <AutomationNumberField
                  key={definition.key}
                  definition={definition}
                  value={settings[definition.key]}
                  onChange={(value) => updateNumber(definition.key, value)}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      <div className={`strategy-profile-note ${settings.strategyId === "pump-scalp" ? "strategy-profile-note--pump" : settings.strategyId === "launch-flow" ? "strategy-profile-note--launch" : ""}`}>
        {settings.strategyId === "pump-scalp" ? <Flame size={16} /> : settings.strategyId === "launch-flow" ? <Rocket size={16} /> : <ShieldCheck size={16} />}
        <div>
          <strong>{strategyName} research profile</strong>
          <span>{isRunner
            ? `No fixed profit target; follow the move until momentum breaks. This paper research profile looks for an observed breakout or pullback reclaim, then applies safety, price/volume continuation and portfolio gates. Pattern detection uses transparent rules and has not been trained or validated as a prediction model. Exits use configurable momentum and volume thresholds, a ${settings.stopLossPct}% stop, a ${settings.trailingStopPct}% trailing stop, or the ${settings.maxHoldMinutes}-minute maximum hold. Applying a preset pauses automation.`
            : settings.strategyId === "launch-flow"
            ? `High-risk paper launch scout: requires at least ${settings.minTokenAgeMinutes} minutes of pool age, then ranks measured 30-second price/volume continuation and buy share. It requires observed sell activity and contract-audit checks, but treats early organic fields as ranking evidence instead of hard blockers. Exact 100% buy flow stays excluded because it can be a tiny or synthetic sample. Configurable momentum and volume exits work alongside profit lock, stops, and the ${settings.maxHoldMinutes}-minute clock. Applying a preset pauses automation.${settings.allowHighRiskPaperEntries ? " Elevated-risk paper entries are enabled." : " Elevated-risk classifications remain blocked until explicitly enabled above."}`
            : settings.strategyId === "pump-scalp"
              ? `Uses up to ${settings.maxOpenPositions} open paper positions, a ${settings.takeProfitPct}% profit target, ${settings.stopLossPct}% stop, ${settings.trailingStopPct}% trailing stop, and a ${settings.maxHoldMinutes}-minute maximum hold. Measured short momentum ranks entries; reversal and volume-fade thresholds are configurable above. Applying a preset pauses automation.`
              : `Uses up to ${settings.maxOpenPositions} open paper positions, ${settings.maxAllocationPerTokenPct}% allocation, a $${settings.reserveUsd} cash reserve, $${settings.dailyLossLimitUsd} daily loss limit, liquidity gates, and a ${settings.cooldownMinutes}-minute re-entry cooldown. Short momentum exits can be enabled above.`}</span>
        </div>
      </div>

      <div className="paper-reset-row">
        <div>
          <strong>Paper account capital</strong>
          <span>Current: ${(currentPaperCapitalUsd ?? settings.portfolioBudgetUsd).toLocaleString()} · Reset applies the configured ${settings.portfolioBudgetUsd.toLocaleString()} budget and clears paper history.</span>
        </div>
        <button type="button" onClick={onResetPaperAccount} disabled={!onResetPaperAccount}>
          <RotateCcw size={14} /> Reset paper account
        </button>
      </div>

      <div className="live-automation-lock">
        <LockKeyhole size={18} />
        <div>
          <strong>Real-wallet sessions have separate controls</strong>
          <span>Open Live wallet to review real-money limits and start a session. It captures these entry and exit rules when started; later rule edits apply to the next live session.</span>
        </div>
      </div>
      <p className="automation-disclaimer"><ShieldCheck size={14} />These are editable paper-risk assumptions, not a claim of a winning strategy. A configured profit target may rarely fill and does not imply an expected return.</p>
    </section>
  );
}
