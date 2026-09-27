import { describe, expect, it } from "vitest";
import { applyPaperWriteoffs } from "./paperWriteoffs";
import {
  conservativeSettingsForBudget,
  DEFAULT_PAPER_AUTOMATION_SETTINGS,
  launchFlowSettingsForBudget,
  launchRunnerSettingsForBudget,
  pumpScalpSettingsForBudget,
} from "./automationSettings";
import {
  clearPaperState,
  createDefaultPaperState,
  loadPaperState,
  PAPER_STORAGE_KEY,
  PAPER_STORAGE_VERSION,
  savePaperState,
  type PaperStorage,
  type PersistedPaperState,
} from "./persistence";

const NOW = Date.UTC(2026, 7, 21, 10, 0, 0);
const MINT = "So11111111111111111111111111111111111111112";

class MemoryStorage implements PaperStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function populatedState(): PersistedPaperState {
  const state = createDefaultPaperState(NOW);
  const notionalUsd = 25;
  const feeUsd = 0.0875;
  const midPriceUsd = 178;
  const fillPriceUsd = 179;
  const quantity = (notionalUsd - feeUsd) / fillPriceUsd;
  return {
    ...state,
    engineState: {
      ...state.engineState,
      cashUsd: state.engineState.startingEquityUsd - notionalUsd,
      positions: [{
        mint: MINT,
        symbol: "SOL",
        quantity,
        costBasisUsd: notionalUsd,
        averageFillPriceUsd: fillPriceUsd,
        openedAtMs: NOW,
        lastEntryAtMs: NOW,
        entryLiquidityUsd: 1_000_000,
        lastLiquidityUsd: 1_000_000,
        lastPriceUsd: midPriceUsd,
        highestPriceUsd: midPriceUsd,
        lastImpactPct: 0.2,
      }],
      trades: [{
        id: "paper-1",
        mint: MINT,
        symbol: "SOL",
        side: "BUY",
        quantity,
        midPriceUsd,
        fillPriceUsd,
        notionalUsd,
        feeUsd,
        impactCostUsd: quantity * (fillPriceUsd - midPriceUsd),
        cashFlowUsd: -notionalUsd,
        realizedPnlUsd: 0,
        reason: "manual_entry",
        timestampMs: NOW,
      }],
      nextTradeSequence: 2,
    },
    automationSettings: { ...state.automationSettings, enabled: true },
    orderSizeUsd: 100,
    killSwitch: true,
  };
}

function legacyAccount(withLedger = false) {
  return {
    startingEquityUsd: 25_000,
    cashUsd: withLedger ? 24_975 : 25_000,
    positions: withLedger ? [{
      mint: MINT,
      symbol: "SOL",
      quantity: 0.14,
      averagePriceUsd: 178.1,
      lastPriceUsd: 179.2,
      openedAt: "2026-08-21T10:00:00.000Z",
    }] : [],
    trades: withLedger ? [{
      id: "paper-1787306400000-1",
      mint: MINT,
      symbol: "SOL",
      side: "BUY",
      quantity: 0.14,
      fillPriceUsd: 178.1,
      notionalUsd: 25,
      feeUsd: 0.0875,
      timestamp: "2026-08-21T10:00:00.000Z",
    }] : [],
    realizedPnlUsd: 0,
  };
}

function v9Settings(settings: PersistedPaperState["automationSettings"]): Record<string, unknown> {
  const previous = { ...settings } as Record<string, unknown>;
  delete previous.exitShortMomentumBelowPct;
  delete previous.exitShortVolumeGrowthBelowPct;
  delete previous.momentumBreakCooldownMinutes;
  return previous;
}

