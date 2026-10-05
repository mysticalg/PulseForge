import type { MarketEvent, MarketSnapshot, MarketToken, RuntimeInfo } from "../types";

type Definition = readonly [
  symbol: string,
  name: string,
  price: number,
  liquidity: number,
  volume: number,
  buyRatio: number,
  age: number,
  mintRevoked: boolean,
  freezeRevoked: boolean,
  topTenPct: number,
  verified: boolean,
];

const definitions: Definition[] = [
  ["BYTEFROG", "ByteFrog", 0.0000968, 138_226, 615_000, 0.81, 4_740, true, true, 18.2, false],
  ["NEONWIF", "NeonWif Hat", 0.000142, 412_981, 1_240_000, 0.72, 15_120, true, true, 21.5, true],
  ["SOLPUNK", "Solpunk", 0.001873, 287_451, 392_000, 0.61, 10_020, true, true, 24.4, false],
  ["MINTY", "Minty Boi", 0.0000571, 95_431, 402_000, 0.54, 11_100, false, true, 38.7, false],
  ["GIGAOWL", "Giga Owl", 0.000312, 623_118, 2_030_000, 0.67, 19_980, true, true, 17.4, true],
  ["DUSTY", "Dusty Cat", 0.0000214, 42_870, 178_000, 0.49, 6_240, true, true, 43.2, false],
  ["ORBZ", "Orbzz", 0.000184, 201_955, 741_000, 0.73, 8_280, true, true, 27.1, false],
  ["SLIMEAI", "Slime AI", 0.000263, 534_672, 1_110_000, 0.66, 21_720, true, true, 20.3, true],
  ["PIXELPUP", "Pixel Pup", 0.0000132, 28_914, 96_000, 0.84, 2_940, true, false, 52.0, false],
  ["VOID", "Void Token", 0.0000775, 112_337, 389_000, 0.58, 25_860, true, true, 31.8, false],
  ["MOONZIP", "Moon Zip", 0.000428, 210_000, 150_000, 0.68, 1_320, true, true, 24.2, false],
  ["TIDEBIT", "Tide Bit", 0.00214, 880_300, 3_420_000, 0.59, 44_400, true, true, 15.6, true],
];

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function baselineScore(token: Omit<MarketToken, "modelScore" | "riskLevel" | "source" | "updatedAt">) {
  let logit = -0.55;
  const volumeToLiquidity = token.volume5mUsd / Math.max(token.liquidityUsd, 1);
  logit += token.liquidityUsd >= 250_000 ? 0.32 : -0.24;
  logit += volumeToLiquidity >= 0.8 ? 0.28 : -0.08;
  logit += token.buyRatio >= 0.62 ? 0.27 : -0.17;
  logit += token.change5mPct >= 0.25 && token.change5mPct <= 7.5 ? 0.24 : -0.12;
  logit += token.ageSeconds >= 600 ? 0.12 : -0.3;
  logit += token.safety.topTenHolderPct <= 25 ? 0.2 : -0.27;
  logit += token.safety.mintAuthorityRevoked && token.safety.freezeAuthorityRevoked ? 0.28 : -0.58;
  logit += token.safety.verified ? 0.13 : -0.04;
  return Math.min(0.99, Math.max(0.01, sigmoid(logit)));
}

function classifyRisk(token: Omit<MarketToken, "modelScore" | "riskLevel" | "source" | "updatedAt">): MarketToken["riskLevel"] {
  const safety = token.safety;
  if (
    !safety.mintAuthorityRevoked ||
    !safety.freezeAuthorityRevoked ||
    token.liquidityUsd < 35_000 ||
    safety.topTenHolderPct > 45
  ) {
    return "High";
  }
  if (
    token.liquidityUsd < 100_000 ||
    safety.topTenHolderPct > 32 ||
    safety.priceImpactPct > 1.5 ||
    token.ageSeconds < 300
  ) {
    return "Med-High";
  }
  if (safety.verified && token.liquidityUsd >= 500_000 && safety.topTenHolderPct < 22) {
    return "Low";
  }
  return "Medium";
}

export function createDemoSnapshot(): MarketSnapshot {
  const now = Date.now();
  const tokens = definitions.map((definition, index): MarketToken => {
    const [symbol, name, basePrice, liquidity, volume, buyRatio, age, mint, freeze, topTen, verified] = definition;
    const wave = Math.sin(now / 4_000 + index * 1.71) * 0.012;
    const change = symbol === "MOONZIP" ? 10 + wave * 100 : wave * 100 + ((index % 3) - 1) * 0.42;
    const tokenBase = {
      mint: `DemoMint${String(index).padStart(2, "0")}111111111111111111111111111111`,
      symbol,
      name,
      ageSeconds: age + Math.floor((now / 1_000) % 900),
      priceUsd: basePrice * (1 + wave),
      marketCapUsd: liquidity * (3 + (index % 5) * 1.4),
      change5mPct: change,
      liquidityUsd: liquidity,
      volume5mUsd: volume,
      buyRatio,
      buys5m: Math.max(20, Math.round(volume / 80)),
      sells5m: Math.max(12, Math.round(volume / 100)),
      traders5m: Math.max(25, Math.round(volume / 400)),
      organicBuyers5m: Math.max(4, Math.round(volume / 8_000)),
      organicScore: verified ? 82 : 61,
      safety: {
        mintAuthorityRevoked: mint,
        freezeAuthorityRevoked: freeze,
        topTenHolderPct: topTen,
        liquidityLocked: index % 4 !== 0,
        priceImpactPct: Math.min(25, Math.max(0.02, Math.sqrt(250 / liquidity) * 20)),
        transferTaxPct: index === 8 ? 2.5 : 0,
        verified,
      },
    };
    return {
      ...tokenBase,
      riskLevel: classifyRisk(tokenBase),
      modelScore: baselineScore(tokenBase),
      source: "Deterministic demo",
      updatedAt: new Date(now).toISOString(),
    };
  });

  return {
    mode: "demo",
    provider: "Deterministic demo feed",
    latencyMs: 7,
    updatedAt: new Date(now).toISOString(),
    tokens,
    warning: "Set JUPITER_API_KEY in the Windows user environment to enable blended live discovery.",
  };
}

export const browserRuntimeInfo: RuntimeInfo = {
  version: "0.10.8-browser",
  jupiterConfigured: false,
  heliusConfigured: false,
  laserstreamConfigured: false,
  liveExecutionAvailable: false,
  modelName: "Compact tree ensemble baseline",
  modelStatus: "Uncalibrated · paper only",
};

export function seedEvents(token: MarketToken): MarketEvent[] {
  const time = (offsetSeconds: number) =>
    new Date(Date.now() - offsetSeconds * 1_000).toLocaleTimeString("en-GB", { hour12: false });
  return [
    { id: "event-1", time: time(1), kind: "positive", event: "Model update", detail: `Score ${token.modelScore.toFixed(2)}` },
    { id: "event-2", time: time(3), kind: "info", event: "Liquidity observed", detail: `$${Math.round(token.liquidityUsd).toLocaleString()}` },
    { id: "event-3", time: time(5), kind: "positive", event: "Buy flow", detail: `${Math.round(token.buyRatio * 100)}% of 5m flow` },
    { id: "event-4", time: time(8), kind: "warning", event: "Safety gate", detail: `${token.riskLevel} risk` },
    { id: "event-5", time: time(11), kind: "info", event: "New pool", detail: "Candidate indexed" },
    { id: "event-6", time: time(15), kind: "info", event: "Route check", detail: "Paper estimate only" },
  ];
}
