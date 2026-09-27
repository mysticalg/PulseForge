import { expect, it } from "vitest";
import type { MarketToken } from "../types";
import { hasFreshPortfolioPrice } from "./portfolioFreshness";
it("requires a finite positive and recent portfolio price, with no future timestamps", () => {
  const now = Date.UTC(2026, 8, 6);
  const token = (price: number, age: number) => ({ priceUsd: price, updatedAt: new Date(now - age).toISOString() } as MarketToken);
  expect(hasFreshPortfolioPrice(token(1, 75000), now)).toBe(true);
  for (const t of [undefined, token(1, 75001), token(1, -1), token(0, 0), token(NaN, 0), token(Infinity, 0)]) expect(hasFreshPortfolioPrice(t, now)).toBe(false);
});
