import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../data/demo";
import { refreshHeldLaunches } from "./launchScanner";

const NOW = Date.UTC(2026, 8, 5, 12);
const token = { ...createDemoSnapshot().tokens[0], updatedAt: new Date(NOW).toISOString() };
const market = { ...createDemoSnapshot(), mode: "live" as const, tokens: [] };

describe("held launch monitoring", () => {
  it("batches distinct held mints and matches unordered partial results by mint", async () => {
    const second = { ...token, mint: "second" };
    const fetch = vi.fn();
    const batch = vi.fn().mockResolvedValue([second, { ...token, mint: "unrequested" }, token]);
    const result = await refreshHeldLaunches(market, [token.mint, "second", token.mint, "missing"], fetch, () => NOW, batch);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch).toHaveBeenCalledWith([token.mint, "second", "missing"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.tokens).toEqual([token, second]);
    expect(result.warning).toContain("1 held token(s) unavailable");
  });

  it("a rate-limited batch does not fan out into more individual requests or fresh marks", async () => {
    const fetch = vi.fn();
    const batch = vi.fn().mockRejectedValue(new Error("429"));
    const result = await refreshHeldLaunches(market, [token.mint, "second"], fetch, () => NOW, batch);
    expect(batch).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(result.tokens).toEqual([]);
    expect(result.warning).toContain("2 held token(s) unavailable");
  });

  it("refreshes a held mint missing from discovery only once", async () => {
    const fetch = vi.fn().mockResolvedValue(token);
    const result = await refreshHeldLaunches(market, [token.mint, token.mint], fetch, () => NOW);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.tokens).toEqual([token]);
  });

  it("uses fresh discovery marks without additional requests", async () => {
    const fetch = vi.fn();
    const result = await refreshHeldLaunches({ ...market, tokens: [token] }, [token.mint], fetch, () => NOW);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.tokens).toEqual([token]);
  });

  it("replaces old cached held rows with a current direct lookup", async () => {
    const old = { ...token, priceUsd: 0.1, updatedAt: new Date(NOW - 20_000).toISOString() };
    const result = await refreshHeldLaunches({ ...market, tokens: [old] }, [token.mint], vi.fn().mockResolvedValue(token), () => NOW);
    expect(result.tokens).toEqual([token]);
  });

  it.each([
    { ...token, mint: "wrong-mint" },
    { ...token, updatedAt: new Date(NOW - 80_000).toISOString() },
    { ...token, updatedAt: new Date(NOW + 1).toISOString() },
    { ...token, updatedAt: "" },
    { ...token, priceUsd: NaN },
  ])("never invents a fresh exit mark from invalid provider data", async (invalid) => {
    const result = await refreshHeldLaunches(market, [token.mint], vi.fn().mockResolvedValue(invalid), () => NOW);
    expect(result.tokens).toEqual([]);
    expect(result.warning).toContain("1 held token(s) unavailable");
  });

  it("retains other usable marks when one lookup fails", async () => {
    const fetch = vi.fn(async (mint: string) => {
      if (mint === token.mint) return token;
      throw new Error("offline");
    });
    const result = await refreshHeldLaunches(market, [token.mint, "missing"], fetch, () => NOW);
    expect(result.tokens).toEqual([token]);
    expect(result.warning).toContain("1 held token(s) unavailable");
  });

  it("does not mix provider tokens into the demo feed", async () => {
    const fetch = vi.fn();
    const demo = { ...market, mode: "demo" as const };
    expect(await refreshHeldLaunches(demo, [token.mint], fetch)).toBe(demo);
    expect(fetch).not.toHaveBeenCalled();
  });
});
