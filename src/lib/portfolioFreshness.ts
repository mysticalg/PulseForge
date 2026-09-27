import type { MarketToken } from "../types";

export function hasFreshPortfolioPrice(token: MarketToken | undefined, nowMs: number): boolean {
  if (!token || !Number.isFinite(nowMs) || !Number.isFinite(token.priceUsd) || token.priceUsd <= 0) return false;
  const at = Date.parse(token.updatedAt);
  return Number.isFinite(at) && at <= nowMs && nowMs - at <= 75_000;
}
