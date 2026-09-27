import unittest
import csv
import os
import tempfile
from pathlib import Path

import numpy as np

import train_calibrate as trainer


class TrainerPolicyTests(unittest.TestCase):
    def test_conservative_gate_rejects_one_sided_flow(self) -> None:
        row = {
            "riskLevel": "Medium",
            "mintAuthorityRevoked": "1",
            "freezeAuthorityRevoked": "1",
            "topTenHolderPct": "20",
            "transferTaxPct": "0",
            "liquidityUsd": "500000",
            "volume5mUsd": "150000",
            "traders5m": "100",
            "organicBuyers5m": "20",
            "buyRatio": "1",
            "entryPriceImpactPct": "0.1",
        }
        self.assertFalse(trainer.policy_eligible(row))
        row["buyRatio"] = "0.65"
        self.assertTrue(trainer.policy_eligible(row))

    def test_chronological_segments_are_disjoint(self) -> None:
        times = np.arange(2_000, dtype=np.int64) * 60_000
        train, selection, calibration, test, *_ = trainer.chronological_masks(times)
        masks = [train, selection, calibration, test]
        for left_index, left in enumerate(masks):
            for right in masks[left_index + 1:]:
                self.assertFalse(np.any(left & right))
        self.assertTrue(all(mask.sum() >= 25 for mask in masks))

    def test_daily_block_bound_requires_days_and_preserves_positive_edge(self) -> None:
        days = np.repeat(np.arange(14, dtype=np.int64), 12)
        times = days * 86_400_000
        returns = np.full(len(times), 0.8, dtype=np.float64)
        lower = trainer.block_bootstrap_lower_bound(returns, times, iterations=200)
        self.assertIsNotNone(lower)
        self.assertGreater(lower, 0)

    def test_dataset_loader_quarantines_nonfinite_and_bounds_gap_returns(self) -> None:
        descriptor, raw_path = tempfile.mkstemp(suffix=".csv")
        os.close(descriptor)
        path = Path(raw_path)
        try:
            with path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=[
                    "observedAtMs", "mint", "outcomeSuccess", "outcomeAvailable",
                    "outcomeNetReturnPct", "modelRawScore",
                ])
                writer.writeheader()
                writer.writerows([
                    {"observedAtMs": "1000", "mint": "A", "outcomeSuccess": "1", "outcomeAvailable": "1", "outcomeNetReturnPct": "inf", "modelRawScore": ".7"},
                    {"observedAtMs": "2000", "mint": "B", "outcomeSuccess": "0", "outcomeAvailable": "0", "outcomeNetReturnPct": "", "modelRawScore": ".4"},
                    {"observedAtMs": "3000", "mint": "C", "outcomeSuccess": "1", "outcomeAvailable": "1", "outcomeNetReturnPct": "250", "modelRawScore": ".8"},
                ])
            *_, returns, _eligible, _mints, _baseline, audit = trainer.load_dataset(path)
            self.assertEqual(list(returns), [-100.0, 100.0])
            self.assertEqual(audit["excludedNonFiniteReturns"], 1)
            self.assertEqual(audit["unavailableRoutesAssignedConservativeLoss"], 1)
            self.assertEqual(audit["returnsWinsorizedForEvaluation"], 1)
        finally:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
