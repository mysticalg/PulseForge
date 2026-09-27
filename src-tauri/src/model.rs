use crate::types::{MarketToken, SafetyChecks};

#[derive(Debug, Clone, Copy)]
pub struct Features {
    pub momentum_5m_pct: f64,
    pub liquidity_usd: f64,
    pub volume_to_liquidity: f64,
    pub buy_ratio: f64,
    pub age_seconds: u64,
    pub top_ten_holder_pct: f64,
    pub authorities_revoked: bool,
    pub verified: bool,
}

/// A compact, deterministic tree-ensemble baseline. The structure mirrors the
/// hot path used by a trained gradient-boosted model, but its leaves are
/// deliberately hand-authored and the UI labels it uncalibrated. It must never
/// be used as evidence of profitability.
pub fn baseline_score(f: Features) -> f64 {
    let mut logit: f64 = -0.55;

    // Shallow weak learners; each branch contributes one leaf value.
    logit += if f.liquidity_usd >= 250_000.0 {
        0.32
    } else {
        -0.24
    };
    logit += if f.volume_to_liquidity >= 0.8 {
        0.28
    } else {
        -0.08
    };
    logit += if f.buy_ratio >= 0.62 { 0.27 } else { -0.17 };
    logit += if (0.25..=7.5).contains(&f.momentum_5m_pct) {
        0.24
    } else {
        -0.12
    };
    logit += if f.age_seconds >= 600 { 0.12 } else { -0.30 };
    logit += if f.top_ten_holder_pct <= 25.0 {
        0.20
    } else {
        -0.27
    };
    logit += if f.authorities_revoked { 0.28 } else { -0.58 };
    logit += if f.verified { 0.13 } else { -0.04 };

    (1.0 / (1.0 + (-logit).exp())).clamp(0.01, 0.99)
}

pub fn classify_risk(safety: &SafetyChecks, liquidity_usd: f64, age_seconds: u64) -> String {
    if !safety.mint_authority_revoked
        || !safety.freeze_authority_revoked
        || liquidity_usd < 35_000.0
        || safety.top_ten_holder_pct > 45.0
    {
        return "High".into();
    }

    if liquidity_usd < 100_000.0
        || safety.top_ten_holder_pct > 32.0
        || safety.price_impact_pct > 1.5
        || age_seconds < 300
    {
        return "Med-High".into();
    }

    if safety.verified && liquidity_usd >= 500_000.0 && safety.top_ten_holder_pct < 22.0 {
        "Low".into()
    } else {
        "Medium".into()
    }
}

pub fn quote_estimate(
    token: &MarketToken,
    input_usd: f64,
    max_price_impact_pct: f64,
    min_liquidity_usd: f64,
) -> crate::types::QuoteEstimate {
    let size = input_usd.clamp(0.0, 100_000.0);
    let liquidity = token.liquidity_usd.max(1.0);
    let price_impact_pct = ((size / liquidity).sqrt() * 20.0).clamp(0.02, 25.0);
    let fee_usd = size * 0.0035;
    let effective_price = token.price_usd * (1.0 + price_impact_pct / 100.0);
    let expected_tokens = if effective_price > 0.0 {
        (size - fee_usd).max(0.0) / effective_price
    } else {
        0.0
    };

    let mut blockers = Vec::new();
    if size < 5.0 {
        blockers.push("Minimum paper order is $5".into());
    }
    if size > 250.0 {
        blockers.push("Canary limit is $250 per new-token order".into());
    }
    if price_impact_pct > max_price_impact_pct {
        blockers.push(format!(
            "Estimated price impact {:.2}% exceeds configured {}%",
            price_impact_pct, max_price_impact_pct
        ));
    }
    if token.liquidity_usd < min_liquidity_usd {
        blockers.push(format!("Liquidity is below ${}", min_liquidity_usd));
    }
    if !token.safety.mint_authority_revoked || !token.safety.freeze_authority_revoked {
        blockers.push("Token authorities are not fully revoked".into());
    }
    if token.safety.top_ten_holder_pct > 35.0 {
        blockers.push("Top-holder concentration exceeds 35%".into());
    }
    if token.safety.transfer_tax_pct > 1.0 {
        blockers.push("Transfer tax exceeds 1%".into());
    }

    crate::types::QuoteEstimate {
        input_usd: size,
        expected_price_usd: effective_price,
        expected_tokens,
        price_impact_pct,
        fee_usd,
        route: if token.source == "Jupiter Tokens V2" {
            "Jupiter discovery · simulated fill".into()
        } else {
            "Deterministic paper broker".into()
        },
        can_paper_trade: blockers.is_empty(),
        blockers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_rewards_safer_liquid_flow() {
        let safe = baseline_score(Features {
            momentum_5m_pct: 2.0,
            liquidity_usd: 800_000.0,
            volume_to_liquidity: 1.2,
            buy_ratio: 0.68,
            age_seconds: 3600,
            top_ten_holder_pct: 18.0,
            authorities_revoked: true,
            verified: true,
        });
        let unsafe_score = baseline_score(Features {
            momentum_5m_pct: 18.0,
            liquidity_usd: 12_000.0,
            volume_to_liquidity: 0.2,
            buy_ratio: 0.49,
            age_seconds: 45,
            top_ten_holder_pct: 62.0,
            authorities_revoked: false,
            verified: false,
        });
        assert!(safe > unsafe_score);
    }
}
