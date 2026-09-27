mod calibration;
mod jupiter_requests;
mod live_canary;
mod live_route_validation;
mod live_trading;
mod market;
mod mint_safety;
mod model;
mod types;
mod wallet;
mod wallet_valuation;

use types::{
    LiveCanaryExecution, LiveCanaryPreview, LiveCanaryRequest, LiveCanaryStatus, MarketSnapshot,
    MarketToken, QuoteEstimate, RuntimeInfo, WalletPortfolio, WalletStatus,
};

static WALLET_OPERATION_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

async fn wallet_operation_guard() -> tokio::sync::MutexGuard<'static, ()> {
    WALLET_OPERATION_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await
}

#[tauri::command]
async fn refresh_market(app: tauri::AppHandle) -> Result<MarketSnapshot, String> {
    let mut snapshot = market::snapshot().await;
    if snapshot.mode == "live" {
        if let Err(error) = live_trading::record_market_marks(&app, &snapshot.tokens) {
            snapshot.warning = Some(format!("{} Live marks could not be saved: {error}", snapshot.warning.unwrap_or_default()));
        }
    }
    Ok(snapshot)
}

#[tauri::command]
async fn refresh_market_token(app: tauri::AppHandle, mint: String) -> Result<MarketToken, String> {
    let token = market::token_by_mint(&mint).await?;
    live_trading::record_market_marks(&app, std::slice::from_ref(&token))?;
    Ok(token)
}

#[tauri::command]
async fn refresh_market_tokens(app: tauri::AppHandle, mints: Vec<String>) -> Result<Vec<MarketToken>, String> {
    let tokens = market::tokens_by_mints(&mints, jupiter_requests::Priority::HeldMark).await?;
    live_trading::record_market_marks(&app, &tokens)?;
    Ok(tokens)
}

#[tauri::command]
async fn record_calibration_snapshot(
    app: tauri::AppHandle,
    snapshot: MarketSnapshot,
) -> Result<calibration::CalibrationStatus, String> {
    calibration::record(&app, &snapshot).await
}

#[tauri::command]
fn calibration_status(app: tauri::AppHandle) -> Result<calibration::CalibrationStatus, String> {
    calibration::status(&app)
}

#[tauri::command]
fn export_calibration_csv(app: tauri::AppHandle) -> Result<String, String> {
    calibration::export_csv(&app)
}

#[tauri::command]
fn import_research_artifact(
    app: tauri::AppHandle,
) -> Result<calibration::CalibrationStatus, String> {
    calibration::import_research_artifact(&app)
}

#[tauri::command]
fn forget_research_artifact(
    app: tauri::AppHandle,
) -> Result<calibration::CalibrationStatus, String> {
    calibration::forget_research_artifact(&app)
}

#[tauri::command]
fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        jupiter_configured: configured("JUPITER_API_KEY"),
        helius_configured: configured("HELIUS_API_KEY"),
        laserstream_configured: configured("HELIUS_LASERSTREAM_ENDPOINT"),
        live_execution_available: true,
        model_name: "Compact tree ensemble baseline".into(),
        model_status: "Uncalibrated · strategy heuristic".into(),
    }
}

#[tauri::command]
fn estimate_paper_quote(
    token: MarketToken,
    input_usd: f64,
    max_price_impact_pct: f64,
    min_liquidity_usd: f64,
) -> QuoteEstimate {
    model::quote_estimate(&token, input_usd, max_price_impact_pct, min_liquidity_usd)
}

#[tauri::command]
fn wallet_status() -> Result<WalletStatus, String> {
    wallet::status()
}

#[tauri::command]
async fn import_wallet_file() -> Result<WalletStatus, String> {
    live_trading::disarm();
    live_canary::disarm();
    let _guard = wallet_operation_guard().await;
    wallet::import_file()
}

#[tauri::command]
async fn forget_wallet() -> Result<WalletStatus, String> {
    live_trading::disarm();
    live_canary::disarm();
    let _guard = wallet_operation_guard().await;
    wallet::forget()
}

#[tauri::command]
async fn wallet_portfolio() -> Result<WalletPortfolio, String> {
    wallet::portfolio().await
}

#[tauri::command]
fn approved_paper_writeoffs(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("approved-paper-writeoffs.json");
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!([])),
        Err(_) => return Err("Could not read approved paper adjustments".into()),
    };
    if bytes.len() > 65536 { return Err("Paper adjustment file is too large".into()); }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid paper adjustment file")?;
    if !value.as_array().is_some_and(|rows| rows.len() <= 100) { return Err("Invalid paper adjustment list".into()); }
    Ok(value)
}

