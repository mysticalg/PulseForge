export interface LaunchPatternPoint {
  observedAtMs: number;
  priceUsd: number;
  volume5mUsd: number;
  buyRatio: number;
  liquidityUsd: number;
}

export interface LaunchPatternResult {
  pattern: "breakout" | "pullback-reclaim" | null;
  detail: string;
}

const MIN_WINDOW_MS = 30_000;
const MAX_WINDOW_MS = 75_000;
const MAX_SAMPLE_GAP_MS = 20_000;
const EPSILON = 1e-10;

/**
 * Transparent, untrained pattern heuristics for paper research. These identify
 * observed shapes; they do not predict a profitable trade or replace safety,
 * freshness, momentum, and position-sizing gates in the execution policy.
 *
 * Input is provider-timestamped history in strictly increasing order. Only the
 * trailing 75 seconds of valid history contributes to a classification.
 */
export function classifyLaunchPattern(points: readonly LaunchPatternPoint[]): LaunchPatternResult {
  const reject = (detail: string): LaunchPatternResult => ({ pattern: null, detail });
  if (!points.length) return reject("Pattern evidence is warming up: need four distinct provider samples over 30 seconds");

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!Number.isSafeInteger(point.observedAtMs) || point.observedAtMs < 0
      || !Number.isFinite(point.priceUsd) || point.priceUsd <= 0
      || !Number.isFinite(point.volume5mUsd) || point.volume5mUsd <= 0
      || !Number.isFinite(point.liquidityUsd) || point.liquidityUsd <= 0
      || !Number.isFinite(point.buyRatio) || point.buyRatio < 0 || point.buyRatio > 1) {
      return reject("Pattern evidence contains invalid market data");
    }
    if (index > 0 && point.observedAtMs <= points[index - 1].observedAtMs) {
      return reject("Pattern evidence requires distinct, increasing provider timestamps");
    }
  }

  const latest = points[points.length - 1];
  const window = points.filter((point) => latest.observedAtMs - point.observedAtMs <= MAX_WINDOW_MS);
  const baseline = window[0];
  if (window.length < 4 || latest.observedAtMs - baseline.observedAtMs < MIN_WINDOW_MS) {
    return reject("Pattern evidence is warming up: need four distinct provider samples over 30 seconds");
  }
  if (window.some((point, index) => index > 0
    && point.observedAtMs - window[index - 1].observedAtMs > MAX_SAMPLE_GAP_MS)) {
    return reject("Pattern evidence is too sparse: provider sample gap exceeds 20 seconds");
  }

  const previous = window[window.length - 2];
  if (window.some((point) => point.liquidityUsd / baseline.liquidityUsd < 0.95 - EPSILON)) {
    return reject("Pattern rejected: liquidity fell more than 5% during the observed window");
  }
  if (latest.volume5mUsd / baseline.volume5mUsd < 1.05 - EPSILON
    || latest.volume5mUsd < previous.volume5mUsd) {
    return reject("Pattern rejected: rolling volume must grow at least 5% and hold on the latest sample");
  }
  if (window.some((point) => point.buyRatio < 0.5)
    || latest.buyRatio < baseline.buyRatio - 0.05 - EPSILON) {
    return reject("Pattern rejected: buy pressure is not sustained");
  }
  if (latest.priceUsd <= baseline.priceUsd || latest.priceUsd <= previous.priceUsd) {
    return reject("Pattern rejected: price must advance overall and on the latest sample");
  }

  // Ratios keep tiny token prices comparable without an absolute USD tolerance.
  const prices = window.map((point) => point.priceUsd / baseline.priceUsd);
  if (prices.some((price) => !Number.isFinite(price))) {
    return reject("Pattern evidence contains an invalid price range");
  }
  const currentPrice = prices[prices.length - 1];
  const priorPrices = prices.slice(0, -1);
  const priorHigh = Math.max(...priorPrices);
  const peakIndex = priorPrices.indexOf(priorHigh);

  if (peakIndex > 0 && peakIndex < priorPrices.length - 1) {
    const trough = Math.min(...priorPrices.slice(peakIndex + 1));
    const retreat = priorHigh - trough;
    const runUp = priorHigh - 1;
    const shallowRetreat = retreat > EPSILON
      && retreat / priorHigh <= 0.03 + EPSILON
      && retreat <= runUp * 0.6 + EPSILON;
    if (shallowRetreat && currentPrice >= trough + retreat * 0.5 - EPSILON) {
      return {
        pattern: "pullback-reclaim",
        detail: "Pullback-reclaim heuristic: shallow retreat recovered at least halfway with sustained flow and liquidity",
      };
    }
  }

  const priorRises = priorPrices.slice(1)
    .map((price, index) => price - priorPrices[index])
    .filter((change) => change > EPSILON);
  const finalRise = currentPrice - priorPrices[priorPrices.length - 1];
  const orderlyFinalRise = priorRises.length >= 2
    && finalRise <= Math.max(...priorRises) * 2 + EPSILON
    && finalRise <= (currentPrice - 1) * 0.6 + EPSILON;
  if (currentPrice > priorHigh + EPSILON && orderlyFinalRise) {
    return {
      pattern: "breakout",
      detail: "Breakout heuristic: price exceeded the observed high after repeated advances with sustained flow and liquidity",
    };
  }

  return reject("No orderly breakout or shallow pullback-reclaim pattern is confirmed");
}
