import { AlertTriangle, CheckCircle2, DatabaseZap, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChartPanel } from "./components/ChartPanel";
import { DecisionInspector } from "./components/DecisionInspector";
import { MarketTable } from "./components/MarketTable";
import { LaunchPipeline } from "./components/LaunchPipeline";
import { LiveTradingPanel } from "./components/LiveTradingPanel";
import { NavRail } from "./components/NavRail";
import { TopBar } from "./components/TopBar";
import { WorkspaceView } from "./components/WorkspaceViews";
import { browserRuntimeInfo, createDemoSnapshot } from "./data/demo";
import {
  armLiveCanary,
  armLiveTrading,
  disarmLiveCanary,
  disarmLiveTrading,
  executeLiveCanary,
  executeLiveTrading,
  quarantineLivePosition,
  forgetWallet,
  forgetResearchArtifact,
  exportCalibrationCsv,
  getCalibrationStatus,
  getApprovedPaperWriteoffs,
  getLiveCanaryStatus,
  getLiveTradingStatus,
  getPaperQuote,
  getRuntimeInfo,
  getWalletPortfolio,
  getWalletStatus,
  importWalletFromFile,
  importResearchArtifact,
  previewLiveCanary,
  recordCalibrationSnapshot,
  refreshMarket,
  refreshMarketToken,
  refreshMarketTokens,
} from "./lib/bridge";
import {
  launchFlowSettingsForBudget,
  usesLegacyV03Defaults,
  usesUntunedV08Defaults,
  type PaperAutomationSettings,
} from "./lib/automationSettings";
import {
  closePaperPosition,
  createPaperEngineState,
  evaluateManualPaperEntry,
  manualPaperBuy,
  markPaperPortfolio,
  runPaperCycle,
  type ManualClosePercent,
  type PaperEngineState,
  type PaperMarketObservation,
} from "./lib/paperEngine";
import { loadPaperState, savePaperState, type PersistedPaperState } from "./lib/persistence";
import { capturePaperEntryCriteria, emptyLiveTradingStatus, planLiveIntent, type LiveIntentPlan, type LiveTradingConfig, type LiveTradingStatus } from "./lib/liveTrading";
import {
  createLivePaperFollowSession, detachLivePaperPosition, discardQueuedLivePaperBuys, ingestLivePaperTrades,
  markLivePaperRequestSubmitted, planLivePaperFollow, resetLivePaperFollow,
  type LivePaperFollowSession,
} from "./lib/livePaperFollow";
import { resolvePaperCloseMark } from "./lib/paperClose";
import { applyPaperWriteoffs } from "./lib/paperWriteoffs";
import { hasFreshPortfolioPrice } from "./lib/portfolioFreshness";
import { refreshHeldLaunches } from "./lib/launchScanner";
import { createPaperMomentumTracker, observationsAt, paperConfig, refreshPaperMarks } from "./lib/paperRuntime";
import {
  describeAutomationTrade,
  engineExitViews,
  engineToPaperAccount,
  paperEvidence,
} from "./lib/paperView";
import {
  createShadowLabState,
  loadShadowLabState,
  runShadowLabCycle,
  saveShadowLabState,
  shadowPolicyMetrics,
  type ShadowLabState,
} from "./lib/shadowLab";
import type {
  CalibrationStatus,
  LiveCanaryExecution,
  LiveCanaryPreview,
  LiveCanaryStatus,
  MarketSnapshot,
  NavView,
  QuoteEstimate,
  RuntimeInfo,
  WalletPortfolio,
  WalletStatus,
} from "./types";

const emptyWallet: WalletStatus = {
  imported: false,
  address: null,
  storage: "Windows Credential Manager",
  warning: null,
};

const emptyCalibration: CalibrationStatus = {
  storagePath: "Desktop app data directory",
  observationCount: 0,
  labeledCount: 0,
  pendingCount: 0,
  positiveCount: 0,
  negativeCount: 0,
  unavailableCount: 0,
  invalidOutcomeCount: 0,
  boundedOutcomeCount: 0,
  observationDays: 0,
  targetHorizonMinutes: 45,
  quoteSampleCount: 0,
  quoteSuccessCount: 0,
  quoteFailureCount: 0,
  realQuoteCoveragePct: null,
  medianRoundTripCostPct: null,
  driftPsi: null,
  driftStatus: "Insufficient history",
  readyForFirstCalibration: false,
  promotionEvidenceDays: 30,
  researchArtifact: null,
  status: "Loading evidence recorder",
};

const emptyLiveCanary: LiveCanaryStatus = {
  available: false,
  armed: false,
  blocker: "Checking desktop execution prerequisites…",
  maxOrderUsd: 10,
  dailyBuyCapUsd: 25,
  dailyBuyUsedUsd: 0,
  maxPriceImpactPct: 1,
  maxSlippageBps: 100,
  cooldownSeconds: 60,
  cooldownRemainingSeconds: 0,
  acknowledgementPhrase: "I UNDERSTAND LIVE TRADES USE REAL FUNDS",
  recentTrades: [],
};

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

