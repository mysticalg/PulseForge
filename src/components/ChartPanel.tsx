import { Activity, ArrowDownRight, ArrowUpRight, CircleAlert, Info } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { seedEvents } from "../data/demo";
import { compareText, directedComparison, nextSortState, type SortState } from "../lib/sorting";
import { formatMoney, formatPrice } from "../lib/strategy";
import type { MarketToken, PaperTrade } from "../types";
import { PriceChart } from "./Charts";
import { SortHeader, SortReset } from "./SortControls";

interface Props {
  token: MarketToken;
  trades: PaperTrade[];
}

export function ChartPanel({ token, trades }: Props) {
  const [chartTab, setChartTab] = useState("Chart");
  const [logTab, setLogTab] = useState<"events" | "trades">("events");
  const [logSort, setLogSort] = useState<SortState<LogSortKey> | null>(null);
  const events = useMemo(() => seedEvents(token), [token]);
  const logRows = useMemo<LogRow[]>(() => {
    const rows: LogRow[] = logTab === "events"
      ? events.map((event) => ({
          id: event.id,
          time: event.time,
          timeOrder: timeToSeconds(event.time),
          event: event.event,
          detail: event.detail,
          kind: event.kind,
          icon: event.kind === "positive" ? <ArrowUpRight size={13} /> : event.kind === "danger" ? <ArrowDownRight size={13} /> : event.kind === "warning" ? <CircleAlert size={13} /> : <Info size={13} />,
        }))
      : trades.map((trade) => ({
          id: trade.id,
          time: new Date(trade.timestamp).toLocaleTimeString("en-GB", { hour12: false }),
          timeOrder: new Date(trade.timestamp).getTime(),
          event: `${trade.side} ${trade.symbol}`,
          detail: `${formatMoney(trade.notionalUsd, 2)} · ${trade.reason.replaceAll("_", " ")}`,
          kind: trade.side === "BUY" || trade.realizedPnlUsd >= 0 ? "positive" : "danger",
          icon: trade.side === "BUY" ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />,
        }));
    if (logSort === null) return rows;
    return rows.sort((a, b) => {
      const comparison = logSort.key === "time"
        ? a.timeOrder - b.timeOrder
        : compareText(a[logSort.key], b[logSort.key]);
      return directedComparison(comparison, logSort.direction) || compareText(a.id, b.id);
    });
  }, [events, logSort, logTab, trades]);

  return (
    <section className="chart-panel">
      <div className="chart-tabs">
        {["Chart", "Depth", "Orders", "Trades", "Holders", "Info"].map((tab) => (
          <button className={chartTab === tab ? "is-active" : ""} key={tab} onClick={() => setChartTab(tab)}>{tab}</button>
        ))}
        <div className="chart-controls"><button>5m⌄</button><button>Indicators</button></div>
      </div>
      <div className="chart-body">
        <div className="chart-canvas">
          {chartTab === "Chart" ? (
            <PriceChart token={token} />
          ) : (
            <div className="chart-empty">
              <Activity size={26} />
              <strong>{chartTab} requires a configured low-latency stream</strong>
              <span>The deterministic demo intentionally does not invent live order-book data.</span>
            </div>
          )}
        </div>
        <div className="event-log">
          <div className="event-tabs">
            <button className={logTab === "events" ? "is-active" : ""} onClick={() => setLogTab("events")}>Event log</button>
            <button className={logTab === "trades" ? "is-active" : ""} onClick={() => setLogTab("trades")}>Trade log</button>
            <SortReset active={logSort !== null} onReset={() => setLogSort(null)} label="Reset" />
          </div>
          <div className="log-head">
            <SortHeader label="Time (UTC)" active={logSort?.key === "time"} direction={logSort?.direction ?? "desc"} onSort={() => setLogSort(nextSortState(logSort, "time", "desc"))} />
            <SortHeader label="Event" active={logSort?.key === "event"} direction={logSort?.direction ?? "asc"} onSort={() => setLogSort(nextSortState(logSort, "event"))} />
            <SortHeader label="Detail" active={logSort?.key === "detail"} direction={logSort?.direction ?? "asc"} onSort={() => setLogSort(nextSortState(logSort, "detail"))} />
          </div>
          <div className="log-rows">
            {logRows.length > 0 ? logRows.map((row) => (
              <div className={`log-row log-${row.kind}`} key={row.id}>
                <span>{row.time}</span>
                <span>{row.icon}{row.event}</span>
                <span>{row.detail}</span>
              </div>
            )) : <div className="log-empty">No paper trades yet.</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

type LogSortKey = "time" | "event" | "detail";

interface LogRow {
  id: string;
  time: string;
  timeOrder: number;
  event: string;
  detail: string;
  kind: "info" | "positive" | "warning" | "danger";
  icon: ReactNode;
}

function timeToSeconds(time: string) {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  return hours * 3_600 + minutes * 60 + seconds;
}
