import { ArrowDown, ArrowUp, ArrowUpDown, RotateCcw } from "lucide-react";
import type { SortDirection } from "../lib/sorting";

export function SortHeader({
  label,
  active,
  direction,
  onSort,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
}) {
  return (
    <button
      type="button"
      className={`sort-header ${active ? "is-active" : ""}`}
      onClick={onSort}
      aria-label={`Sort by ${label}${active ? `, currently ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
    >
      <span>{label}</span>
      {active ? direction === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : <ArrowUpDown size={11} />}
    </button>
  );
}

export function SortReset({ active, onReset, label = "Reset sort" }: { active: boolean; onReset: () => void; label?: string }) {
  return (
    <button type="button" className="sort-reset" onClick={onReset} disabled={!active} title={label}>
      <RotateCcw size={12} />
      <span>{label}</span>
    </button>
  );
}
