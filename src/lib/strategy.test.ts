import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "../data/demo";
import { comparePaperOpportunity, DEFAULT_PAPER_ACCOUNT, estimateQuote, executePaperBuy, markAccount } from "./strategy";

describe("paper trading safety gates", () => {
  const tokens = createDemoSnapshot().tokens;

  it("blocks an oversized canary order", () => {
    const quote = estimateQuote(tokens[0], 500);
    expect(quote.canPaperTrade).toBe(false);
    expect(quote.blockers.join(" ")).toContain("Canary limit");
  });

  it("blocks a token with active authorities", () => {
    const token = tokens.find((row) => row.symbol === "MINTY")!;
    const quote = estimateQuote(token, 25);
    expect(quote.canPaperTrade).toBe(false);
    expect(quote.blockers.join(" ")).toContain("authorities");
  });

  it("uses the configured impact and liquidity limits for quote preflight", () => {
    const token = { ...tokens.find((row) => row.symbol === "GIGAOWL")!, liquidityUsd: 15_000 };
    const fixedDefaults = estimateQuote(token, 25);
    const configured = estimateQuote(token, 25, 2.2, 10_000);
    expect(fixedDefaults.canPaperTrade).toBe(false);
    expect(configured.priceImpactPct).toBeGreaterThan(0.75);
    expect(configured.canPaperTrade).toBe(true);
  });

  it("books a safe paper fill without creating cash", () => {
    const token = tokens.find((row) => row.symbol === "GIGAOWL")!;
    const quote = estimateQuote(token, 25);
    expect(quote.canPaperTrade).toBe(true);
    const account = executePaperBuy(DEFAULT_PAPER_ACCOUNT, token, quote);
    const marked = markAccount(account, tokens);
    expect(account.cashUsd).toBe(DEFAULT_PAPER_ACCOUNT.cashUsd - 25);
    expect(account.positions).toHaveLength(1);
    expect(marked.equityUsd).toBeLessThanOrEqual(DEFAULT_PAPER_ACCOUNT.startingEquityUsd);
  });

  it("ranks a $25 paper-eligible candidate ahead of an unsafe recent token", () => {
    const unsafe = tokens.find((row) => row.symbol === "PIXELPUP")!;
    const safe = tokens.find((row) => row.symbol === "GIGAOWL")!;
    expect([unsafe, safe].sort(comparePaperOpportunity)[0].mint).toBe(safe.mint);
  });
});
