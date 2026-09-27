import { Radio, ShieldAlert, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { MarketSnapshot } from "../types";

interface Props {
  snapshot: MarketSnapshot;
  killSwitch: boolean;
  onKillSwitch: () => void;
  liveArmed?: boolean;
}

function utcClock() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" });
}

export function TopBar({ snapshot, killSwitch, onKillSwitch, liveArmed = false }: Props) {
  const [clock, setClock] = useState(utcClock());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(utcClock()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <header className="top-bar">
      <div className="mode-lockup">
        <ShieldAlert size={18} />
        <span className={liveArmed ? "text-danger" : ""}>{liveArmed ? "LIVE SIGNING ARMED" : "LIVE WALLET OFF"}</span>
      </div>
      <div className="top-metric">
        <span>Feed latency</span>
        <strong className={snapshot.mode === "live" ? "text-positive" : "text-amber"}>
          {snapshot.latencyMs} ms
        </strong>
      </div>
      <div className="top-metric top-route">
        <span>Data route</span>
        <strong>
          <Radio size={13} /> {snapshot.provider}
        </strong>
      </div>
      <div className="top-metric top-network">
        <span>Coverage</span>
        <strong>Solana · configured sources</strong>
      </div>
      <div className="top-metric top-clock">
        <span>UTC</span>
        <strong>{clock}</strong>
      </div>
      <button
        className={`kill-switch ${killSwitch ? "is-triggered" : ""}`}
        onClick={onKillSwitch}
        aria-pressed={killSwitch}
        title="Stops live submissions and flattens paper positions. Existing real holdings remain in your wallet; pending transactions may still confirm."
      >
        <Zap size={17} fill="currentColor" />
        <span>
          <strong>{killSwitch ? "TRADING STOPPED" : "KILL SWITCH"}</strong>
          <small>{killSwitch ? "Reset manually" : "Armed"}</small>
        </span>
      </button>
    </header>
  );
}
