import type { MarketSnapshot, MarketToken } from "../types";

/** Keep held mints observable after they fall out of discovery's bounded list. */
export async function refreshHeldLaunches(
  snapshot: MarketSnapshot,
  heldMints: readonly string[],
  fetchToken: (mint: string) => Promise<MarketToken>,
  now: () => number = Date.now,
  fetchBatch?: (mints: string[]) => Promise<MarketToken[]>,
): Promise<MarketSnapshot> {
  if (snapshot.mode !== "live" || heldMints.length === 0) return snapshot;
  const nowMs = now();
  const tokens = new Map(snapshot.tokens.map((token) => [token.mint, token]));
  const pending = [...new Set(heldMints)].filter((mint) => {
    const token = tokens.get(mint);
    const timestamp = token ? Date.parse(token.updatedAt) : NaN;
    return !Number.isFinite(timestamp) || timestamp > nowMs || nowMs - timestamp > 15_000;
  });
  let unavailable = 0;
  // Native batches share one Jupiter request for held paper and live mints.
  const batchSize = fetchBatch ? 100 : 3;
  for (let start = 0; start < pending.length; start += batchSize) {
    const batch = pending.slice(start, start + batchSize);
    let results: PromiseSettledResult<MarketToken>[];
    if (fetchBatch) {
      try {
        const rows = new Map((await fetchBatch(batch)).map((token) => [token.mint, token]));
        results = batch.map((mint) => {
          const token = rows.get(mint);
          return token ? { status: "fulfilled", value: token } : { status: "rejected", reason: "Mint absent from batch" };
        });
      } catch (reason) {
        results = batch.map(() => ({ status: "rejected", reason }));
      }
    } else {
      results = await Promise.allSettled(batch.map(fetchToken));
    }
    results.forEach((result, index) => {
      const mint = batch[index];
      if (result.status !== "fulfilled" || result.value.mint !== mint
        || !Number.isFinite(result.value.priceUsd) || result.value.priceUsd <= 0) {
        unavailable += 1;
        return;
      }
      const token = result.value;
      const timestamp = Date.parse(token.updatedAt);
      const previous = tokens.get(mint);
      if (!Number.isFinite(timestamp) || timestamp > now() || now() - timestamp > 75_000
        || (previous && timestamp < Date.parse(previous.updatedAt))) {
        unavailable += 1;
        return;
      }
      tokens.set(mint, token);
    });
  }
  return {
    ...snapshot,
    tokens: [...tokens.values()],
    warning: unavailable
      ? [snapshot.warning, `${unavailable} held token(s) unavailable; automatic exits need fresh provider marks.`].filter(Boolean).join(" ")
      : snapshot.warning,
  };
}