#[tauri::command]
fn live_canary_status(app: tauri::AppHandle) -> Result<LiveCanaryStatus, String> {
    live_canary::status(&app)
}

#[tauri::command]
async fn arm_live_canary(
    app: tauri::AppHandle,
    acknowledgement: String,
) -> Result<LiveCanaryStatus, String> {
    let generation = live_trading::generation();
    let _guard = wallet_operation_guard().await;
    let automatic = live_trading::status(&app).await?;
    if automatic.armed || automatic.pending_count > 0 || !automatic.positions.is_empty() {
        return Err("Manual swaps are unavailable while automatic live positions or unresolved orders exist. Use Live wallet to manage them.".into());
    }
    if live_trading::generation() != generation {
        return Err("Live activation was cancelled by Stop or a wallet change.".into());
    }
    live_canary::arm(acknowledgement)?;
    live_canary::status(&app)
}

#[tauri::command]
fn disarm_live_canary(app: tauri::AppHandle) -> Result<LiveCanaryStatus, String> {
    live_canary::disarm();
    live_canary::status(&app)
}

#[tauri::command]
async fn preview_live_canary(
    app: tauri::AppHandle,
    request: LiveCanaryRequest,
) -> Result<LiveCanaryPreview, String> {
    live_canary::preview(&app, request).await
}

#[tauri::command]
async fn execute_live_canary(
    app: tauri::AppHandle,
    challenge_id: String,
    confirmation_phrase: String,
) -> Result<LiveCanaryExecution, String> {
    let _guard = wallet_operation_guard().await;
    let automatic = live_trading::status(&app).await?;
    if automatic.armed || automatic.pending_count > 0 || !automatic.positions.is_empty() {
        return Err("Use Live wallet while automatic positions or unresolved orders exist.".into());
    }
    live_canary::execute(&app, challenge_id, confirmation_phrase).await
}

#[tauri::command]
async fn live_trading_status(app: tauri::AppHandle) -> Result<live_trading::LiveTradingStatus, String> {
    live_trading::status(&app).await
}

#[tauri::command]
async fn arm_live_trading(
    app: tauri::AppHandle,
    config: live_trading::LiveTradingConfig,
    acknowledgement: String,
) -> Result<live_trading::LiveTradingStatus, String> {
    let generation = live_trading::generation();
    let _guard = wallet_operation_guard().await;
    if live_trading::generation() != generation {
        return Err("Live activation was cancelled while waiting for a wallet operation.".into());
    }
    live_canary::disarm();
    live_trading::arm(&app, config, acknowledgement).await
}

#[tauri::command]
async fn disarm_live_trading(app: tauri::AppHandle) -> Result<live_trading::LiveTradingStatus, String> {
    live_trading::disarm();
    live_trading::status(&app).await
}

#[tauri::command]
async fn quarantine_live_position(app: tauri::AppHandle, owner: String, position_id: String) -> Result<live_trading::LiveTradingStatus, String> {
    let _guard = wallet_operation_guard().await;
    live_trading::quarantine_position(&app, owner, position_id).await
}

#[tauri::command]
async fn execute_live_trading(
    app: tauri::AppHandle,
    request: live_trading::LiveTradingRequest,
) -> Result<live_trading::LiveTradingStatus, String> {
    let generation = live_trading::generation();
    let _guard = wallet_operation_guard().await;
    if live_trading::generation() != generation {
        return Err("Live order was cancelled while waiting for a wallet operation.".into());
    }
    live_trading::execute(&app, request).await
}

fn configured(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            refresh_market,
            refresh_market_token,
            refresh_market_tokens,
            record_calibration_snapshot,
            calibration_status,
            export_calibration_csv,
            import_research_artifact,
            forget_research_artifact,
            runtime_info,
            estimate_paper_quote,
            wallet_status,
            import_wallet_file,
            forget_wallet,
            wallet_portfolio,
            approved_paper_writeoffs,
            live_canary_status,
            arm_live_canary,
            disarm_live_canary,
            preview_live_canary,
            execute_live_canary,
            live_trading_status,
            arm_live_trading,
            disarm_live_trading,
            execute_live_trading,
            quarantine_live_position
        ])
        .run(tauri::generate_context!())
        .expect("error while running PulseForge");
}
