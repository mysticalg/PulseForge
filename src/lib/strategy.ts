import type { MarketToken, PaperAccount, PaperTrade, QuoteEstimate } from "../types";

export const DEFAULT_PAPER_ACCOUNT: PaperAccount = {
  startingEquityUsd: 25_000,
  cashUsd: 25_000,
  positions: [],
  trades: [],
  realizedPnlUsd: 0,
};

export function estimateQuote(
  token: MarketToken,
  inputUsd: number,
  maxPriceImpactPct = 0.75,
  minLiquidityUsd = 50_000,
): QuoteEstimate {
  const size = Math.min(100_000, Math.max(0, Number.isFinite(inputUsd) ? inputUsd : 0));
  const priceImpactPct = Math.min(25, Math.max(0.02, Math.sqrt(size / Math.max(1, token.liquidityUsd)) * 20));
  const feeUsd = size * 0.0035;
  const expectedPriceUsd = token.priceUsd * (1 + priceImpactPct / 100);
  const expectedTokens = expectedPriceUsd > 0 ? Math.max(0, size - feeUsd) / expectedPriceUsd : 0;
  const blockers: string[] = [];

  if (size < 5) blockers.push("Minimum paper order is $5");
  if (size > 250) blockers.push("Canary limit is $250 per new-token order");
  if (priceImpactPct > maxPriceImpactPct) blockers.push(`Estimated price impact ${priceImpactPct.toFixed(2)}% exceeds configured ${maxPriceImpactPct}%`);
  if (token.liquidityUsd < minLiquidityUsd) blockers.push(`Liquidity is below $${minLiquidityUsd}`);
  if (!token.safety.mintAuthorityRevoked || !token.safety.freezeAuthorityRevoked) {
    blockers.push("Token authorities are not fully revoked");
  }
  if (token.safety.topTenHolderPct > 35) blockers.push("Top-holder concentration exceeds 35%");
  if (token.safety.transferTaxPct > 1) blockers.push("Transfer tax exceeds 1%");

  return {
    inputUsd: size,
    expectedPriceUsd,
    expectedTokens,
    priceImpactPct,
    feeUsd,
    route: token.source === "Jupiter Tokens V2" ? "Jupiter discovery · simulated fill" : "Deterministic paper broker",
    canPaperTrade: blockers.length === 0,
    blockers,
  };
}

export function executePaperBuy(account: PaperAccount, token: MarketToken, quote: QuoteEstimate): PaperAccount {
  if (!quote.canPaperTrade) throw new Error("Paper order is blocked by a safety gate");
  const debit = quote.inputUsd;
  if (debit > account.cashUsd) throw new Error("Insufficient paper cash");

  const timestamp = new Date().toISOString();
  const existing = account.positions.find((position) => position.mint === token.mint);
  const positions = existing
    ? account.positions.map((position) => {
        if (position.mint !== token.mint) return position;
        const quantity = position.quantity + quote.expectedTokens;
        return {
          ...position,
          quantity,
          averagePriceUsd:
            (position.quantity * position.averagePriceUsd + quote.expectedTokens * quote.expectedPriceUsd) / quantity,
          lastPriceUsd: token.priceUsd,
        };
      })
    : [
        ...account.positions,
        {
          mint: token.mint,
          symbol: token.symbol,
          quantity: quote.expectedTokens,
          averagePriceUsd: quote.expectedPriceUsd,
          lastPriceUsd: token.priceUsd,
          openedAt: timestamp,
        },
      ];

  const trade: PaperTrade = {
    id: `paper-${Date.now()}-${account.trades.length + 1}`,
    mint: token.mint,
    symbol: token.symbol,
    side: "BUY",
    quantity: quote.expectedTokens,
    fillPriceUsd: quote.expectedPriceUsd,
    notionalUsd: quote.inputUsd,
    feeUsd: quote.feeUsd,
    impactCostUsd: Math.max(0, quote.expectedTokens * (quote.expectedPriceUsd - token.priceUsd)),
    realizedPnlUsd: 0,
    reason: "manual_entry",
    timestamp,
  };

  return {
    ...account,
    cashUsd: account.cashUsd - debit,
    positions,
    trades: [trade, ...account.trades],
  };
}

export function comparePaperOpportunity(a: MarketToken, b: MarketToken) {
  const eligibility = Number(estimateQuote(b, 25).canPaperTrade) - Number(estimateQuote(a, 25).canPaperTrade);
  if (eligibility !== 0) return eligibility;
  return b.modelScore - a.modelScore || b.liquidityUsd - a.liquidityUsd || a.mint.localeCompare(b.mint);
}

export function markAccount(account: PaperAccount, tokens: MarketToken[]) {
  const lookup = new Map(tokens.map((token) => [token.mint, token.priceUsd]));
  const positions = account.positions.map((position) => ({
    ...position,
    lastPriceUsd: lookup.get(position.mint) ?? position.lastPriceUsd,
  }));
  const marketValueUsd = positions.reduce((total, position) => total + position.quantity * position.lastPriceUsd, 0);
  const unrealizedPnlUsd = positions.reduce(
    (total, position) => total + position.quantity * (position.lastPriceUsd - position.averagePriceUsd),
    0,
  );
  return {
    account: { ...account, positions },
    equityUsd: account.cashUsd + marketValueUsd,
    unrealizedPnlUsd,
  };
}

export function formatMoney(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  }).format(value);
}

export function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export function formatPrice(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(6);
  return value.toPrecision(4);
}

export function formatAge(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}
