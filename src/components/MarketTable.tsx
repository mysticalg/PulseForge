import { Columns3, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { useListKeyboardNavigation } from "../hooks/useListKeyboardNavigation";
import { DEFAULT_PAPER_AUTOMATION_SETTINGS, launchFlowSettingsForBudget, pumpScalpSettingsForBudget, type PaperAutomationSettings } from "../lib/automationSettings";
import { createPaperEngineState, type PaperEngineConfig } from "../lib/paperEngine";
import { paperConfig } from "../lib/paperRuntime";
import { compareNullableNumber, compareText, directedComparison, nextSortState, type SortState } from "../lib/sorting";
import { comparePaperOpportunity, estimateQuote, formatAge, formatCompact, formatPrice } from "../lib/strategy";
import type { MarketToken } from "../types";
import { SortHeader, SortReset } from "./SortControls";
import { TokenIdentity } from "./TokenIdentity";

interface Props {
  tokens: MarketToken[];
  selectedMint: string;
  onSelect: (token: MarketToken) => void;
  maxPriceImpactPct?: number;
  minLiquidityUsd?: number;
  settings?: PaperAutomationSettings;
}

export function MarketTable({ tokens, selectedMint, onSelect, maxPriceImpactPct = 0.75, minLiquidityUsd = 50_000, settings = DEFAULT_PAPER_AUTOMATION_SETTINGS }: Props) {
  const [search, setSearch] = useState("");
  const [hideHighRisk, setHideHighRisk] = useState(false);
  const [filter, setFilter] = useState<MarketFilter>("all");
  const [sort, setSort] = useState<SortState<MarketSortKey> | null>(null);
  const watchProfiles = useMemo(() => {
    const previewState = createPaperEngineState(Math.max(5, settings.portfolioBudgetUsd), 0);
    return {
      pump: paperConfig(settings.strategyId === "pump-scalp" ? settings : pumpScalpSettingsForBudget(settings.portfolioBudgetUsd), previewState),
      launch: paperConfig(settings.strategyId === "launch-flow" ? settings : launchFlowSettingsForBudget(settings.portfolioBudgetUsd), previewState),
    };
  }, [settings]);

  const searched = useMemo(() => {
    const term = search.trim().toLowerCase();
    return tokens.filter((token) => {
      if (hideHighRisk && token.riskLevel === "High") return false;
      return !term || token.symbol.toLowerCase().includes(term) || token.name.toLowerCase().includes(term) || token.mint.toLowerCase().includes(term);
    });
  }, [hideHighRisk, search, tokens]);
  const filterCounts = {
    all: searched.length,
    new: searched.filter((token) => isNewCandidate(token, settings)).length,
    pump: searched.filter((token) => isWatchCandidate(token, watchProfiles.pump)).length,
    launch: searched.filter((token) => isWatchCandidate(token, watchProfiles.launch)).length,
  };
  const visible = useMemo(() => {
    const rows = searched.filter((token) => filter === "all"
      || (filter === "new" ? isNewCandidate(token, settings) : isWatchCandidate(token, watchProfiles[filter])));
    return [...rows].sort((a, b) => {
      if (sort === null) return comparePaperOpportunity(a, b);
      if (sort.key === "pump") {
        return Number(isWatchCandidate(b, watchProfiles.pump)) - Number(isWatchCandidate(a, watchProfiles.pump))
          || b.change5mPct - a.change5mPct
          || (b.volume5mUsd / Math.max(1, b.liquidityUsd)) - (a.volume5mUsd / Math.max(1, a.liquidityUsd));
      }
      let comparison = 0;
      if (sort.key === "token") comparison = compareText(a.symbol, b.symbol);
      if (sort.key === "age") comparison = a.ageSeconds - b.ageSeconds;
      if (sort.key === "price") comparison = a.priceUsd - b.priceUsd;
      if (sort.key === "marketCap") comparison = compareNullableNumber(a.marketCapUsd ?? null, b.marketCapUsd ?? null);
      if (sort.key === "momentum") comparison = a.change5mPct - b.change5mPct;
      if (sort.key === "liquidity") comparison = a.liquidityUsd - b.liquidityUsd;
      if (sort.key === "volume") comparison = a.volume5mUsd - b.volume5mUsd;
      if (sort.key === "flow") comparison = a.buyRatio - b.buyRatio;
      if (sort.key === "risk") comparison = RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel];
      if (sort.key === "model") comparison = a.modelScore - b.modelScore;
      return directedComparison(comparison, sort.direction) || compareText(a.mint, b.mint);
    });
  }, [filter, searched, settings, sort, watchProfiles]);
  const visibleMints = useMemo(() => visible.map((token) => token.mint), [visible]);
  const keyboardNavigation = useListKeyboardNavigation({
    keys: visibleMints,
    activeKey: selectedMint,
    onActivate: (mint) => {
      const token = visible.find((candidate) => candidate.mint === mint);
      if (token) onSelect(token);
    },
    global: true,
  });
  const eligibleCount = visible.filter((token) => estimateQuote(token, 25, maxPriceImpactPct, minLiquidityUsd).canPaperTrade).length;

  return (
    <section className="market-scanner" aria-label="Market scanner">
      <div className="section-toolbar">
        <div className="section-title">
          <h1>Market scanner</h1>
          <span>{visible.length} candidates · {eligibleCount} quote checks pass @ $25</span>
        </div>
        <label className="search-control">
          <Search size={16} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search token / mint" aria-label="Search token or mint" />
        </label>
        <button className={`toolbar-button ${hideHighRisk ? "is-active" : ""}`} onClick={() => setHideHighRisk((value) => !value)}>
          <SlidersHorizontal size={15} />
          <span>Hide high risk</span>
        </button>
        <button
          className={`toolbar-button ${sort?.key === "pump" ? "is-active" : ""}`}
          onClick={() => setSort(sort?.key === "pump" ? null : { key: "pump", direction: "desc" })}
          title="Toggle pump-first sorting"
          aria-pressed={sort?.key === "pump"}
        >
          <Columns3 size={15} />
          <span>{sort?.key === "pump" ? "Pump first" : "Pump sort"}</span>
        </button>
        <SortReset active={sort !== null} onReset={() => setSort(null)} />
      </div>
      <div className="scanner-filters" aria-label="Candidate watch filters">
        {MARKET_FILTERS.map((option) => (
          <button key={option.key} type="button" aria-pressed={filter === option.key} className={filter === option.key ? "is-active" : ""} onClick={() => setFilter(option.key)}>
            {option.label} <span>{filterCounts[option.key]}</span>
          </button>
        ))}
        <span className="scanner-filter-note" title="Watch filters use age, momentum and activity thresholds. Entry eligibility also requires safety, short-window evidence and portfolio checks.">
          {filter === "new" ? `Pool age ≤ ${settings.maxTokenAgeMinutes}m` : filter === "pump" || filter === "launch" ? `${watchProfiles[filter].minTokenAgeSeconds / 60}–${watchProfiles[filter].maxTokenAgeSeconds / 60}m · ${settings.strategyId === (filter === "pump" ? "pump-scalp" : "launch-flow") ? "your settings" : "preset thresholds"}` : "Watch filters · entry checks apply"}
        </span>
      </div>
      <div className="table-scroll">
        <table className="market-table">
          <thead>
            <tr>
              <th className="rank-cell" aria-sort={sort === null ? "ascending" : undefined}><SortHeader label="#" active={sort === null} direction="asc" onSort={() => setSort(null)} /></th>
              <th aria-sort={ariaSort(sort, "token")}><SortHeader label="Token" active={sort?.key === "token"} direction={sort?.direction ?? "asc"} onSort={() => setSort(nextSortState(sort, "token"))} /></th>
              <th aria-sort={ariaSort(sort, "age")}><SortHeader label="Age" active={sort?.key === "age"} direction={sort?.direction ?? "asc"} onSort={() => setSort(nextSortState(sort, "age"))} /></th>
              <th aria-sort={ariaSort(sort, "price")}><SortHeader label="Price (USD)" active={sort?.key === "price"} direction={sort?.direction ?? "desc"} onSort={() => setSort(nextSortState(sort, "price", "desc"))} /></th>
              <th aria-sort={ariaSort(sort, "marketCap")}><SortHeader label="Market cap" active={sort?.key === "marketCap"} direction={sort?.direction ?? "desc"} onSort={() => setSort(nextSortState(sort, "marketCap", "desc"))} /></th>
              <th aria-sort={ariaSort(sort, "momentum")}><SortHeader label="5m %" active={sort?.key === "momentum"} direction={sort?.direction ?? "desc"} onSort={() => setSort(nextSortState(sort, "momentum", "desc"))} /></th>
              <th aria-sort={ariaSort(sort, "liquidity")}><SortHeader label="Liquidity" active={sort?.key === "liquidity"} direction={sort?.direction ?? "desc"} onSort={() => setSort(nextSortState(sort, "liquidity", "desc"))} /></th>
              <th aria-sort={ariaSort(sort, "volume")}><SortHeader label="Volume 5m" active={sort?.key === "volume"} direction={sort?.direction ?? "desc"} onSort={() => setSort(nextSortState(sort, "volume", "desc"))} /></th>
              <th aria-sort={ariaSort(sort, "flow")}><SortHeader label="Buy / Sell" active={sort?.key === "flow"} direction={sort?.direction ?? "desc"} onSort={() => setSort(nextSortState(sort, "flow", "desc"))} /></th>
              <th aria-sort={ariaSort(sort, "risk")}><SortHeader label="Risk" active={sort?.key === "risk"} direction={sort?.direction ?? "asc"} onSort={() => setSort(nextSortState(sort, "risk"))} /></th>
              <th aria-sort={ariaSort(sort, "model")}><SortHeader label="Model" active={sort?.key === "model"} direction={sort?.direction ?? "desc"} onSort={() => setSort(nextSortState(sort, "model", "desc"))} /></th>
              <th className="action-cell">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((token, index) => {
              const keyboard = keyboardNavigation.rowProps(token.mint);
              return <tr
                key={token.mint}
                ref={keyboard.ref}
                className={token.mint === selectedMint ? "is-selected" : ""}
                onClick={() => onSelect(token)}
                tabIndex={keyboard.tabIndex}
                onKeyDown={(event) => {
                  keyboard.onKeyDown(event);
                  if (!event.defaultPrevented && (event.key === "Enter" || event.key === " ")) onSelect(token);
                }}
              >
                <td className="rank-cell">{index + 1}</td>
                <td>
                  <div className="token-cell"><TokenIdentity symbol={token.symbol} name={token.name} mint={token.mint} iconUrl={token.iconUrl} compact /></div>
                </td>
                <td>{formatAge(token.ageSeconds)}</td>
                <td className="mono">{formatPrice(token.priceUsd)}</td>
                <td title={token.marketCapUsd == null ? "Market cap not reported by the provider" : `Provider-reported market cap: $${token.marketCapUsd.toLocaleString()}`}>
                  {token.marketCapUsd == null ? "—" : `$${formatCompact(token.marketCapUsd)}`}
                </td>
                <td className={token.change5mPct >= 0 ? "text-positive" : "text-danger"}>
                  {token.change5mPct >= 0 ? "+" : ""}{token.change5mPct.toFixed(2)}%
                </td>
                <td>${formatCompact(token.liquidityUsd)}</td>
                <td>${formatCompact(token.volume5mUsd)}</td>
                <td>
                  <div className="flow-cell">
                    <div className="flow-bar"><i style={{ width: `${token.buyRatio * 100}%` }} /></div>
                    <span className="text-positive">{Math.round(token.buyRatio * 100)}%</span>
                    <span>/</span>
                    <span className="text-danger">{Math.round((1 - token.buyRatio) * 100)}%</span>
                  </div>
                </td>
                <td><span className={`risk-label risk-${token.riskLevel.toLowerCase().replace("-", "")}`}><i />{token.riskLevel}</span></td>
                <td className={token.modelScore >= 0.6 ? "text-positive" : token.modelScore < 0.45 ? "text-danger" : "text-amber"}>
                  <strong>{token.modelScore.toFixed(2)}</strong>
                </td>
                <td className="action-cell"><button className="row-action" onClick={(event) => { event.stopPropagation(); onSelect(token); }} aria-label={`Inspect ${token.symbol}`}>›</button></td>
              </tr>;
            })}
          </tbody>
        </table>
        {visible.length === 0 && <div className="empty-row">No candidates match the current filters.</div>}
      </div>
    </section>
  );
}

