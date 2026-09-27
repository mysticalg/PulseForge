import { describe, expect, it } from "vitest";
import { compareNullableNumber, directedComparison, nextSortState } from "./sorting";

describe("table sorting", () => {
  it("starts in the requested direction and toggles an active column", () => {
    expect(nextSortState(null, "price", "desc")).toEqual({ key: "price", direction: "desc" });
    expect(nextSortState({ key: "price", direction: "desc" }, "price")).toEqual({ key: "price", direction: "asc" });
    expect(nextSortState({ key: "price", direction: "asc" }, "token")).toEqual({ key: "token", direction: "asc" });
  });

  it("reverses comparisons without moving missing values ahead of real metrics", () => {
    expect(directedComparison(4, "desc")).toBe(-4);
    expect(compareNullableNumber(null, 5)).toBeGreaterThan(0);
    expect(compareNullableNumber(5, null)).toBeLessThan(0);
  });
});
