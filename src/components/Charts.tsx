import { useMemo } from "react";
import type { MarketToken } from "../types";
import { formatPrice } from "../lib/strategy";

function hash(value: string) {
  return [...value].reduce((total, char) => ((total << 5) - total + char.charCodeAt(0)) | 0, 0);
}

function seriesFor(token: MarketToken, length: number) {
  let state = Math.abs(hash(token.mint)) || 19;
  const values: number[] = [];
  let value = token.priceUsd * 0.965;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const noise = ((state / 0xffff_ffff) - 0.49) * token.priceUsd * 0.012;
    const drift = token.priceUsd * (0.0005 + token.change5mPct / 100 / length);
    value = Math.max(token.priceUsd * 0.75, value + noise + drift);
    values.push(value);
  }
  const delta = token.priceUsd - values[values.length - 1];
  return values.map((point, index) => point + (delta * index) / (length - 1));
}

function pathFor(values: number[], width: number, height: number, padding = 4) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((value, index) => {
      const x = padding + (index / (values.length - 1)) * (width - padding * 2);
      const y = height - padding - ((value - min) / range) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function Sparkline({ token, width = 178, height = 56 }: { token: MarketToken; width?: number; height?: number }) {
  const values = useMemo(() => seriesFor(token, 32), [token]);
  const path = pathFor(values, width, height, 3);
  const color = token.change5mPct >= 0 ? "var(--cyan)" : "var(--red)";
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${token.symbol} price trend`}>
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function PriceChart({ token }: { token: MarketToken }) {
  const values = useMemo(() => seriesFor(token, 58), [token]);
  const width = 760;
  const height = 256;
  const padding = 26;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const path = pathFor(values, width, height, padding);
  const area = `${path} L${width - padding},${height - padding} L${padding},${height - padding} Z`;

  return (
    <div className="price-chart">
      <div className="chart-heading">
        <div>
          <strong>{token.symbol}/USD · 5m · paper mark</strong>
          <span>
            O {formatPrice(values[0])} &nbsp; H {formatPrice(max)} &nbsp; L {formatPrice(min)} &nbsp; C {formatPrice(token.priceUsd)}
          </span>
        </div>
        <span className="volume-label">Volume 5m {Math.round(token.volume5mUsd).toLocaleString()}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${token.symbol} deterministic paper chart`}>
        <defs>
          <linearGradient id="chart-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--cyan)" stopOpacity="0.16" />
            <stop offset="1" stopColor="var(--cyan)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.2, 0.4, 0.6, 0.8].map((ratio) => (
          <line
            key={ratio}
            x1={padding}
            x2={width - padding}
            y1={padding + ratio * (height - padding * 2)}
            y2={padding + ratio * (height - padding * 2)}
            stroke="var(--grid)"
            strokeWidth="1"
          />
        ))}
        {values.filter((_, index) => index % 4 === 0).map((value, index) => {
          const x = padding + ((index * 4) / (values.length - 1)) * (width - padding * 2);
          const bar = 8 + ((index * 17) % 26);
          const positive = value >= (values[Math.max(0, index * 4 - 1)] ?? value);
          return (
            <rect
              key={`${index}-${value}`}
              x={x - 2}
              y={height - padding - bar}
              width="4"
              height={bar}
              fill={positive ? "var(--green)" : "var(--red)"}
              opacity="0.42"
            />
          );
        })}
        <path d={area} fill="url(#chart-area)" />
        <path d={path} fill="none" stroke="var(--cyan)" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
        <line
          x1={padding}
          x2={width - padding}
          y1={height / 2}
          y2={height / 2}
          stroke="var(--cyan)"
          strokeDasharray="3 4"
          opacity="0.4"
        />
      </svg>
    </div>
  );
}