type MarketSortKey = "pump" | "token" | "age" | "price" | "marketCap" | "momentum" | "liquidity" | "volume" | "flow" | "risk" | "model";

const RISK_ORDER: Record<MarketToken["riskLevel"], number> = { Low: 0, Medium: 1, "Med-High": 2, High: 3 };

function ariaSort(sort: SortState<MarketSortKey> | null, key: MarketSortKey) {
  return sort?.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
}

type MarketFilter = "all" | "new" | "pump" | "launch";

const MARKET_FILTERS: readonly { key: MarketFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "pump", label: "Pump" },
  { key: "launch", label: "Launch" },
];

function isNewCandidate(token: MarketToken, settings: PaperAutomationSettings): boolean {
  return Number.isFinite(token.ageSeconds) && token.ageSeconds > 0 && token.ageSeconds <= settings.maxTokenAgeMinutes * 60;
}

function isWatchCandidate(token: MarketToken, config: PaperEngineConfig): boolean {
  return token.ageSeconds >= config.minTokenAgeSeconds
    && token.ageSeconds <= config.maxTokenAgeSeconds
    && token.change5mPct >= config.minMomentum5mPct
    && token.change5mPct <= config.maxMomentum5mPct
    && token.liquidityUsd >= config.minLiquidityUsd
    && token.volume5mUsd >= config.minVolume5mUsd
    && token.volume5mUsd / Math.max(1, token.liquidityUsd) >= config.minVolumeToLiquidity
    && token.buyRatio >= config.minBuyRatio
    && token.buyRatio <= config.maxBuyRatio
    && token.buys5m >= config.minBuys5m
    && token.sells5m >= config.minSells5m
    && token.buys5m + token.sells5m >= config.minTrades5m
    && token.traders5m >= config.minTraders5m
    && token.organicBuyers5m >= config.minOrganicBuyers5m;
}