export default function App() {
  const loadedPaperRef = useRef<ReturnType<typeof loadPaperState> | null>(null);
  if (loadedPaperRef.current === null) {
    const loaded = loadPaperState();
    if (usesLegacyV03Defaults(loaded.state.automationSettings) || usesUntunedV08Defaults(loaded.state.automationSettings)) {
      loaded.state.automationSettings = launchFlowSettingsForBudget(
        loaded.state.automationSettings.portfolioBudgetUsd,
        loaded.state.automationSettings.enabled,
      );
    }
    loadedPaperRef.current = loaded;
  }
  const loadedPaper = loadedPaperRef.current;

  const [view, setView] = useState<NavView>("market");
  const [snapshot, setSnapshot] = useState<MarketSnapshot>(() => createDemoSnapshot());
  const [renderObservations, setRenderObservations] = useState<PaperMarketObservation[]>(() => observationsAt(snapshot.tokens, Date.now()));
  const [evaluationTimeMs, setEvaluationTimeMs] = useState(Date.now);
  const [runtime, setRuntime] = useState<RuntimeInfo>(browserRuntimeInfo);
  const [selectedMint, setSelectedMint] = useState(snapshot.tokens[0].mint);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [sizeUsd, setSizeUsd] = useState(loadedPaper.state.orderSizeUsd);
  const [quote, setQuote] = useState<QuoteEstimate | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [engineState, setEngineState] = useState<PaperEngineState>(loadedPaper.state.engineState);
  const [automationSettings, setAutomationSettings] = useState<PaperAutomationSettings>(loadedPaper.state.automationSettings);
  const [killSwitch, setKillSwitch] = useState(loadedPaper.state.killSwitch);
  const [persistenceWriteEnabled, setPersistenceWriteEnabled] = useState(loadedPaper.source !== "migration-fallback");
  const [automationMessage, setAutomationMessage] = useState("Waiting for the next market cycle");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [walletStatus, setWalletStatus] = useState<WalletStatus>(emptyWallet);
  const [walletPortfolio, setWalletPortfolio] = useState<WalletPortfolio | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [calibrationStatus, setCalibrationStatus] = useState<CalibrationStatus>(emptyCalibration);
  const [liveCanaryStatus, setLiveCanaryStatus] = useState<LiveCanaryStatus>(emptyLiveCanary);
  const [livePreview, setLivePreview] = useState<LiveCanaryPreview | null>(null);
  const [liveExecution, setLiveExecution] = useState<LiveCanaryExecution | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveTradingStatus, setLiveTradingStatus] = useState<LiveTradingStatus>(emptyLiveTradingStatus);
  const [liveTradingBusy, setLiveTradingBusy] = useState(false);
  const [liveTradingMessage, setLiveTradingMessage] = useState("Live session is off. Review your wallet and limits before starting.");
  const [liveEntriesPaused, setLiveEntriesPaused] = useState(false);
  const [shadowLab, setShadowLab] = useState<ShadowLabState>(() => loadShadowLabState(loadedPaper.state.engineState.startingEquityUsd));

  const engineStateRef = useRef(engineState);
  const automationSettingsRef = useRef(automationSettings);
  const killSwitchRef = useRef(killSwitch);
  const refreshInFlightRef = useRef(false);
  const calibrationInFlightRef = useRef(false);
  const shadowLabRef = useRef(shadowLab);
  const momentumTrackerRef = useRef(createPaperMomentumTracker());
  const feedModeRef = useRef(snapshot.mode);
  const liveFeedExpectedRef = useRef(false);
  const liveTradingStatusRef = useRef(liveTradingStatus);
  const liveObservationsRef = useRef<readonly PaperMarketObservation[]>([]);
  const liveStrategyRef = useRef<PaperAutomationSettings | null>(null);
  const livePaperFollowRef = useRef<LivePaperFollowSession | null>(null);
  const livePaperCriteriaChangedRef = useRef(false);
  const liveEntriesPausedRef = useRef(false);
  const livePollInFlightRef = useRef(false);
  const liveSessionEpochRef = useRef(0);
  const liveWalletRefreshMsRef = useRef(0);
  const liveControlInFlightRef = useRef(0);
  const liveFeedHealthyRef = useRef(false);

  const commitLiveStatus = (status: LiveTradingStatus) => {
    liveTradingStatusRef.current = status;
    setLiveTradingStatus(status);
  };

  const refreshLiveSession = async (evaluate = false) => {
    if (livePollInFlightRef.current || liveControlInFlightRef.current > 0) return;
    livePollInFlightRef.current = true;
    const epoch = liveSessionEpochRef.current;
    try {
      let status = await getLiveTradingStatus();
      if (epoch !== liveSessionEpochRef.current) return;
      if (status.armed && !liveStrategyRef.current) {
        status = await disarmLiveTrading();
        if (epoch !== liveSessionEpochRef.current) return;
        setLiveTradingMessage("The app view reloaded. Live signing is off; review and restart the session to resume exits and entries.");
      }
      commitLiveStatus(status);
      if (evaluate && status.armed && liveStrategyRef.current && !killSwitchRef.current) {
        const options = {
          mode: feedModeRef.current,
          pauseEntries: liveEntriesPausedRef.current || !liveFeedHealthyRef.current || livePaperCriteriaChangedRef.current,
        };
        const follow = livePaperFollowRef.current;
        let plan: LiveIntentPlan;
        if (follow && status.config.entryMode === "paperSignals") {
          const followed = planLivePaperFollow(follow, status, liveObservationsRef.current, liveStrategyRef.current, Date.now(), options);
          livePaperFollowRef.current = followed.session;
          plan = followed;
        } else {
          plan = planLiveIntent(status, liveObservationsRef.current, liveStrategyRef.current, Date.now(), options);
        }
        setLiveTradingMessage(livePaperCriteriaChangedRef.current && !plan.request
          ? "Paper entry rules changed. Stop and restart the live session to capture them; live exits remain enabled."
          : plan.message);
        if (plan.request) {
          setLiveTradingBusy(true);
          // Consume before IPC: an uncertain response must never produce a second BUY.
          if (livePaperFollowRef.current) {
            livePaperFollowRef.current = markLivePaperRequestSubmitted(livePaperFollowRef.current, plan.request);
          }
          const next = await executeLiveTrading(plan.request);
          if (epoch !== liveSessionEpochRef.current) return;
          commitLiveStatus(next);
          const order = next.recentOrders.find((item) => item.id === plan.request?.intentId);
          setLiveTradingMessage(order ? `${order.side} ${order.symbol}: ${order.status}${order.detail ? ` · ${order.detail}` : ""}` : "Checking transaction status in the native journal.");
        }
      }
      if (status.owner && (status.armed || status.pendingCount > 0) && Date.now() - liveWalletRefreshMsRef.current > 30_000) {
        liveWalletRefreshMsRef.current = Date.now();
        const portfolio = await getWalletPortfolio();
        if (epoch === liveSessionEpochRef.current) setWalletPortfolio(portfolio);
      }
    } catch (error) {
      if (epoch === liveSessionEpochRef.current) setLiveTradingMessage(`Live execution waiting · ${String(error)}`);
    } finally {
      livePollInFlightRef.current = false;
      if (epoch === liveSessionEpochRef.current) setLiveTradingBusy(false);
    }
  };

  const commitEngineState = (next: PaperEngineState) => {
    engineStateRef.current = next;
    setEngineState(next);
  };

  useEffect(() => {
    let cancelled = false;
    void getApprovedPaperWriteoffs().then((approvals) => {
      if (cancelled || !approvals.length) return;
      const current = engineStateRef.current;
      const next = applyPaperWriteoffs(current, approvals, Date.now(), automationSettingsRef.current.dailyLossLimitUsd);
      if (next !== current) {
        commitEngineState(next);
        setAutomationMessage("Approved illiquid paper holdings written off at zero proceeds. History retained; daily loss limits still apply.");
      }
    }).catch((error) => { if (!cancelled) setAutomationMessage(`Paper adjustment: ${String(error)}`); });
    return () => { cancelled = true; };
  }, []);

  const commitAutomationSettings = (next: PaperAutomationSettings) => {
    const live = liveTradingStatusRef.current;
    if (live.armed && live.config.entryMode === "paperSignals"
      && JSON.stringify(capturePaperEntryCriteria(next)) !== JSON.stringify(live.config.paperEntryCriteria)) {
      livePaperCriteriaChangedRef.current = true;
      liveEntriesPausedRef.current = true;
      setLiveEntriesPaused(true);
      if (livePaperFollowRef.current) livePaperFollowRef.current = discardQueuedLivePaperBuys(livePaperFollowRef.current);
      setLiveTradingMessage("Paper entry rules changed. Stop and restart the live session to capture them; live exits remain enabled.");
    }
    automationSettingsRef.current = next;
    setAutomationSettings(next);
  };

  const selected = snapshot.tokens.find((token) => token.mint === selectedMint) ?? snapshot.tokens[0];
  const selectedObservation = renderObservations.find((observation) => observation.mint === selected?.mint);
  const selectedManualObservation = useMemo(
    () => selectedObservation
      ? {
          ...selectedObservation,
          safety: {
            ...selectedObservation.safety,
            priceImpactPct: quote?.priceImpactPct ?? selectedObservation.safety.priceImpactPct,
          },
        }
      : null,
    [quote?.priceImpactPct, selectedObservation],
  );
  const manualEntryEvaluation = useMemo(
    () => selectedManualObservation
      ? evaluateManualPaperEntry(
          engineState,
          selectedManualObservation,
          sizeUsd,
          evaluationTimeMs,
          paperConfig(automationSettings, engineState),
          { killSwitch },
        )
      : null,
    [automationSettings, engineState, evaluationTimeMs, killSwitch, selectedManualObservation, sizeUsd],
  );
  const portfolioMark = useMemo(
    () => markPaperPortfolio(engineState, renderObservations.filter((observation) => {
      const sourceAt = Date.parse(observation.updatedAt);
      return [sourceAt, observation.observedAtMs ?? sourceAt]
        .every((at) => Number.isFinite(at) && at <= evaluationTimeMs && evaluationTimeMs - at <= 75_000);
    }), paperConfig(automationSettings, engineState)),
    [automationSettings, engineState, evaluationTimeMs, renderObservations],
  );
  const account = useMemo(() => engineToPaperAccount(engineState), [engineState]);
  const exits = useMemo(() => engineExitViews(engineState), [engineState]);
  const evidence = useMemo(() => paperEvidence(engineState), [engineState]);
  const shadowMetrics = useMemo(
    () => shadowPolicyMetrics(shadowLab, renderObservations),
    [renderObservations, shadowLab],
  );
  const todayKey = new Date().toISOString().slice(0, 10);
  const unpricedPaperCount = engineState.positions.filter(position => !hasFreshPortfolioPrice(snapshot.tokens.find(token => token.mint === position.mint), evaluationTimeMs)).length;
  const automationStatus = killSwitch
    ? "STOPPED"
    : !automationSettings.enabled
      ? "PAUSED"
      : engineState.dailyLossLockedDay === todayKey
        ? "DAILY STOP"
        : liveFeedExpectedRef.current && snapshot.mode !== "live"
          ? "FEED WAIT"
          : unpricedPaperCount > 0 ? "UNPRICED HOLDINGS" : engineState.positions.length >= automationSettings.maxOpenPositions ? "POSITION LIMIT" : "RUNNING";

  const recordCycleResult = (
    trades: PaperEngineState["trades"],
    dailyLossTriggered: boolean,
    closeBlockers: string[],
  ) => {
    if (trades.length > 0) {
      const latest = trades[trades.length - 1];
      const message = describeAutomationTrade(latest.side, latest.symbol, latest.reason);
      setAutomationMessage(message);
      setToast({ kind: "ok", message });
    } else if (dailyLossTriggered) {
      setAutomationMessage("Daily loss circuit breaker is latched until 00:00 UTC");
    } else if (closeBlockers.length > 0) {
      setAutomationMessage(`Exit waiting for a fresh mark · ${closeBlockers.length} blocked`);
    } else if (automationSettingsRef.current.enabled) {
      setAutomationMessage("Scanning · no candidate currently passes every entry gate");
    }
  };

  const processPaperMarket = (observations: readonly PaperMarketObservation[], nowMs: number) => {
    const settings = automationSettingsRef.current;
    const stopped = killSwitchRef.current;
    let nextState = refreshPaperMarks(engineStateRef.current, observations, nowMs);

    if (settings.enabled || stopped) {
      const result = runPaperCycle(
        nextState,
        observations,
        nowMs,
        paperConfig(settings, nextState),
        { killSwitch: stopped },
      );
      nextState = result.state;
      recordCycleResult(result.trades, result.dailyLossTriggered, result.closeBlockers);
      // Only newly emitted automatic paper events can authorize a follow signal.
      // Manual trades, storage hydration, write-offs and shadow trades never enter here.
      if (livePaperFollowRef.current && !stopped) {
        livePaperFollowRef.current = ingestLivePaperTrades(
          livePaperFollowRef.current, liveTradingStatusRef.current, result.trades, nowMs,
          { mode: feedModeRef.current, pauseEntries: liveEntriesPausedRef.current
            || !liveFeedHealthyRef.current || livePaperCriteriaChangedRef.current },
        );
      }
    }

    commitEngineState(nextState);
  };

  const applyMarketSnapshot = (next: MarketSnapshot) => {
    const nowMs = Date.now();
    setEvaluationTimeMs(nowMs);
    if (feedModeRef.current !== next.mode) momentumTrackerRef.current = createPaperMomentumTracker();
    feedModeRef.current = next.mode;
    liveFeedHealthyRef.current = next.mode === "live";
    if (next.mode === "live") liveFeedExpectedRef.current = true;
    const observations = observationsAt(next.tokens, nowMs, momentumTrackerRef.current);
    liveObservationsRef.current = next.mode === "live" ? observations : [];
    setRenderObservations(observations);
    if (next.mode === "live" || !liveFeedExpectedRef.current) {
      processPaperMarket(observations, nowMs);
    } else {
      setAutomationMessage("Live feed unavailable · paper automation waiting for live marks");
    }
    if (next.mode === "live") {
      const nextLab = runShadowLabCycle(shadowLabRef.current, observations, nowMs);
      shadowLabRef.current = nextLab;
      setShadowLab(nextLab);
    }
    setSnapshot(next);
    setSelectedMint((current) => next.tokens.some((token) => token.mint === current) ? current : next.tokens[0]?.mint ?? "");
    if (next.mode === "live" && !calibrationInFlightRef.current) {
      calibrationInFlightRef.current = true;
      recordCalibrationSnapshot(next)
        .then(setCalibrationStatus)
        .catch((error) => setAutomationMessage(`Evidence recorder warning · ${String(error)}`))
        .finally(() => { calibrationInFlightRef.current = false; });
    }
  };

  const loadMarket = async (quiet = false) => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (!quiet) setLoading(true);
    try {
      const market = await refreshMarket();
      const heldMints = [...engineStateRef.current.positions, ...liveTradingStatusRef.current.positions].map((position) => position.mint);
      applyMarketSnapshot(await refreshHeldLaunches(market, heldMints, refreshMarketToken, Date.now, refreshMarketTokens));
    } catch (error) {
      liveFeedHealthyRef.current = false;
      setLiveTradingMessage("Market refresh failed. New live entries are paused until the live feed recovers.");
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      refreshInFlightRef.current = false;
      setEvaluationTimeMs(Date.now());
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    engineStateRef.current = engineState;
  }, [engineState]);

  useEffect(() => {
    automationSettingsRef.current = automationSettings;
  }, [automationSettings]);

  useEffect(() => {
    killSwitchRef.current = killSwitch;
  }, [killSwitch]);

  useEffect(() => {
    shadowLabRef.current = shadowLab;
    const timer = window.setTimeout(() => saveShadowLabState(shadowLab), 250);
    return () => window.clearTimeout(timer);
  }, [shadowLab]);

  useEffect(() => {
    let cancelled = false;
    refreshInFlightRef.current = true;
    Promise.all([refreshMarket(), getRuntimeInfo(), getWalletStatus(), getCalibrationStatus(), getLiveCanaryStatus()])
      .then(async ([market, info, wallet, calibration, liveStatus]) => {
        market = await refreshHeldLaunches(market, engineStateRef.current.positions.map((position) => position.mint), refreshMarketToken, Date.now, refreshMarketTokens);
        if (cancelled) return;
        applyMarketSnapshot(market);
        setRuntime(info);
        setWalletStatus(wallet);
        setCalibrationStatus(calibration);
        setLiveCanaryStatus(liveStatus);
        if (wallet.imported) {
          getWalletPortfolio().then((portfolio) => !cancelled && setWalletPortfolio(portfolio)).catch(() => undefined);
        }
      })
      .catch((error) => !cancelled && setToast({ kind: "error", message: String(error) }))
      .finally(() => { if (!cancelled) refreshInFlightRef.current = false; });

    const timer = window.setInterval(() => loadMarket(true), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // The interval reads current trading state through refs, so one subscription is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshLiveSession();
    const timer = window.setInterval(() => { void refreshLiveSession(true); }, 5_000);
    return () => { window.clearInterval(timer); liveSessionEpochRef.current += 1; };
    // Native status and the strategy captured at user activation are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!persistenceWriteEnabled) return;
    const persisted: PersistedPaperState = {
      engineState,
      automationSettings,
      orderSizeUsd: sizeUsd,
      killSwitch,
    };
    const timer = window.setTimeout(() => {
      if (!savePaperState(persisted)) {
        setAutomationMessage("Paper state could not be saved; keep the app open");
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [automationSettings, engineState, killSwitch, persistenceWriteEnabled, sizeUsd]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setQuoteLoading(true);
    const timer = window.setTimeout(() => {
      getPaperQuote(selected, sizeUsd, automationSettings.maxPriceImpactPct, automationSettings.minLiquidityUsd)
        .then((nextQuote) => !cancelled && setQuote(nextQuote))
        .catch((error) => !cancelled && setToast({ kind: "error", message: String(error) }))
        .finally(() => !cancelled && setQuoteLoading(false));
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [automationSettings.maxPriceImpactPct, automationSettings.minLiquidityUsd, selected, sizeUsd]);

  useEffect(() => {
    setLivePreview(null);
    setLiveExecution(null);
  }, [selectedMint]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (loadedPaper.issue) {
      const message = loadedPaper.source === "migration-fallback"
        ? "Older paper history needs an explicit reset before PulseForge can save the new engine state."
        : `Saved paper state was not used (${loadedPaper.issue}); a safe default was loaded.`;
      setToast({ kind: "error", message });
      setAutomationMessage(message);
    }
  }, [loadedPaper.issue, loadedPaper.source]);

  const handlePaperBuy = () => {
    if (!quote || !selected) return;
    try {
      const nowMs = Date.now();
      const rawObservation = observationsAt([selected], nowMs)[0];
      const observation = {
        ...rawObservation,
        safety: { ...rawObservation.safety, priceImpactPct: quote.priceImpactPct },
      };
      const current = engineStateRef.current;
      const next = manualPaperBuy(
        current,
        observation,
        quote.inputUsd,
        nowMs,
        paperConfig(automationSettingsRef.current, current),
        { killSwitch: killSwitchRef.current },
      );
      commitEngineState(next);
      setToast({ kind: "ok", message: `Paper bought ${selected.symbol} for $${quote.inputUsd.toFixed(2)}` });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleClosePaperPosition = async ({ mint, fraction }: { mint: string; fraction: 0.25 | 0.5 | 1 }) => {
    const nowMs = Date.now();
    const percent = Math.round(fraction * 100) as ManualClosePercent;
    const current = engineStateRef.current;
    const position = current.positions.find((candidate) => candidate.mint === mint);
    if (!position) throw new Error("This paper position is no longer open");
    const resolvedMark = await resolvePaperCloseMark(position, snapshot.tokens, nowMs, refreshMarketToken);
    const latest = engineStateRef.current;
    if (!latest.positions.some((candidate) => candidate.mint === mint)) {
      throw new Error("This paper position closed while its market mark was refreshing");
    }
    const next = closePaperPosition(
      latest,
      resolvedMark.observation,
      percent,
      Date.now(),
      paperConfig(automationSettingsRef.current, latest),
    );
    if (!next.positions.some(candidate => candidate.mint === mint) && livePaperFollowRef.current) {
      livePaperFollowRef.current = detachLivePaperPosition(livePaperFollowRef.current, mint);
    }
    commitEngineState(next);
    const trade = next.trades[next.trades.length - 1];
    setToast({
      kind: "ok",
      message: `Closed ${percent}% of ${trade.symbol} · ${trade.realizedPnlUsd >= 0 ? "+" : ""}$${trade.realizedPnlUsd.toFixed(2)}${resolvedMark.source === "last-recorded" ? " · last recorded mark (provider unavailable)" : resolvedMark.source === "provider" ? " · fresh Jupiter mark" : ""}`,
    });
  };

  const handleKillSwitch = () => {
    const nextStopped = !killSwitchRef.current;
    killSwitchRef.current = nextStopped;
    setKillSwitch(nextStopped);
    if (!nextStopped) {
      setAutomationMessage(automationSettingsRef.current.enabled ? "Kill switch reset · scanning resumes" : "Kill switch reset · automation paused");
      return;
    }

    void handleStopLiveTrading().catch(() => undefined);
    void disarmLiveCanary().then(setLiveCanaryStatus).catch((error) => setToast({ kind: "error", message: `Manual live stop failed: ${String(error)}` }));
    setLivePreview(null);

    const nowMs = Date.now();
    const observations = observationsAt(snapshot.tokens, nowMs);
    const current = engineStateRef.current;
    const result = runPaperCycle(
      current,
      observations,
      nowMs,
      paperConfig(automationSettingsRef.current, current),
      { killSwitch: true },
    );
    commitEngineState(result.state);
    const closed = result.trades.filter((trade) => trade.side === "SELL").length;
    setAutomationMessage(closed > 0 ? `Kill switch flattened ${closed} paper position${closed === 1 ? "" : "s"}` : "Kill switch active · entries blocked");
    setToast({
      kind: closed > 0 ? "ok" : result.closeBlockers.length > 0 ? "error" : "ok",
      message: result.closeBlockers.length > 0
        ? `Kill switch active; ${result.closeBlockers.length} position(s) need a fresh mark before closing`
        : closed > 0
          ? `Kill switch flattened ${closed} paper position${closed === 1 ? "" : "s"}`
          : "Kill switch active; automatic and manual entries are blocked",
    });
  };

  const handleAutomationSettingsChange = (incoming: PaperAutomationSettings) => {
    const previous = automationSettingsRef.current;
    let next = { ...incoming };
    if (incoming.portfolioBudgetUsd !== previous.portfolioBudgetUsd && previous.portfolioBudgetUsd > 0) {
      const reserveRatio = previous.reserveUsd / previous.portfolioBudgetUsd;
      const dailyLossRatio = previous.dailyLossLimitUsd / previous.portfolioBudgetUsd;
      next = {
        ...next,
        reserveUsd: roundMoney(Math.min(Math.max(0, incoming.portfolioBudgetUsd - 5), incoming.portfolioBudgetUsd * reserveRatio)),
        dailyLossLimitUsd: roundMoney(Math.max(0.1, incoming.portfolioBudgetUsd * dailyLossRatio)),
      };
    }
    commitAutomationSettings(next);

    if (
      incoming.portfolioBudgetUsd !== previous.portfolioBudgetUsd &&
      engineStateRef.current.trades.length === 0 &&
      engineStateRef.current.positions.length === 0
    ) {
      commitEngineState(createPaperEngineState(Math.max(5, next.portfolioBudgetUsd), Date.now()));
    }

    if (incoming.portfolioBudgetUsd !== previous.portfolioBudgetUsd) {
      const resetLab = createShadowLabState(Math.max(5, next.portfolioBudgetUsd), Date.now());
      shadowLabRef.current = resetLab;
      setShadowLab(resetLab);
    }

    if (!previous.enabled && next.enabled) {
      const nowMs = Date.now();
      if (snapshot.mode === "live" || !liveFeedExpectedRef.current) processPaperMarket(renderObservations, nowMs);
    } else if (previous.enabled && !next.enabled) {
      setAutomationMessage("Automatic entries and exits paused");
    }
  };

  const handleResetPaperAccount = () => {
    const current = engineStateRef.current;
    if (
      (current.trades.length > 0 || current.positions.length > 0) &&
      !window.confirm("Reset the paper account and permanently clear all simulated positions and trade history?")
    ) return;
    const next = createPaperEngineState(Math.max(5, automationSettingsRef.current.portfolioBudgetUsd), Date.now());
    if (livePaperFollowRef.current) {
      livePaperFollowRef.current = resetLivePaperFollow(livePaperFollowRef.current, next.nextTradeSequence);
    }
    commitEngineState(next);
    killSwitchRef.current = false;
    setKillSwitch(false);
    setPersistenceWriteEnabled(true);
    setAutomationMessage("Paper account reset · waiting for the next market cycle");
    setToast({ kind: "ok", message: `Paper account reset to $${next.startingEquityUsd.toFixed(2)}` });
  };

  const handleResetShadowLab = () => {
    if (!window.confirm("Reset all five shadow-policy ledgers and their attribution history? Your paper account is not affected.")) return;
    const next = createShadowLabState(engineStateRef.current.startingEquityUsd, Date.now());
    shadowLabRef.current = next;
    setShadowLab(next);
    setToast({ kind: "ok", message: "Shadow strategy comparison reset" });
  };

  const refreshWallet = async () => {
    setWalletBusy(true);
    try {
      const [portfolio, liveStatus] = await Promise.all([getWalletPortfolio(), getLiveCanaryStatus()]);
      setWalletPortfolio(portfolio);
      setLiveCanaryStatus(liveStatus);
      await refreshLiveSession();
    } finally {
      setWalletBusy(false);
    }
  };

  const handleImportWallet = async () => {
    await handleStopLiveTrading();
    setWalletBusy(true);
    try {
      const status = await importWalletFromFile();
      setWalletStatus(status);
      const [portfolio, liveStatus] = await Promise.all([getWalletPortfolio(), getLiveCanaryStatus()]);
      setWalletPortfolio(portfolio);
      setLiveCanaryStatus(liveStatus);
      await refreshLiveSession();
      setToast({ kind: "ok", message: "Hot wallet stored in Windows Credential Manager" });
    } finally {
      setWalletBusy(false);
    }
  };

  const handleForgetWallet = async () => {
    if (!window.confirm("Remove the local wallet credential? This does not move or recover on-chain funds.")) return;
    await handleStopLiveTrading();
    setWalletBusy(true);
    try {
      const status = await forgetWallet();
      setWalletStatus(status);
      setWalletPortfolio(null);
      setLiveCanaryStatus(await getLiveCanaryStatus());
      await refreshLiveSession();
      setToast({ kind: "ok", message: "Local wallet credential removed" });
    } finally {
      setWalletBusy(false);
    }
  };

  const handleStartLiveTrading = async (config: LiveTradingConfig, acknowledgement: string) => {
    if (killSwitchRef.current || feedModeRef.current !== "live") throw new Error("Reset the kill switch and wait for a live market feed before starting.");
    const epoch = ++liveSessionEpochRef.current;
    const strategy = { ...automationSettingsRef.current };
    liveControlInFlightRef.current += 1;
    setLiveTradingBusy(true);
    try {
      const canary = await disarmLiveCanary();
      if (epoch !== liveSessionEpochRef.current || killSwitchRef.current) throw new Error("Live start was cancelled by Stop.");
      setLiveCanaryStatus(canary);
      setLivePreview(null);
      const sessionConfig: LiveTradingConfig = { ...config, paperEntryCriteria: config.entryMode === "paperSignals"
        ? capturePaperEntryCriteria(strategy) : null };
      const status = await armLiveTrading(sessionConfig, acknowledgement);
      if (epoch !== liveSessionEpochRef.current || killSwitchRef.current) {
        await disarmLiveTrading();
        throw new Error("Live start was cancelled by Stop.");
      }
      liveStrategyRef.current = strategy;
      livePaperFollowRef.current = status.config.entryMode === "paperSignals"
        ? createLivePaperFollowSession(status, Date.now(), engineStateRef.current.nextTradeSequence) : null;
      const criteriaChanged = status.config.entryMode === "paperSignals"
        && JSON.stringify(capturePaperEntryCriteria(automationSettingsRef.current)) !== JSON.stringify(status.config.paperEntryCriteria);
      livePaperCriteriaChangedRef.current = criteriaChanged;
      liveEntriesPausedRef.current = criteriaChanged;
      setLiveEntriesPaused(criteriaChanged);
      commitLiveStatus(status);
      setLiveTradingMessage(criteriaChanged
        ? "Paper entry rules changed during activation. Stop and restart the live session to capture them; live exits remain enabled."
        : status.config.entryMode === "paperSignals"
        ? "Following new automatic paper trades within your live limits. Earlier paper trades are not replayed."
        : "Live session started. Scanning with the strategy rules captured at activation.");
    } finally {
      liveControlInFlightRef.current -= 1;
      if (epoch === liveSessionEpochRef.current) setLiveTradingBusy(false);
    }
  };

  const handleStopLiveTrading = async () => {
    const epoch = ++liveSessionEpochRef.current;
    liveControlInFlightRef.current += 1;
    liveStrategyRef.current = null;
    livePaperFollowRef.current = null;
    livePaperCriteriaChangedRef.current = false;
    commitLiveStatus({ ...liveTradingStatusRef.current, armed: false });
    setLiveTradingMessage("Stopping live submissions. Pending transactions may still confirm; real holdings remain in the wallet.");
    try {
      const status = await disarmLiveTrading();
      if (epoch === liveSessionEpochRef.current) {
        commitLiveStatus(status);
        setLiveTradingMessage("Live session stopped. Pending transactions are still reconciled; automatic exits are off.");
      }
    } catch (error) {
      if (epoch === liveSessionEpochRef.current) {
        setLiveTradingMessage(`Could not verify the native stop: ${String(error)}`);
        setToast({ kind: "error", message: "Live stop could not be confirmed. Close PulseForge to stop further submissions." });
      }
      throw error;
    } finally {
      liveControlInFlightRef.current -= 1;
      if (epoch === liveSessionEpochRef.current) setLiveTradingBusy(false);
    }
  };

  const handlePauseLiveEntries = (paused: boolean) => {
    if (!paused && livePaperCriteriaChangedRef.current) {
      setLiveTradingMessage("Stop and restart the live session to capture the changed paper entry rules.");
      return;
    }
    if (paused && livePaperFollowRef.current) {
      livePaperFollowRef.current = discardQueuedLivePaperBuys(livePaperFollowRef.current);
    }
    liveEntriesPausedRef.current = paused;
    setLiveEntriesPaused(paused);
    setLiveTradingMessage(paused ? "New live entries paused. Automatic exit checks remain enabled for managed positions." : "Live entry checks resumed within the reviewed limits.");
  };

  const handleQuarantineLivePosition = async (positionId: string) => {
    const current = liveTradingStatusRef.current;
    if (!current.owner || current.armed || current.pendingCount > 0) throw new Error("Stop the live session and wait for pending orders before quarantining.");
    if (livePollInFlightRef.current) throw new Error("Wait for the current live status check to finish.");
    livePollInFlightRef.current = true;
    liveControlInFlightRef.current += 1;
    const epoch = liveSessionEpochRef.current;
    setLiveTradingBusy(true);
    try {
      const status = await quarantineLivePosition(current.owner, positionId);
      if (epoch === liveSessionEpochRef.current) {
        commitLiveStatus(status);
        setLiveTradingMessage("Position quarantined. Tokens remain held; the full cost counts against today's loss limit. Review your limits before starting live automation.");
      }
    } finally {
      livePollInFlightRef.current = false;
      liveControlInFlightRef.current -= 1;
      setLiveTradingBusy(false);
    }
  };

  const handleCloseLivePosition = async (positionId: string) => {
    const position = liveTradingStatusRef.current.positions.find((item) => item.id === positionId);
    if (!position || !liveTradingStatusRef.current.armed || killSwitchRef.current) throw new Error("An active live session is required to close a managed position.");
    if (livePollInFlightRef.current) throw new Error("Wait for the current live status or execution check to finish.");
    livePollInFlightRef.current = true;
    const epoch = liveSessionEpochRef.current;
    setLiveTradingBusy(true);
    try {
      const status = await executeLiveTrading({ sessionGeneration: liveTradingStatusRef.current.sessionGeneration, intentId: `manual-${crypto.randomUUID()}`, side: "SELL", mint: position.mint, positionId, reason: "Manual close", signalAtMs: Date.now() });
      if (epoch === liveSessionEpochRef.current) {
        commitLiveStatus(status);
        setLiveTradingMessage(`Close requested for ${position.symbol}. The native journal shows confirmation status.`);
      }
    } finally {
      livePollInFlightRef.current = false;
      setLiveTradingBusy(false);
    }
  };

  const handleArmLiveCanary = async (acknowledgement: string) => {
    if (killSwitchRef.current || liveTradingStatusRef.current.armed || liveTradingStatusRef.current.pendingCount > 0) {
      setToast({ kind: "error", message: "Manual live swaps require the kill switch reset and the automatic live session stopped with no pending orders." });
      return;
    }
    setLiveBusy(true);
    try {
      setLiveCanaryStatus(await armLiveCanary(acknowledgement));
      setToast({ kind: "ok", message: "Manual live canary armed for this app session only" });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      setLiveBusy(false);
    }
  };

  const handleDisarmLiveCanary = async () => {
    setLiveBusy(true);
    try {
      setLiveCanaryStatus(await disarmLiveCanary());
      setLivePreview(null);
      setLiveExecution(null);
      setToast({ kind: "ok", message: "Manual live canary disarmed" });
    } finally {
      setLiveBusy(false);
    }
  };

  const handlePreviewLiveBuy = async (amountUsd: number) => {
    setLiveBusy(true);
    setLiveExecution(null);
    try {
      setLivePreview(await previewLiveCanary({ side: "BUY", mint: selected.mint, amountUsd }));
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLiveBusy(false);
    }
  };

  const handlePreviewLiveSell = async (sellPercent: 25 | 50 | 100) => {
    setLiveBusy(true);
    setLiveExecution(null);
    try {
      setLivePreview(await previewLiveCanary({ side: "SELL", mint: selected.mint, sellPercent }));
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLiveBusy(false);
    }
  };

  const handleExecuteLive = async (confirmationPhrase: string) => {
    if (!livePreview) return;
    setLiveBusy(true);
    try {
      const execution = await executeLiveCanary(livePreview.challengeId, confirmationPhrase);
      setLiveExecution(execution);
      setLivePreview(null);
      const [liveStatus, portfolio] = await Promise.all([getLiveCanaryStatus(), getWalletPortfolio()]);
      setLiveCanaryStatus(liveStatus);
      setWalletPortfolio(portfolio);
      setToast({ kind: "ok", message: `${execution.side} ${execution.symbol} confirmed on Solana` });
    } catch (error) {
      setLivePreview(null);
      setLiveCanaryStatus(await getLiveCanaryStatus().catch(() => liveCanaryStatus));
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLiveBusy(false);
    }
  };

  const handleExportCalibration = async () => {
    try {
      const path = await exportCalibrationCsv();
      setToast({ kind: "ok", message: `Calibration dataset exported to ${path}` });
    } catch (error) {
      if (String(error).includes("cancelled")) return;
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleImportResearchArtifact = async () => {
    try {
      const status = await importResearchArtifact();
      setCalibrationStatus(status);
      setToast({ kind: "ok", message: "Research calibration report imported; execution remains promotion-locked" });
    } catch (error) {
      if (String(error).includes("cancelled")) return;
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleForgetResearchArtifact = async () => {
    if (!window.confirm("Remove the imported research report? This does not delete calibration observations or paper trades.")) return;
    try {
      const status = await forgetResearchArtifact();
      setCalibrationStatus(status);
      setToast({ kind: "ok", message: "Imported research report removed" });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="app-shell">
      <NavRail active={view} onChange={setView} />
      <TopBar snapshot={snapshot} killSwitch={killSwitch} onKillSwitch={handleKillSwitch} liveArmed={liveTradingStatus.armed} />
      <main className={`app-main ${view === "market" ? "app-main--market" : ""}`}>
        {snapshot.warning && (
          <div className={`feed-notice ${snapshot.mode === "live" ? "feed-notice--live" : ""}`}>
            <AlertTriangle size={14} />
            <span>{snapshot.warning}</span>
            <button onClick={() => loadMarket()} disabled={loading}><RefreshCw size={13} className={loading ? "spin" : ""} />Refresh</button>
          </div>
        )}
        {view === "market" ? (!selected ? (
          <div className="fatal-state"><DatabaseZap size={34} /><h1>No market candidates</h1><button onClick={() => loadMarket()}><RefreshCw size={15} />Retry</button><button onClick={() => setView("live-wallet")}>Manage live wallet</button></div>
        ) : (
          <>
          <LaunchPipeline observations={renderObservations} settings={automationSettings} state={engineState}
            nowMs={evaluationTimeMs} mode={snapshot.mode} killSwitch={killSwitch}
            feedWaiting={liveFeedExpectedRef.current && snapshot.mode !== "live"} onOpenSettings={() => setView("settings")} />
          <div className="market-workspace">
            <div className="market-center">
              <MarketTable
                tokens={snapshot.tokens}
                settings={automationSettings}
                maxPriceImpactPct={automationSettings.maxPriceImpactPct}
                minLiquidityUsd={automationSettings.minLiquidityUsd}
                selectedMint={selected.mint}
                onSelect={(token) => {
                  setSelectedMint(token.mint);
                  setInspectorOpen(true);
                }}
              />
              <ChartPanel token={selected} trades={account.trades} />
            </div>
            {inspectorOpen && (
              <DecisionInspector
                token={selected}
                quote={quote}
                sizeUsd={sizeUsd}
                killSwitch={killSwitch}
                quoteLoading={quoteLoading}
                manualBlockers={manualEntryEvaluation?.blockers ?? []}
                launchPattern={selectedObservation?.launchPattern}
                launchPatternDetail={selectedObservation?.launchPatternDetail}
                maxPriceImpactPct={automationSettings.maxPriceImpactPct}
                onSizeChange={setSizeUsd}
                onPaperBuy={handlePaperBuy}
                onClose={() => setInspectorOpen(false)}
                liveCanaryStatus={liveCanaryStatus}
                livePreview={livePreview}
                liveExecution={liveExecution}
                liveBusy={liveBusy}
                onPreviewLiveBuy={handlePreviewLiveBuy}
                onPreviewLiveSell={handlePreviewLiveSell}
                onExecuteLive={handleExecuteLive}
                onCancelLivePreview={() => setLivePreview(null)}
              />
            )}
          </div>
          </>
        )) : view === "live-wallet" ? (
          <LiveTradingPanel
            paperEntryCriteria={capturePaperEntryCriteria(automationSettings)}
            status={liveTradingStatus}
            busy={liveTradingBusy}
            message={liveTradingMessage}
            pauseEntries={liveEntriesPaused}
            onPauseEntries={handlePauseLiveEntries}
            onArm={handleStartLiveTrading}
            onDisarm={handleStopLiveTrading}
            onRefresh={() => refreshLiveSession()}
            onClosePosition={handleCloseLivePosition}
            onQuarantinePosition={handleQuarantineLivePosition}
            strategyLabel={`${(liveStrategyRef.current ?? automationSettings).strategyId === "launch-flow" && (liveStrategyRef.current ?? automationSettings).takeProfitPct === 0 ? "Launch runner" : (liveStrategyRef.current ?? automationSettings).strategyId} · entry and exit rules captured when started`}
            walletPortfolio={walletPortfolio}
            canArm={!killSwitch && snapshot.mode === "live" && !liveBusy}
          />
        ) : (
          <WorkspaceView
            view={view}
            snapshot={snapshot}
            account={account}
            equityUsd={portfolioMark.equityUsd}
            unrealizedPnlUsd={portfolioMark.unrealizedPnlUsd}
            runtime={runtime}
            walletStatus={walletStatus}
            walletPortfolio={walletPortfolio}
            walletBusy={walletBusy}
            onImportWallet={handleImportWallet}
            onForgetWallet={handleForgetWallet}
            onRefreshWallet={refreshWallet}
            paperExits={exits}
            onClosePaperPosition={handleClosePaperPosition}
            automationSettings={automationSettings}
            onAutomationSettingsChange={handleAutomationSettingsChange}
            paperEvidence={evidence}
            currentPaperCapitalUsd={engineState.startingEquityUsd}
            automationStatus={automationStatus}
            onResetPaperAccount={handleResetPaperAccount}
            calibrationStatus={calibrationStatus}
            onExportCalibration={handleExportCalibration}
            onImportResearchArtifact={handleImportResearchArtifact}
            onForgetResearchArtifact={handleForgetResearchArtifact}
            shadowLab={shadowLab}
            shadowMetrics={shadowMetrics}
            onResetShadowLab={handleResetShadowLab}
            liveCanaryStatus={liveCanaryStatus}
            liveCanaryBusy={liveBusy}
            onArmLiveCanary={handleArmLiveCanary}
            onDisarmLiveCanary={handleDisarmLiveCanary}
          />
        )}
      </main>
      <footer className="status-bar">
        <span><i className={snapshot.mode === "live" ? "status-live" : "status-demo"} />Data: {snapshot.mode === "live" ? "Live discovery" : "Demo"}</span>
        <span>Updated: {new Date(snapshot.updatedAt).toLocaleTimeString("en-GB", { hour12: false })}</span>
        <span>Source: {snapshot.provider}</span>
        <span>Auto paper: <strong className={automationStatus === "RUNNING" ? "text-positive" : automationStatus === "PAUSED" ? "text-amber" : "text-danger"}>{automationStatus}</strong></span>
        <span title={liveTradingMessage}>Live wallet: <strong className={liveTradingStatus.armed ? "text-danger" : "text-amber"}>{liveTradingStatus.armed ? liveEntriesPaused ? "ARMED · ENTRIES PAUSED" : "ARMED" : "OFF"}</strong></span>
        <span title={automationMessage}>{automationMessage}</span>
        <span className="status-spacer" />
        <span>Paper equity: <strong>{unpricedPaperCount ? "Unavailable" : `$${portfolioMark.equityUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</strong></span>
        <span>Unrealized: <strong className={portfolioMark.unrealizedPnlUsd >= 0 ? "text-positive" : "text-danger"}>{unpricedPaperCount ? "—" : `$${portfolioMark.unrealizedPnlUsd.toFixed(2)}`}</strong></span>
      </footer>
      {toast && (
        <div className={`toast toast--${toast.kind}`} role="status">
          {toast.kind === "ok" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}
    </div>
  );
}
