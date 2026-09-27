export type SortDirection = "asc" | "desc";

export interface SortState<Key extends string> {
  key: Key;
  direction: SortDirection;
}

export function nextSortState<Key extends string>(
  current: SortState<Key> | null,
  key: Key,
  initialDirection: SortDirection = "asc",
): SortState<Key> {
  if (current?.key !== key) return { key, direction: initialDirection };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

export function directedComparison(comparison: number, direction: SortDirection): number {
  return direction === "asc" ? comparison : -comparison;
}

export function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}
