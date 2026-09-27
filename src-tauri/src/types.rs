use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyChecks {
    pub mint_authority_revoked: bool,
    pub freeze_authority_revoked: bool,
    pub top_ten_holder_pct: f64,
    pub liquidity_locked: Option<bool>,
    pub price_impact_pct: f64,
    pub transfer_tax_pct: f64,
    /// Missing provider evidence, distinct from an explicitly reported fee.
    #[serde(default)]
    pub transfer_tax_unknown: bool,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketToken {
    pub mint: String,
    pub symbol: String,
    pub name: String,
    pub icon_url: Option<String>,
    pub age_seconds: u64,
    pub price_usd: f64,
    #[serde(default)]
    pub market_cap_usd: Option<f64>,
    pub change_5m_pct: f64,
    pub liquidity_usd: f64,
    pub volume_5m_usd: f64,
    pub buy_ratio: f64,
    pub buys_5m: u64,
    pub sells_5m: u64,
    pub traders_5m: u64,
    pub organic_buyers_5m: u64,
    pub organic_score: Option<f64>,
    pub risk_level: String,
    pub model_score: f64,
    pub safety: SafetyChecks,
    pub source: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSnapshot {
    pub mode: String,
    pub provider: String,
    pub latency_ms: u64,
    pub updated_at: String,
    pub tokens: Vec<MarketToken>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub version: String,
    pub jupiter_configured: bool,
    pub helius_configured: bool,
    pub laserstream_configured: bool,
    pub live_execution_available: bool,
    pub model_name: String,
    pub model_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteEstimate {
    pub input_usd: f64,
    pub expected_price_usd: f64,
    pub expected_tokens: f64,
    pub price_impact_pct: f64,
    pub fee_usd: f64,
    pub route: String,
    pub can_paper_trade: bool,
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletStatus {
    pub imported: bool,
    pub address: Option<String>,
    pub storage: String,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletPortfolio {
    pub imported: bool,
    pub address: Option<String>,
    pub sol_balance: Option<f64>,
    pub sol_price_usd: Option<f64>,
    pub native_value_usd: Option<f64>,
    pub estimated_total_value_usd: Option<f64>,
    pub available_after_gas_usd: Option<f64>,
    pub source: String,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCanaryRequest {
    pub side: String,
    pub mint: String,
    pub amount_usd: Option<f64>,
    pub sell_percent: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCanaryPreview {
    pub challenge_id: String,
    pub side: String,
    pub mint: String,
    pub symbol: String,
    pub input_label: String,
    pub expected_output_label: String,
    pub requested_usd: Option<f64>,
    pub sell_percent: Option<u8>,
    pub price_impact_pct: f64,
    pub slippage_bps: u64,
    pub fee_bps: u64,
    pub router: String,
    pub expires_at: String,
    pub confirmation_phrase: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCanaryTrade {
    pub id: String,
    pub created_at: String,
    pub side: String,
    pub mint: String,
    pub symbol: String,
    pub requested_usd: Option<f64>,
    pub status: String,
    pub signature: Option<String>,
    pub router: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCanaryStatus {
    pub available: bool,
    pub armed: bool,
    pub blocker: Option<String>,
    pub max_order_usd: f64,
    pub daily_buy_cap_usd: f64,
    pub daily_buy_used_usd: f64,
    pub max_price_impact_pct: f64,
    pub max_slippage_bps: u64,
    pub cooldown_seconds: u64,
    pub cooldown_remaining_seconds: u64,
    pub acknowledgement_phrase: String,
    pub recent_trades: Vec<LiveCanaryTrade>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCanaryExecution {
    pub status: String,
    pub signature: String,
    pub side: String,
    pub mint: String,
    pub symbol: String,
    pub input_amount: String,
    pub output_amount: String,
    pub explorer_url: String,
}
