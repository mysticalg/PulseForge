#!/usr/bin/env python3
"""Train and calibrate PulseForge candidates from an exported point-in-time CSV.

This tool is deliberately offline. It never reads a wallet and never submits an order.
The newest chronological test segment remains untouched until the final report.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import sqlite3
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
import joblib
import numpy as np
from sklearn.calibration import calibration_curve
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score


FEATURES = [
    "ageSeconds", "priceUsd", "change5mPct", "momentum1mPct", "momentum15mPct",
    "liquidityUsd", "liquidityChange5mPct", "volume5mUsd", "volumeToLiquidity",
    "buyRatio", "flowImbalance", "buys5m", "sells5m", "trades5m", "traders5m",
    "organicBuyers5m", "organicScore", "marketMedianChange5mPct", "marketPositiveShare",
    "mintAuthorityRevoked", "freezeAuthorityRevoked", "topTenHolderPct",
    "liquidityLocked", "entryPriceImpactPct", "transferTaxPct", "verified",
]
LOG_FEATURES = {
    "ageSeconds", "priceUsd", "liquidityUsd", "volume5mUsd", "buys5m", "sells5m",
    "trades5m", "traders5m", "organicBuyers5m",
}
PURGE_MS = 60 * 60 * 1000
UNAVAILABLE_RETURN_PCT = -100.0
MIN_EVALUATION_RETURN_PCT = -100.0
MAX_EVALUATION_RETURN_PCT = 100.0

SQLITE_COLUMNS = {
    "observedAtMs": "observed_at_ms", "mint": "mint", "ageSeconds": "age_seconds",
    "priceUsd": "price_usd", "change5mPct": "change_5m_pct",
    "momentum1mPct": "momentum_1m_pct", "momentum15mPct": "momentum_15m_pct",
    "liquidityUsd": "liquidity_usd", "liquidityChange5mPct": "liquidity_change_5m_pct",
    "volume5mUsd": "volume_5m_usd", "volumeToLiquidity": "volume_to_liquidity",
    "buyRatio": "buy_ratio", "flowImbalance": "flow_imbalance", "buys5m": "buys_5m",
    "sells5m": "sells_5m", "trades5m": "trades_5m", "traders5m": "traders_5m",
    "organicBuyers5m": "organic_buyers_5m", "organicScore": "organic_score",
    "marketMedianChange5mPct": "market_median_change_5m_pct",
    "marketPositiveShare": "market_positive_share", "modelRawScore": "model_raw_score",
    "riskLevel": "risk_level", "mintAuthorityRevoked": "mint_authority_revoked",
    "freezeAuthorityRevoked": "freeze_authority_revoked", "topTenHolderPct": "top_ten_holder_pct",
    "liquidityLocked": "liquidity_locked", "entryPriceImpactPct": "entry_price_impact_pct",
    "transferTaxPct": "transfer_tax_pct", "verified": "verified",
    "outcomeNetReturnPct": "outcome_net_return_pct", "outcomeSuccess": "outcome_success",
    "outcomeAvailable": "outcome_available", "outcomeReason": "outcome_reason",
}


@dataclass
class Metrics:
    rows: int
    positives: int
    brier: float
    log_loss: float
    roc_auc: float | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Chronologically train and calibrate PulseForge models")
    parser.add_argument("dataset", type=Path, help="CSV export or PulseForge calibration-v1.sqlite3 database")
    parser.add_argument("--output", type=Path, default=Path("calibration-artifacts"))
    parser.add_argument("--min-rows", type=int, default=300, help="Safety floor; lower only for pipeline tests")
    parser.add_argument("--cost-stress-pct", type=float, default=1.0, help="Extra round-trip cost deducted during threshold selection and promotion checks")
    return parser.parse_args()


def number(row: dict[str, str], key: str, default: float = 0.0) -> float:
    raw = row.get(key, "")
    try:
        value = float(raw) if raw != "" else default
        return value if math.isfinite(value) else default
    except ValueError:
        return default


def vector(row: dict[str, str]) -> list[float]:
    values: list[float] = []
    for feature in FEATURES:
        value = number(row, feature, -1.0 if feature in {"organicScore", "liquidityLocked"} else 0.0)
        values.append(math.log1p(max(0.0, value)) if feature in LOG_FEATURES else value)
    return values


def policy_eligible(row: dict[str, str]) -> bool:
    return (
        row.get("riskLevel", "") in {"Low", "Medium"}
        and number(row, "mintAuthorityRevoked") == 1
        and number(row, "freezeAuthorityRevoked") == 1
        and number(row, "topTenHolderPct", 100) <= 35
        and number(row, "transferTaxPct", 100) <= 1
        and number(row, "liquidityUsd") >= 250_000
        and number(row, "volume5mUsd") >= 100_000
        and number(row, "traders5m") >= 75
        and number(row, "organicBuyers5m") >= 10
        and 0.58 <= number(row, "buyRatio") <= 0.75
        and number(row, "entryPriceImpactPct", 100) <= 0.30
    )


def read_rows(path: Path) -> list[dict[str, str]]:
    if path.suffix.lower() not in {".sqlite", ".sqlite3", ".db"}:
        with path.open("r", newline="", encoding="utf-8-sig") as handle:
            return [dict(row) for row in csv.DictReader(handle)]
    connection = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    select = ",".join(f'{column} AS "{name}"' for name, column in SQLITE_COLUMNS.items())
    try:
        return [
            {key: "" if value is None else str(value) for key, value in dict(row).items()}
            for row in connection.execute(f"SELECT {select} FROM observations WHERE outcome_success IN (0,1)")
        ]
    finally:
        connection.close()


def load_dataset(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, dict[str, object]]:
    candidates = [row for row in read_rows(path) if row.get("outcomeSuccess", "") in {"0", "1"}]
    raw_labeled_rows = len(candidates)
    accepted: list[tuple[dict[str, str], float]] = []
    excluded_nonfinite = 0
    excluded_missing_available = 0
    unavailable_penalties = 0
    clipped_returns = 0
    for row in candidates:
        raw = row.get("outcomeNetReturnPct", "").strip()
        if raw == "":
            if row.get("outcomeSuccess") == "0" and row.get("outcomeAvailable") == "0":
                value = UNAVAILABLE_RETURN_PCT
                unavailable_penalties += 1
            else:
                excluded_missing_available += 1
                continue
        else:
            try:
                value = float(raw)
            except ValueError:
                excluded_nonfinite += 1
                continue
            if not math.isfinite(value):
                excluded_nonfinite += 1
                continue
        bounded = min(MAX_EVALUATION_RETURN_PCT, max(MIN_EVALUATION_RETURN_PCT, value))
        clipped_returns += bounded != value
        accepted.append((row, bounded))
    accepted.sort(key=lambda pair: (int(float(pair[0]["observedAtMs"])), pair[0].get("mint", "")))
    rows = [pair[0] for pair in accepted]
    returns = [pair[1] for pair in accepted]
    if not rows:
        raise SystemExit("No labeled outcomes found. Keep PulseForge running until 45-minute labels exist.")
    x = np.asarray([vector(row) for row in rows], dtype=np.float64)
    y = np.asarray([int(row["outcomeSuccess"]) for row in rows], dtype=np.int8)
    times = np.asarray([int(float(row["observedAtMs"])) for row in rows], dtype=np.int64)
    returns_array = np.asarray(returns, dtype=np.float64)
    eligible = np.asarray([policy_eligible(row) for row in rows], dtype=bool)
    mints = np.asarray([row.get("mint", "") for row in rows], dtype=object)
    baseline = np.asarray([number(row, "modelRawScore", 0.5) for row in rows], dtype=np.float64)
    missing_by_feature = {feature: sum(row.get(feature, "") == "" for row in rows) for feature in FEATURES}
    audit: dict[str, object] = {
        "rawLabeledRows": raw_labeled_rows,
        "usableRows": len(rows),
        "excludedNonFiniteReturns": excluded_nonfinite,
        "excludedMissingAvailableReturns": excluded_missing_available,
        "unavailableRoutesAssignedConservativeLoss": unavailable_penalties,
        "returnsWinsorizedForEvaluation": clipped_returns,
        "evaluationReturnBoundsPct": [MIN_EVALUATION_RETURN_PCT, MAX_EVALUATION_RETURN_PCT],
        "missingFeatureCounts": missing_by_feature,
    }
    return x, y, times, returns_array, eligible, mints, baseline, audit


def chronological_masks(times: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, int, int, int]:
    unique = np.unique(times)
    if len(unique) < 20:
        raise SystemExit("Too few distinct observation times for chronological evaluation.")
    train_boundary = int(unique[max(1, int(len(unique) * 0.50)) - 1])
    selection_boundary = int(unique[max(2, int(len(unique) * 0.65)) - 1])
    calibration_boundary = int(unique[max(3, int(len(unique) * 0.80)) - 1])
    train = times <= train_boundary - PURGE_MS
    selection = (times > train_boundary) & (times <= selection_boundary - PURGE_MS)
    calibration = (times > selection_boundary) & (times <= calibration_boundary - PURGE_MS)
    test = times > calibration_boundary
    return train, selection, calibration, test, train_boundary, selection_boundary, calibration_boundary


def probabilities(model: object, x: np.ndarray) -> np.ndarray:
    return np.clip(model.predict_proba(x)[:, 1], 1e-6, 1 - 1e-6)


def metrics(y: np.ndarray, probability: np.ndarray) -> Metrics:
    auc = float(roc_auc_score(y, probability)) if len(np.unique(y)) == 2 else None
    return Metrics(len(y), int(y.sum()), float(brier_score_loss(y, probability)), float(log_loss(y, probability, labels=[0, 1])), auc)


def ensure_classes(name: str, y: np.ndarray) -> None:
    if len(y) < 25 or len(np.unique(y)) != 2:
        raise SystemExit(f"{name} segment needs at least 25 rows and both positive and negative outcomes.")


def choose_threshold(y: np.ndarray, probability: np.ndarray, returns: np.ndarray, eligible: np.ndarray) -> dict[str, float]:
    candidates = np.unique(np.quantile(probability, np.linspace(0.5, 0.95, 19)))
    choices = []
    for threshold in candidates:
        chosen = eligible & (probability >= threshold)
        if chosen.sum() < 10:
            continue
        choices.append((float(returns[chosen].mean()), float(threshold), int(chosen.sum()), float(y[chosen].mean())))
    if not choices:
        return {"threshold": 1.0, "meanNetReturnPct": 0.0, "coverage": 0.0, "observations": 0, "winRate": 0.0}
    expectancy, threshold, count, win_rate = max(choices, key=lambda item: (item[0], item[2]))
    return {"threshold": threshold, "meanNetReturnPct": expectancy, "coverage": count / len(y), "observations": count, "winRate": win_rate}


def threshold_performance(y: np.ndarray, probability: np.ndarray, returns: np.ndarray, eligible: np.ndarray, threshold: float) -> dict[str, float]:
    chosen = eligible & (probability >= threshold)
    count = int(chosen.sum())
    return {
        "threshold": threshold,
        "meanNetReturnPct": float(returns[chosen].mean()) if count else 0.0,
        "coverage": count / len(y),
        "observations": count,
        "winRate": float(y[chosen].mean()) if count else 0.0,
    }


def mint_weights(mints: np.ndarray) -> np.ndarray:
    counts = Counter(str(mint) for mint in mints)
    return np.asarray([1.0 / math.sqrt(counts[str(mint)]) for mint in mints], dtype=np.float64)


def block_bootstrap_lower_bound(returns: np.ndarray, times: np.ndarray, iterations: int = 2_000) -> float | None:
    """Lower 95% mean-return bound from resampled UTC-day blocks."""
    if len(returns) == 0:
        return None
    day_ids = times // 86_400_000
    unique_days = np.unique(day_ids)
    if len(unique_days) < 7:
        return None
    blocks = [returns[day_ids == day] for day in unique_days]
    rng = np.random.default_rng(41)
    simulated = np.empty(iterations, dtype=np.float64)
    for index in range(iterations):
        sampled = rng.integers(0, len(blocks), size=len(blocks))
        combined = np.concatenate([blocks[block] for block in sampled])
        simulated[index] = combined.mean()
    return float(np.quantile(simulated, 0.025))


def reliability(y: np.ndarray, probability: np.ndarray) -> list[dict[str, float]]:
    observed, predicted = calibration_curve(y, probability, n_bins=10, strategy="quantile")
    return [{"meanPredicted": float(p), "observedRate": float(o)} for o, p in zip(observed, predicted)]


def main() -> None:
    args = parse_args()
    if args.cost_stress_pct < 0:
        raise SystemExit("--cost-stress-pct must be zero or positive.")
    x, y, times, returns, eligible, mints, baseline, data_quality = load_dataset(args.dataset)
    if len(y) < args.min_rows:
        raise SystemExit(f"Only {len(y)} labeled rows; configured minimum is {args.min_rows}.")
    train, selection_mask, calibration, test, train_boundary, selection_boundary, calibration_boundary = chronological_masks(times)
    for name, mask in (("Training", train), ("Model selection", selection_mask), ("Calibration", calibration), ("Test", test)):
        ensure_classes(name, y[mask])

    candidates = {
        "histGradientBoosting": HistGradientBoostingClassifier(
            learning_rate=0.05, max_iter=180, max_leaf_nodes=15, min_samples_leaf=25,
            l2_regularization=1.0, random_state=41,
        ),
        "randomForest": RandomForestClassifier(
            n_estimators=300, max_depth=9, min_samples_leaf=12, class_weight="balanced_subsample",
            n_jobs=-1, random_state=41,
        ),
    }
    weights = mint_weights(mints)
    selection: dict[str, Metrics] = {}
    for name, model in candidates.items():
        model.fit(x[train], y[train], sample_weight=weights[train])
        selection[name] = metrics(y[selection_mask], probabilities(model, x[selection_mask]))
    champion_name = min(selection, key=lambda name: selection[name].brier)
    champion = candidates[champion_name]

    calibration_raw = probabilities(champion, x[calibration])
    sigmoid = LogisticRegression(C=1.0, solver="lbfgs", random_state=41)
    sigmoid.fit(
        np.log(calibration_raw / (1.0 - calibration_raw)).reshape(-1, 1),
        y[calibration],
        sample_weight=weights[calibration],
    )
    calibration_calibrated = sigmoid.predict_proba(np.log(calibration_raw / (1.0 - calibration_raw)).reshape(-1, 1))[:, 1]
    stressed_returns = returns - args.cost_stress_pct
    research_threshold = choose_threshold(y[calibration], calibration_calibrated, stressed_returns[calibration], eligible[calibration])
    test_raw = probabilities(champion, x[test])
    test_calibrated = sigmoid.predict_proba(np.log(test_raw / (1.0 - test_raw)).reshape(-1, 1))[:, 1]
    test_threshold = research_threshold["threshold"]
    test_chosen = eligible[test] & (test_calibrated >= test_threshold)
    test_stressed = stressed_returns[test]
    lower_bound = block_bootstrap_lower_bound(test_stressed[test_chosen], times[test][test_chosen])
    test_performance = threshold_performance(y[test], test_calibrated, returns[test], eligible[test], test_threshold)
    stressed_test_performance = threshold_performance(y[test], test_calibrated, test_stressed, eligible[test], test_threshold)
    observation_span_days = float((times.max() - times.min()) / 86_400_000)
    dataset_fingerprint = hashlib.sha256()
    dataset_fingerprint.update(times.tobytes())
    dataset_fingerprint.update(y.tobytes())
    dataset_fingerprint.update("\n".join(str(mint) for mint in mints).encode("utf-8"))
    baseline_test_metrics = metrics(y[test], np.clip(baseline[test], 1e-6, 1 - 1e-6))
    promotion_checks = {
        "atLeast30CalendarDays": observation_span_days >= 30,
        "atLeast100UntouchedTestSelections": int(test_chosen.sum()) >= 100,
        "positiveCostStressedExpectancy": stressed_test_performance["meanNetReturnPct"] > 0,
        "lower95BlockBootstrapAboveZero": lower_bound is not None and lower_bound > 0,
    }

    args.output.mkdir(parents=True, exist_ok=True)
    artifact_path = args.output / "pulseforge-calibrated-model.joblib"
    joblib.dump({
        "schemaVersion": 3,
        "model": champion,
        "calibrator": sigmoid,
        "features": FEATURES,
        "logFeatures": sorted(LOG_FEATURES),
        "researchThreshold": test_threshold,
        "costStressPct": args.cost_stress_pct,
    }, artifact_path)

    report = {
        "schemaVersion": 3,
        "trainedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "dataset": str(args.dataset.resolve()),
        "datasetFingerprintSha256": dataset_fingerprint.hexdigest(),
        "artifact": str(artifact_path.resolve()),
        "target": "First deterministic policy exit within 45 minutes; net of recorded entry/exit impact and a 0.70% round-trip fee estimate; unavailable routes are negative",
        "featurePolicy": {
            "pointInTimeOnly": True,
            "perMintSampleWeighting": "inverse square-root observation count",
            "hardGateAppliedToThresholdEvaluation": True,
            "quoteProbeFieldsExcludedFromModel": True,
        },
        "datasetAudit": {
            "rows": int(len(y)),
            "uniqueMints": int(len(np.unique(mints))),
            "eligibleRows": int(eligible.sum()),
            "observationSpanDays": observation_span_days,
        },
        "dataQuality": data_quality,
        "purgeMinutes": PURGE_MS // 60_000,
        "extraCostStressPct": args.cost_stress_pct,
        "boundaries": {
            "trainEndMs": train_boundary,
            "selectionEndMs": selection_boundary,
            "calibrationEndMs": calibration_boundary,
        },
        "segments": {
            "train": int(train.sum()),
            "modelSelection": int(selection_mask.sum()),
            "calibration": int(calibration.sum()),
            "test": int(test.sum()),
        },
        "candidateCalibrationMetrics": {name: asdict(value) for name, value in selection.items()},
        "champion": champion_name,
        "untouchedTest": {
            "shippedBaselineRaw": asdict(baseline_test_metrics),
            "raw": asdict(metrics(y[test], test_raw)),
            "calibrated": asdict(metrics(y[test], test_calibrated)),
            "reliability": reliability(y[test], test_calibrated),
            "fixedThresholdPerformance": test_performance,
            "costStressedThresholdPerformance": stressed_test_performance,
            "lower95DailyBlockBootstrapMeanReturnPct": lower_bound,
        },
        "exploratoryCalibrationThreshold": research_threshold,
        "promotionChecks": promotion_checks,
        "promotionEligible": all(promotion_checks.values()),
        "warning": "This offline artifact is research evidence only. It is not loaded by live execution and does not establish future profitability.",
    }
    report_path = args.output / "calibration-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"champion": champion_name, "artifact": str(artifact_path), "report": str(report_path), "test": report["untouchedTest"]}, indent=2))


if __name__ == "__main__":
    main()
