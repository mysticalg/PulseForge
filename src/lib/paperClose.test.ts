import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../data/demo";
import { closePaperPosition, createPaperEngineState, type PaperEnginePosition } from "./paperEngine";
import { resolvePaperCloseMark } from "./paperClose";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

function positionFor(mint: string, symbol: string): PaperEnginePosition {
  return {
    mint,
    symbol,
    quantity: 10,
    costBasisUsd: 25,
    averageFillPriceUsd: 2.5,
    openedAtMs: NOW - 60_000,
    lastEntryAtMs: NOW - 60_000,
    entryLiquidityUsd: 100_000,
    lastLiquidityUsd: 90_000,
    lastPriceUsd: 3,
    highestPriceUsd: 3.2,
    lastImpactPct: 0.4,
  };
}

describe("paper close mark resolution", () => {
  const token = { ...createDemoSnapshot().tokens[0], updatedAt: new Date(NOW).toISOString() };
  const position = positionFor(token.mint, token.symbol);

  it("uses the scanner mark without making another provider request", async () => {
    const refresh = vi.fn();
    const resolved = await resolvePaperCloseMark(position, [token], NOW, refresh);
    expect(resolved.source).toBe("scanner");
    expect(resolved.observation.mint).toBe(position.mint);
    expect(resolved.observation.observedAtMs).toBe(NOW);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes an out-of-scanner held mint directly from the provider", async () => {
    const refreshed = { ...token, priceUsd: 3.1, updatedAt: new Date(NOW).toISOString() };
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const resolved = await resolvePaperCloseMark(position, [], NOW, refresh);
    expect(resolved.source).toBe("provider");
    expect(resolved.observation.priceUsd).toBe(3.1);
    expect(refresh).toHaveBeenCalledWith(position.mint);
  });

  it("allows an out-of-scanner position to close at its labelled last mark when lookup fails", async () => {
    const resolved = await resolvePaperCloseMark(
      position,
      [],
      NOW,
      vi.fn().mockRejectedValue(new Error("provider unavailable")),
    );
    expect(resolved.source).toBe("last-recorded");
    expect(resolved.observation.source).toBe("paper-last-recorded-mark");
    expect(resolved.observation.priceUsd).toBe(position.lastPriceUsd);

    const startingState = {
      ...createPaperEngineState(100, NOW - 60_000),
      cashUsd: 75,
      positions: [position],
    };
    const closed = closePaperPosition(startingState, resolved.observation, 100, NOW);
    expect(closed.positions).toHaveLength(0);
    expect(closed.trades.at(-1)?.reason).toBe("manual_100");
  });
});
