import type { MarketToken } from "../types";
import {
  paperExitObservationFromLastMark,
  type PaperEnginePosition,
  type PaperMarketObservation,
} from "./paperEngine";
import { observationsAt } from "./paperRuntime";

export type PaperCloseMarkSource = "scanner" | "provider" | "last-recorded";

export interface ResolvedPaperCloseMark {
  observation: PaperMarketObservation;
  source: PaperCloseMarkSource;
}

export async function resolvePaperCloseMark(
  position: PaperEnginePosition,
  scannerTokens: readonly MarketToken[],
  nowMs: number,
  refreshToken: (mint: string) => Promise<MarketToken>,
): Promise<ResolvedPaperCloseMark> {
  const startedAtMs = Date.now();
  const currentTime = () => nowMs + Math.max(0, Date.now() - startedAtMs);
  const fresh = (token: MarketToken) => {
    const timestamp = Date.parse(token.updatedAt);
    return Number.isFinite(timestamp) && timestamp <= currentTime() && currentTime() - timestamp <= 75_000;
  };
  const scannerToken = scannerTokens.find((candidate) => (
    candidate.mint === position.mint && Number.isFinite(candidate.priceUsd) && candidate.priceUsd > 0 && fresh(candidate)
  ));
  if (scannerToken) {
    return { observation: observationsAt([scannerToken], nowMs)[0], source: "scanner" };
  }

  try {
    const refreshed = await refreshToken(position.mint);
    if (refreshed.mint !== position.mint || !Number.isFinite(refreshed.priceUsd) || refreshed.priceUsd <= 0 || !fresh(refreshed)) {
      throw new Error("Provider returned an invalid paper-close mark");
    }
    return { observation: observationsAt([refreshed], currentTime())[0], source: "provider" };
  } catch {
    return {
      observation: paperExitObservationFromLastMark(position, currentTime()),
      source: "last-recorded",
    };
  }
}
