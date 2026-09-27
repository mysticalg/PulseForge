import { describe, expect, it } from "vitest";
import { nextListKey } from "./useListKeyboardNavigation";

describe("list keyboard navigation", () => {
  const keys = ["a", "b", "c"];

  it("starts at the nearest end when no row is active", () => {
    expect(nextListKey(keys, null, 1)).toBe("a");
    expect(nextListKey(keys, null, -1)).toBe("c");
  });

  it("moves one row and clamps at the list boundaries", () => {
    expect(nextListKey(keys, "a", 1)).toBe("b");
    expect(nextListKey(keys, "c", 1)).toBe("c");
    expect(nextListKey(keys, "a", -1)).toBe("a");
  });

  it("returns null for an empty list", () => {
    expect(nextListKey([], null, 1)).toBeNull();
  });
});
