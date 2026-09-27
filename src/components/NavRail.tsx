import {
  BrainCircuit,
  ChartNoAxesCombined,
  FlaskConical,
  LineChart,
  Settings,
  WalletCards,
  Wallet,
} from "lucide-react";
import type { NavView } from "../types";

const items: Array<{ id: NavView; label: string; icon: typeof LineChart }> = [
  { id: "market", label: "Market", icon: ChartNoAxesCombined },
  { id: "signals", label: "Signals", icon: LineChart },
  { id: "positions", label: "Positions", icon: WalletCards },
  { id: "live-wallet", label: "Live wallet", icon: Wallet },
  { id: "models", label: "Models", icon: BrainCircuit },
  { id: "backtests", label: "Strategy Lab", icon: FlaskConical },
  { id: "settings", label: "Settings", icon: Settings },
];

interface Props {
  active: NavView;
  onChange: (view: NavView) => void;
}

export function NavRail({ active, onChange }: Props) {
  return (
    <aside className="nav-rail" aria-label="Primary navigation">
      <button className="wordmark" onClick={() => onChange("market")} aria-label="PulseForge market">
        <span className="wordmark-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>PulseForge</span>
      </button>
      <nav>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={`nav-item ${active === item.id ? "is-active" : ""}`}
              key={item.id}
              onClick={() => onChange(item.id)}
              aria-label={item.label}
              aria-current={active === item.id ? "page" : undefined}
              title={item.label}
            >
              <Icon size={19} strokeWidth={1.7} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="nav-foot">
        <span className="status-dot status-dot--amber" />
        <div>
          <strong>Paper + live wallet</strong>
          <small>v0.10.8 trading engine</small>
        </div>
      </div>
    </aside>
  );
}