describe("paper state persistence", () => {
  it("builds independent defaults from the engine and automation defaults", () => {
    const storage = new MemoryStorage();
    const first = loadPaperState(storage, NOW);
    const second = loadPaperState(storage, NOW);

    expect(first).toEqual({ state: createDefaultPaperState(NOW), source: "default", issue: null });
    expect(first.state).not.toBe(second.state);
    expect(first.state.engineState.positions).not.toBe(second.state.engineState.positions);
    expect(first.state.engineState.startingEquityUsd).toBe(DEFAULT_PAPER_AUTOMATION_SETTINGS.portfolioBudgetUsd);
    expect(first.state.automationSettings).toEqual(DEFAULT_PAPER_AUTOMATION_SETTINGS);
    expect(first.state.automationSettings).not.toBe(DEFAULT_PAPER_AUTOMATION_SETTINGS);
  });

  it("writes a v10 allowlisted envelope and round-trips canonical engine state", () => {
    const storage = new MemoryStorage();
    const state = populatedState();

    expect(savePaperState(state, storage, NOW)).toBe(true);
    const raw = storage.getItem(PAPER_STORAGE_KEY)!;
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    expect(envelope.version).toBe(PAPER_STORAGE_VERSION);
    expect(Object.keys(envelope).sort()).toEqual(["paper", "savedAt", "version"]);
    expect(loadPaperState(storage, NOW)).toEqual({ state, source: "stored", issue: null });
  });

  it.each([
    ["launch-flow", -0.2, -5, 7],
    ["pump-scalp", -100, -100, 0],
    ["conservative", -100, -100, 0],
  ] as const)("migrates v9 %s settings without losing customisation or resuming automation", (strategyId, priceExit, volumeExit, delay) => {
    const storage = new MemoryStorage();
    const state = populatedState();
    const previous = v9Settings({
      ...state.automationSettings,
      strategyId,
      stopLossPct: 2.25,
      minLiquidityUsd: 12_345,
      exitBuyRatioBelow: 0.41,
      liquidityDrawdownCooldownMinutes: 27,
      cooldownMinutes: 7,
    });
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: 9,
      savedAt: new Date(NOW).toISOString(),
      paper: { ...state, automationSettings: previous },
    }));

    const result = loadPaperState(storage, NOW);
    expect(result.source).toBe("migrated");
    expect(result.issue).toBeNull();
    expect(result.state.engineState).toEqual(state.engineState);
    expect(result.state.automationSettings).toEqual({
      ...previous,
      enabled: false,
      exitShortMomentumBelowPct: priceExit,
      exitShortVolumeGrowthBelowPct: volumeExit,
      momentumBreakCooldownMinutes: delay,
    });
    expect(savePaperState(result.state, storage, NOW)).toBe(true);
    expect(loadPaperState(storage, NOW).state).toEqual(result.state);
  });

  it("round-trips configured and disabled momentum exits without changing the enabled flag", () => {
    const state = populatedState();
    state.automationSettings.exitShortMomentumBelowPct = -0.8;
    state.automationSettings.exitShortVolumeGrowthBelowPct = -100;
    state.automationSettings.momentumBreakCooldownMinutes = 22.5;
    const storage = new MemoryStorage();
    expect(savePaperState(state, storage, NOW)).toBe(true);
    expect(loadPaperState(storage, NOW).state).toEqual(state);
  });

  it.each([
    ["exitShortMomentumBelowPct", -100.01],
    ["exitShortMomentumBelowPct", Number.NaN],
    ["exitShortVolumeGrowthBelowPct", 1_001],
    ["exitShortVolumeGrowthBelowPct", Number.NEGATIVE_INFINITY],
    ["momentumBreakCooldownMinutes", -1],
    ["momentumBreakCooldownMinutes", 10_081],
  ] as const)("rejects invalid %s values", (field, value) => {
    const state = populatedState();
    state.automationSettings[field] = value;
    expect(savePaperState(state, new MemoryStorage(), NOW)).toBe(false);
  });

  it("sets strategy-specific momentum exits on explicit presets", () => {
    expect(launchFlowSettingsForBudget(400)).toMatchObject({
      enabled: false,
      exitShortMomentumBelowPct: -0.2,
      exitShortVolumeGrowthBelowPct: -5,
      momentumBreakCooldownMinutes: 15,
    });
    expect(pumpScalpSettingsForBudget(400)).toMatchObject({
      enabled: false,
      exitShortMomentumBelowPct: -0.2,
      exitShortVolumeGrowthBelowPct: -100,
      momentumBreakCooldownMinutes: 15,
    });
    expect(conservativeSettingsForBudget(400)).toMatchObject({
      enabled: false,
      exitShortMomentumBelowPct: -100,
      exitShortVolumeGrowthBelowPct: -100,
      momentumBreakCooldownMinutes: 0,
    });
    const runner = launchRunnerSettingsForBudget(400);
    expect(runner).toMatchObject({
      enabled: false,
      strategyId: "launch-flow",
      takeProfitPct: 0,
      stopLossPct: 5,
      trailingStopPct: 8,
      maxHoldMinutes: 45,
      exitShortMomentumBelowPct: -2,
      exitShortVolumeGrowthBelowPct: -15,
      minShortVolumeGrowthPct: 5,
      momentumBreakCooldownMinutes: 15,
    });
    const state = { ...populatedState(), automationSettings: runner };
    const storage = new MemoryStorage();
    expect(savePaperState(state, storage, NOW)).toBe(true);
    expect(loadPaperState(storage, NOW).state.automationSettings).toEqual(runner);
  });

  it("migrates v8 settings with their previous liquidity-exit behavior", () => {
    const storage = new MemoryStorage();
    const state = populatedState();
    const v8Settings = v9Settings(state.automationSettings);
    delete v8Settings.exitLiquidityDrawdownPct;
    delete v8Settings.liquidityDrawdownCooldownMinutes;
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: 8,
      savedAt: "2026-08-21T09:00:00.000Z",
      paper: { ...state, automationSettings: v8Settings },
    }));

    const result = loadPaperState(storage, NOW);
    expect(result.source).toBe("migrated");
    expect(result.issue).toBeNull();
    expect(result.state.engineState).toEqual(state.engineState);
    expect(result.state.automationSettings.exitLiquidityDrawdownPct).toBe(15);
    expect(result.state.automationSettings.liquidityDrawdownCooldownMinutes).toBe(5);
  });

  it("migrates v7 settings with their previous derived exit and cooldown behavior", () => {
    const storage = new MemoryStorage();
    const state = populatedState();
    const v7Settings = v9Settings(state.automationSettings);
    delete v7Settings.exitBuyRatioBelow;
    delete v7Settings.buyRatioDeteriorationCooldownMinutes;
    delete v7Settings.exitLiquidityDrawdownPct;
    delete v7Settings.liquidityDrawdownCooldownMinutes;
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: 7,
      savedAt: "2026-08-21T09:00:00.000Z",
      paper: { ...state, automationSettings: v7Settings },
    }));

    const result = loadPaperState(storage, NOW);
    expect(result.source).toBe("migrated");
    expect(result.issue).toBeNull();
    expect(result.state.engineState).toEqual(state.engineState);
    expect(result.state.automationSettings.exitBuyRatioBelow).toBe(0.43);
    expect(result.state.automationSettings.buyRatioDeteriorationCooldownMinutes).toBe(5);
  });

  it("migrates v6 settings with volume-growth gating disabled", () => {
    const storage = new MemoryStorage();
    const state = populatedState();
    const v6Settings = v9Settings(state.automationSettings);
    delete v6Settings.minShortVolumeGrowthPct;
    delete v6Settings.exitBuyRatioBelow;
    delete v6Settings.buyRatioDeteriorationCooldownMinutes;
    delete v6Settings.exitLiquidityDrawdownPct;
    delete v6Settings.liquidityDrawdownCooldownMinutes;
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: 6,
      savedAt: "2026-08-21T09:00:00.000Z",
      paper: { ...state, automationSettings: v6Settings },
    }));

    const result = loadPaperState(storage, NOW);
    expect(result.source).toBe("migrated");
    expect(result.issue).toBeNull();
    expect(result.state.engineState).toEqual(state.engineState);
    expect(result.state.automationSettings.minShortVolumeGrowthPct).toBe(0);
  });

  it("migrates v5 settings with the new elevated-risk opt-in disabled", () => {
    const storage = new MemoryStorage();
    const state = populatedState();
    const v5Settings = v9Settings(state.automationSettings);
    delete v5Settings.allowHighRiskPaperEntries;
    delete v5Settings.minShortVolumeGrowthPct;
    delete v5Settings.exitBuyRatioBelow;
    delete v5Settings.buyRatioDeteriorationCooldownMinutes;
    delete v5Settings.exitLiquidityDrawdownPct;
    delete v5Settings.liquidityDrawdownCooldownMinutes;
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: 5,
      savedAt: "2026-08-21T09:00:00.000Z",
      paper: { ...state, automationSettings: v5Settings },
    }));

    const result = loadPaperState(storage, NOW);
    expect(result.source).toBe("migrated");
    expect(result.issue).toBeNull();
    expect(result.state.engineState).toEqual(state.engineState);
    expect(result.state.automationSettings.allowHighRiskPaperEntries).toBe(false);
  });

  it("migrates the old hidden v4 position cap into the new visible setting", () => {
    const storage = new MemoryStorage();
    const state = populatedState();
    const v4Settings = {
      ...v9Settings(state.automationSettings),
      strategyId: "pump-scalp",
    } as Record<string, unknown>;
    delete v4Settings.maxOpenPositions;
    delete v4Settings.allowHighRiskPaperEntries;
    delete v4Settings.minShortVolumeGrowthPct;
    delete v4Settings.exitBuyRatioBelow;
    delete v4Settings.buyRatioDeteriorationCooldownMinutes;
    delete v4Settings.exitLiquidityDrawdownPct;
    delete v4Settings.liquidityDrawdownCooldownMinutes;
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: 4,
      savedAt: "2026-08-21T09:00:00.000Z",
      paper: { ...state, automationSettings: v4Settings },
    }));

    const result = loadPaperState(storage, NOW);
    expect(result.source).toBe("migrated");
    expect(result.issue).toBeNull();
    expect(result.state.engineState).toEqual(state.engineState);
    expect(result.state.automationSettings.strategyId).toBe("pump-scalp");
    expect(result.state.automationSettings.maxOpenPositions).toBe(1);
  });

  it("migrates a populated v3 ledger into the conservative strategy without losing history", () => {
    const storage = new MemoryStorage();
    const state = populatedState();
    const v3Settings = v9Settings(state.automationSettings);
    for (const key of [
      "strategyId",
      "maxOpenPositions",
      "allowHighRiskPaperEntries",
      "minTokenAgeMinutes",
      "maxTokenAgeMinutes",
      "minMomentum5mPct",
      "maxMomentum5mPct",
      "minShortMomentumPct",
      "maxShortMomentumPct",
      "minShortVolumeGrowthPct",
      "minVolumeToLiquidity",
      "exitBuyRatioBelow",
      "buyRatioDeteriorationCooldownMinutes",
      "exitLiquidityDrawdownPct",
      "liquidityDrawdownCooldownMinutes",
    ]) delete v3Settings[key];
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: 3,
      savedAt: "2026-08-21T09:00:00.000Z",
      paper: { ...state, automationSettings: v3Settings },
    }));

    const result = loadPaperState(storage, NOW);
    expect(result.source).toBe("migrated");
    expect(result.issue).toBeNull();
    expect(result.state.engineState).toEqual(state.engineState);
    expect(result.state.automationSettings.strategyId).toBe("conservative");
    expect(result.state.automationSettings.maxOpenPositions).toBe(5);
    expect(result.state.automationSettings.minVolumeToLiquidity).toBe(0);
  });

  it("migrates a pristine v2 PaperAccount without inventing engine history", () => {
    const storage = new MemoryStorage();
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: 2,
      savedAt: "2026-08-21T09:00:00.000Z",
      paper: {
        account: legacyAccount(),
        settings: { orderSizeUsd: 100, paperTradingPaused: true },
      },
    }));

    const result = loadPaperState(storage, NOW);
    expect(result.source).toBe("migrated");
    expect(result.issue).toBeNull();
    expect(result.state.engineState.startingEquityUsd).toBe(25_000);
    expect(result.state.engineState.positions).toEqual([]);
    expect(result.state.engineState.trades).toEqual([]);
    expect(result.state.automationSettings).toEqual(DEFAULT_PAPER_AUTOMATION_SETTINGS);
    expect(result.state.orderSizeUsd).toBe(100);
    expect(result.state.killSwitch).toBe(true);
  });

  it("uses an explicit safe fallback for a non-empty v2 ledger", () => {
    const storage = new MemoryStorage();
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: 2,
      savedAt: "2026-08-21T09:00:00.000Z",
      paper: {
        account: legacyAccount(true),
        settings: { orderSizeUsd: 25, paperTradingPaused: false },
      },
    }));

    expect(loadPaperState(storage, NOW)).toEqual({
      state: createDefaultPaperState(NOW),
      source: "migration-fallback",
      issue: "legacy-data-not-migratable",
    });
  });

  it("retains the supported v1 pristine-account migration", () => {
    const storage = new MemoryStorage();
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: 1,
      paperAccount: legacyAccount(),
      orderSizeUsd: 50,
      killSwitch: false,
    }));
    const result = loadPaperState(storage, NOW);
    expect(result.source).toBe("migrated");
    expect(result.state.orderSizeUsd).toBe(50);
  });

  it("falls back safely for corrupt JSON, invalid engine data, and future versions", () => {
    const corrupt = new MemoryStorage();
    corrupt.setItem(PAPER_STORAGE_KEY, "{not-json");
    expect(loadPaperState(corrupt, NOW).issue).toBe("corrupt-json");
    expect(loadPaperState(corrupt, NOW).state).toEqual(createDefaultPaperState(NOW));

    const invalid = new MemoryStorage();
    const state = populatedState();
    state.engineState.cashUsd = -1;
    invalid.setItem(PAPER_STORAGE_KEY, JSON.stringify({
      version: PAPER_STORAGE_VERSION,
      savedAt: "2026-08-21T10:00:00.000Z",
      paper: state,
    }));
    expect(loadPaperState(invalid, NOW).issue).toBe("invalid-data");
    expect(loadPaperState(invalid, NOW).source).toBe("default");

    const future = new MemoryStorage();
    future.setItem(PAPER_STORAGE_KEY, JSON.stringify({ version: 99 }));
    expect(loadPaperState(future, NOW).issue).toBe("unsupported-version");
  });

  it("refuses secret-bearing fields without overwriting good state", () => {
    const storage = new MemoryStorage();
    expect(savePaperState(populatedState(), storage, NOW)).toBe(true);
    const original = storage.getItem(PAPER_STORAGE_KEY);
    const state = populatedState();
    const polluted = {
      ...state,
      engineState: { ...state.engineState, privateKey: "must-not-be-written" },
      walletSecret: "must-not-be-written",
    };

    expect(savePaperState(polluted, storage, NOW)).toBe(false);
    expect(storage.getItem(PAPER_STORAGE_KEY)).toBe(original);
    expect(storage.getItem(PAPER_STORAGE_KEY)).not.toContain("must-not-be-written");
  });

  it("rejects inconsistent engine accounting and duplicate positions", () => {
    const storage = new MemoryStorage();
    const inconsistent = populatedState();
    inconsistent.engineState.cashUsd += 10;
    expect(savePaperState(inconsistent, storage, NOW)).toBe(false);

    const duplicate = populatedState();
    duplicate.engineState.positions.push({ ...duplicate.engineState.positions[0] });
    expect(savePaperState(duplicate, storage, NOW)).toBe(false);
  });

  it("rejects invalid automation relationships", () => {
    const storage = new MemoryStorage();
    const state = populatedState();
    state.automationSettings.minBuyRatio = 0.9;
    state.automationSettings.maxBuyRatio = 0.2;
    expect(savePaperState(state, storage, NOW)).toBe(false);

    const fractionalLimit = populatedState();
    fractionalLimit.automationSettings.maxOpenPositions = 1.5;
    expect(savePaperState(fractionalLimit, storage, NOW)).toBe(false);

    const invalidRiskOptIn = populatedState() as unknown as {
      automationSettings: { allowHighRiskPaperEntries: unknown };
    };
    invalidRiskOptIn.automationSettings.allowHighRiskPaperEntries = "yes";
    expect(savePaperState(invalidRiskOptIn, storage, NOW)).toBe(false);
  });

  it("clears saved state and contains storage failures", () => {
    const storage = new MemoryStorage();
    expect(savePaperState(populatedState(), storage, NOW)).toBe(true);
    expect(clearPaperState(storage)).toBe(true);
    expect(storage.getItem(PAPER_STORAGE_KEY)).toBeNull();

    const broken: PaperStorage = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
    };
    expect(loadPaperState(broken, NOW).issue).toBe("storage-read-failed");
    expect(savePaperState(populatedState(), broken, NOW)).toBe(false);
    expect(clearPaperState(broken)).toBe(false);
    expect(loadPaperState(null, NOW).issue).toBe("storage-unavailable");
  });
});

describe("approved illiquid paper write-offs", () => {
  it("preserves cash and history, records zero proceeds, frees slots and retains the daily stop", () => {
    const paper = populatedState();
    const before = paper.engineState;
    const approvals = before.positions.map(p => ({ ...p }));
    const after = applyPaperWriteoffs(before, approvals, NOW + 1000, 8);
    expect(after.cashUsd).toBe(before.cashUsd);
    expect(after.realizedPnlUsd).toBe(before.realizedPnlUsd - 25);
    expect(after.positions).toEqual([]);
    expect(after.trades.slice(0, before.trades.length)).toEqual(before.trades);
    expect(after.trades.at(-1)).toMatchObject({ side: "SELL", reason: "illiquid_writeoff", cashFlowUsd: 0, notionalUsd: 0, fillPriceUsd: 0, realizedPnlUsd: -25 });
    expect(after.dailyLossLockedDay).toBe("2026-08-21");
    expect(applyPaperWriteoffs(after, approvals, NOW + 2000, 8)).toBe(after);
    const storage = new MemoryStorage();
    const adjusted = { ...paper, engineState: after };
    expect(savePaperState(adjusted, storage, NOW + 1000)).toBe(true);
    expect(loadPaperState(storage, NOW + 1000).state).toEqual(adjusted);
    const forged = { ...adjusted, engineState: { ...after, trades: after.trades.map(t => t.reason === "illiquid_writeoff" ? { ...t, reason: "manual_exit" } : t) } };
    expect(savePaperState(forged, storage, NOW + 1000)).toBe(false);
  });
  it("does not apply an old approval to a later or resized position", () => {
    const state = populatedState().engineState;
    const position = state.positions[0];
    for (const approval of [{ ...position, openedAtMs: NOW - 1 }, { ...position, quantity: position.quantity + 1 }, { ...position, costBasisUsd: 24 }]) {
      expect(applyPaperWriteoffs(state, [approval], NOW, 8)).toBe(state);
    }
  });
  it("migrates schema 10 without resetting settings, holdings or history", () => {
    const state = populatedState();
    const storage = new MemoryStorage();
    storage.setItem(PAPER_STORAGE_KEY, JSON.stringify({ version: 10, savedAt: new Date(NOW).toISOString(), paper: state }));
    expect(loadPaperState(storage, NOW)).toEqual({ state, source: "migrated", issue: null });
  });
});
