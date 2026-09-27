use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{SecondsFormat, Utc};
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Signature, Signer},
    transaction::VersionedTransaction,
};
use tauri::Manager;

use crate::{
    market,
    types::{
        LiveCanaryExecution, LiveCanaryPreview, LiveCanaryRequest, LiveCanaryStatus,
        LiveCanaryTrade, MarketToken,
    },
    wallet::{self, GAS_RESERVE_SOL, SOL_MINT},
};

pub const ACKNOWLEDGEMENT: &str = "I UNDERSTAND LIVE TRADES USE REAL FUNDS";
const MAX_ORDER_USD: f64 = 10.0;
const MIN_ORDER_USD: f64 = 1.0;
const DAILY_BUY_CAP_USD: f64 = 25.0;
const MAX_PRICE_IMPACT_PCT: f64 = 1.0;
const MAX_SLIPPAGE_BPS: u64 = 100;
const MAX_FEE_BPS: u64 = 50;
const COOLDOWN_SECONDS: u64 = 60;
const CHALLENGE_TTL_SECONDS: i64 = 60;
const MIN_LIQUIDITY_USD: f64 = 50_000.0;
const MAX_TOP_TEN_HOLDER_PCT: f64 = 35.0;
const MAX_TRANSFER_TAX_PCT: f64 = 1.0;

static ARMED: AtomicBool = AtomicBool::new(false);
static CHALLENGE_COUNTER: AtomicU64 = AtomicU64::new(1);
static CHALLENGES: OnceLock<Mutex<HashMap<String, PendingChallenge>>> = OnceLock::new();
static EXECUTION_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Buy,
    Sell,
}

impl Side {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_uppercase().as_str() {
            "BUY" => Ok(Self::Buy),
            "SELL" => Ok(Self::Sell),
            _ => Err("Live canary side must be BUY or SELL".into()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Buy => "BUY",
            Self::Sell => "SELL",
        }
    }
}

#[derive(Debug, Clone)]
struct PendingChallenge {
    id: String,
    created_at_ms: i64,
    side: Side,
    mint: String,
    symbol: String,
    input_mint: String,
    output_mint: String,
    input_raw: u64,
    requested_usd: Option<f64>,
    router: String,
    confirmation_phrase: String,
}

#[derive(Debug, Clone)]
struct OrderSummary {
    transaction: Option<String>,
    request_id: String,
    input_mint: String,
    output_mint: String,
    input_raw: u64,
    output_raw: u64,
    price_impact_pct: f64,
    slippage_bps: u64,
    fee_bps: u64,
    router: String,
}

pub fn arm(acknowledgement: String) -> Result<(), String> {
    if acknowledgement.trim() != ACKNOWLEDGEMENT {
        return Err(format!("Type exactly: {ACKNOWLEDGEMENT}"));
    }
    prerequisites()?;
    ARMED.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn disarm() {
    ARMED.store(false, Ordering::SeqCst);
    if let Ok(mut challenges) = challenge_store().lock() {
        challenges.clear();
    }
}

pub fn status(app: &tauri::AppHandle) -> Result<LiveCanaryStatus, String> {
    let blocker = prerequisites().err();
    let available = blocker.is_none();
    let (daily_buy_used_usd, last_success_ms, recent_trades) = audit_summary(app)?;
    let cooldown_remaining_seconds = cooldown_remaining(last_success_ms);
    Ok(LiveCanaryStatus {
        available,
        armed: available && ARMED.load(Ordering::SeqCst),
        blocker,
        max_order_usd: MAX_ORDER_USD,
        daily_buy_cap_usd: DAILY_BUY_CAP_USD,
        daily_buy_used_usd,
        max_price_impact_pct: MAX_PRICE_IMPACT_PCT,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        cooldown_seconds: COOLDOWN_SECONDS,
        cooldown_remaining_seconds,
        acknowledgement_phrase: ACKNOWLEDGEMENT.into(),
        recent_trades,
    })
}

pub async fn preview(
    app: &tauri::AppHandle,
    request: LiveCanaryRequest,
) -> Result<LiveCanaryPreview, String> {
    require_armed()?;
    let side = Side::parse(&request.side)?;
    let mint = request
        .mint
        .parse::<Pubkey>()
        .map_err(|_| "Selected token address is not a valid Solana mint".to_string())?
        .to_string();
    if mint == SOL_MINT {
        return Err("Wrapped SOL is not a supported live-canary target".into());
    }

    let token = market::token_by_mint(&mint).await?;
    if side == Side::Buy {
        validate_buy_token(&token)?;
    }
    enforce_session_limits(app, side, request.amount_usd)?;

    let keypair = wallet::load_keypair()?;
    let owner = keypair.pubkey().to_string();
    drop(keypair);
    let client = http_client()?;
    let (input_mint, output_mint, input_raw, input_label, requested_usd, sell_percent) =
        match side {
            Side::Buy => {
                let amount_usd = validate_buy_amount(request.amount_usd)?;
                let (sol_balance, sol_price) = sol_balance_and_price(&client, &owner).await?;
                let sol_amount = amount_usd / sol_price;
                if sol_balance - sol_amount < GAS_RESERVE_SOL {
                    return Err(format!(
                        "The buy would leave less than the fixed {GAS_RESERVE_SOL:.2} SOL network-fee reserve"
                    ));
                }
                let raw = to_raw_amount(sol_amount, 9)?;
                (
                    SOL_MINT.into(),
                    mint.clone(),
                    raw,
                    format!("{sol_amount:.6} SOL (~${amount_usd:.2})"),
                    Some(amount_usd),
                    None,
                )
            }
            Side::Sell => {
                let percent = validate_sell_percent(request.sell_percent)?;
                let (balance_raw, decimals) = token_balance(&client, &owner, &mint).await?;
                let raw = ((balance_raw as u128 * percent as u128) / 100) as u64;
                if raw == 0 {
                    return Err("This wallet has no spendable balance for the selected token".into());
                }
                let display = raw as f64 / 10_f64.powi(decimals as i32);
                (
                    mint.clone(),
                    SOL_MINT.into(),
                    raw,
                    format!("{display:.6} {} ({percent}%)", token.symbol),
                    None,
                    Some(percent),
                )
            }
        };

    let order = fetch_order(&client, &owner, &input_mint, &output_mint, input_raw).await?;
    validate_order(&order, &input_mint, &output_mint, input_raw, false)?;
    let output_decimals = if side == Side::Buy {
        mint_decimals(&client, &mint).await?
    } else {
        9
    };

    let challenge_id = format!(
        "lc-{}-{}",
        Utc::now().timestamp_millis(),
        CHALLENGE_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let mint_tail = mint.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>();
    let confirmation_phrase = format!("{} {} {}", side.as_str(), token.symbol, mint_tail);
    let output_display = order.output_raw as f64 / 10_f64.powi(output_decimals as i32);
    let expected_output_label = if side == Side::Buy {
        format!("{output_display:.6} {} (estimated)", token.symbol)
    } else {
        format!("{output_display:.6} SOL (estimated)")
    };
    let expires_at = (Utc::now() + chrono::Duration::seconds(CHALLENGE_TTL_SECONDS))
        .to_rfc3339_opts(SecondsFormat::Secs, true);

    let pending = PendingChallenge {
        id: challenge_id.clone(),
        created_at_ms: Utc::now().timestamp_millis(),
        side,
        mint: mint.clone(),
        symbol: token.symbol.clone(),
        input_mint,
        output_mint,
        input_raw,
        requested_usd,
        router: order.router.clone(),
        confirmation_phrase: confirmation_phrase.clone(),
    };
    challenge_store()
        .lock()
        .map_err(|_| "Live challenge lock is poisoned".to_string())?
        .insert(challenge_id.clone(), pending);

    Ok(LiveCanaryPreview {
        challenge_id,
        side: side.as_str().into(),
        mint,
        symbol: token.symbol,
        input_label,
        expected_output_label,
        requested_usd,
        sell_percent,
        price_impact_pct: order.price_impact_pct,
        slippage_bps: order.slippage_bps,
        fee_bps: order.fee_bps,
        router: order.router,
        expires_at,
        confirmation_phrase,
    })
}

pub async fn execute(
    app: &tauri::AppHandle,
    challenge_id: String,
    confirmation_phrase: String,
) -> Result<LiveCanaryExecution, String> {
    let _execution_guard = EXECUTION_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    require_armed()?;
    let pending = challenge_store()
        .lock()
        .map_err(|_| "Live challenge lock is poisoned".to_string())?
        .remove(&challenge_id)
        .ok_or_else(|| "This live preview has expired or was already used".to_string())?;
    if pending.id != challenge_id {
        return Err("Live preview identifier mismatch".into());
    }
    if Utc::now().timestamp_millis() - pending.created_at_ms > CHALLENGE_TTL_SECONDS * 1_000 {
        return Err("This live preview expired; request a fresh quote".into());
    }
    if confirmation_phrase.trim() != pending.confirmation_phrase {
        return Err(format!("Type exactly: {}", pending.confirmation_phrase));
    }

    let result = execute_inner(app, &pending).await;
    match &result {
        Ok(execution) => record_audit(
            app,
            &pending,
            "Success",
            Some(&execution.signature),
            Some(&pending.router),
            None,
        )?,
        Err(error) => record_audit(app, &pending, "Failed", None, Some(&pending.router), Some(error))?,
    }
    result
}

async fn execute_inner(
    app: &tauri::AppHandle,
    pending: &PendingChallenge,
) -> Result<LiveCanaryExecution, String> {
    enforce_session_limits(app, pending.side, pending.requested_usd)?;
    if pending.side == Side::Buy {
        let refreshed = market::token_by_mint(&pending.mint).await?;
        validate_buy_token(&refreshed)?;
    }

    let keypair = wallet::load_keypair()?;
    let owner = keypair.pubkey().to_string();
    let client = http_client()?;
    let order = fetch_order(
        &client,
        &owner,
        &pending.input_mint,
        &pending.output_mint,
        pending.input_raw,
    )
    .await?;
    validate_order(
        &order,
        &pending.input_mint,
        &pending.output_mint,
        pending.input_raw,
        true,
    )?;
    let encoded = order
        .transaction
        .as_deref()
        .ok_or_else(|| "Jupiter did not return a signable transaction".to_string())?;
    require_armed()?;
    let signed_transaction = sign_versioned_transaction(encoded, &keypair)?;
    drop(keypair);

    let api_key = jupiter_api_key()?;
    require_armed()?;
    let response = client
        .post("https://api.jup.ag/swap/v2/execute")
        .header("x-api-key", api_key)
        .json(&json!({
            "signedTransaction": signed_transaction,
            "requestId": order.request_id,
        }))
        .send()
        .await
        .map_err(|error| format!("Jupiter execute request failed: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Jupiter execute response was invalid: {error}"))?;
    if !status.is_success() {
        return Err(format!("Jupiter execute HTTP {status}: {}", response_message(&body)));
    }
    let execution_status = text_field(&body, &["status"]).unwrap_or_default();
    let code = u64_field(&body, &["code"]).unwrap_or(u64::MAX);
    if execution_status != "Success" || code != 0 {
        return Err(format!("Jupiter execution failed: {}", response_message(&body)));
    }
    let signature = text_field(&body, &["signature"])
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Jupiter reported success without a transaction signature".to_string())?;
    let input_amount = text_field(&body, &["totalInputAmount", "inputAmount"])
        .unwrap_or_else(|| pending.input_raw.to_string());
    let output_amount = text_field(&body, &["totalOutputAmount", "outputAmount"])
        .unwrap_or_else(|| order.output_raw.to_string());

    Ok(LiveCanaryExecution {
        status: execution_status,
        signature: signature.clone(),
        side: pending.side.as_str().into(),
        mint: pending.mint.clone(),
        symbol: pending.symbol.clone(),
        input_amount,
        output_amount,
        explorer_url: format!("https://solscan.io/tx/{signature}"),
    })
}

fn validate_buy_amount(amount: Option<f64>) -> Result<f64, String> {
    let value = amount.ok_or_else(|| "Enter a live buy amount in USD".to_string())?;
    if !value.is_finite() || !(MIN_ORDER_USD..=MAX_ORDER_USD).contains(&value) {
        return Err(format!(
            "Manual live buys must be between ${MIN_ORDER_USD:.0} and ${MAX_ORDER_USD:.0}"
        ));
    }
    Ok((value * 100.0).round() / 100.0)
}

fn validate_sell_percent(percent: Option<u8>) -> Result<u8, String> {
    let value = percent.ok_or_else(|| "Choose a sell percentage".to_string())?;
    if !matches!(value, 25 | 50 | 100) {
        return Err("Live canary sells are limited to 25%, 50%, or 100%".into());
    }
    Ok(value)
}

fn validate_buy_token(token: &MarketToken) -> Result<(), String> {
    let mut blockers = Vec::new();
    if matches!(token.risk_level.as_str(), "High" | "Med-High") {
        blockers.push(format!("Risk level {} is outside the live-canary boundary", token.risk_level));
    }
    if !token.safety.mint_authority_revoked {
        blockers.push("Mint authority is not confirmed revoked".into());
    }
    if !token.safety.freeze_authority_revoked {
        blockers.push("Freeze authority is not confirmed revoked".into());
    }
    if token.safety.top_ten_holder_pct > MAX_TOP_TEN_HOLDER_PCT {
        blockers.push(format!("Top-ten holders exceed {MAX_TOP_TEN_HOLDER_PCT:.0}%"));
    }
    if token.safety.transfer_tax_pct > MAX_TRANSFER_TAX_PCT {
        blockers.push(format!("Transfer tax exceeds {MAX_TRANSFER_TAX_PCT:.0}%"));
    }
    if token.liquidity_usd < MIN_LIQUIDITY_USD {
        blockers.push(format!("Observed liquidity is below ${MIN_LIQUIDITY_USD:.0}"));
    }
    if blockers.is_empty() {
        Ok(())
    } else {
        Err(format!("Live buy blocked: {}", blockers.join("; ")))
    }
}

fn enforce_session_limits(
    app: &tauri::AppHandle,
    side: Side,
    requested_usd: Option<f64>,
) -> Result<(), String> {
    let (daily_used, last_success_ms, _) = audit_summary(app)?;
    let cooldown = cooldown_remaining(last_success_ms);
    if cooldown > 0 {
        return Err(format!("Live canary cooldown has {cooldown}s remaining"));
    }
    if side == Side::Buy {
        let amount = validate_buy_amount(requested_usd)?;
        if daily_used + amount > DAILY_BUY_CAP_USD + 0.001 {
            return Err(format!(
                "This buy would exceed the ${DAILY_BUY_CAP_USD:.0} UTC daily live-buy cap (${daily_used:.2} already used)"
            ));
        }
    }
    Ok(())
}

fn prerequisites() -> Result<(), String> {
    jupiter_api_key()?;
    wallet::load_keypair().map(|_| ())?;
    Ok(())
}

fn require_armed() -> Result<(), String> {
    prerequisites()?;
    if !ARMED.load(Ordering::SeqCst) {
        return Err("Manual live canary is disarmed for this app session".into());
    }
    Ok(())
}

fn jupiter_api_key() -> Result<String, String> {
    std::env::var("JUPITER_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "JUPITER_API_KEY is required for manual live canary swaps".to_string())
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("PulseForge/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())
}

async fn fetch_order(
    client: &Client,
    owner: &str,
    input_mint: &str,
    output_mint: &str,
    input_raw: u64,
) -> Result<OrderSummary, String> {
    let amount = input_raw.to_string();
    let response = crate::jupiter_requests::send(client
        .get("https://api.jup.ag/swap/v2/order")
        .header("x-api-key", jupiter_api_key()?)
        .query(&[
            ("inputMint", input_mint),
            ("outputMint", output_mint),
            ("amount", amount.as_str()),
            ("taker", owner),
        ]), crate::jupiter_requests::Priority::Entry).await?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Jupiter order response was invalid: {error}"))?;
    if !status.is_success() {
        return Err(format!("Jupiter order HTTP {status}: {}", response_message(&body)));
    }
    parse_order(&body)
}

fn parse_order(body: &Value) -> Result<OrderSummary, String> {
    Ok(OrderSummary {
        transaction: text_field(body, &["transaction"]),
        request_id: text_field(body, &["requestId"])
            .ok_or_else(|| "Jupiter order omitted requestId".to_string())?,
        input_mint: text_field(body, &["inputMint"])
            .ok_or_else(|| "Jupiter order omitted inputMint".to_string())?,
        output_mint: text_field(body, &["outputMint"])
            .ok_or_else(|| "Jupiter order omitted outputMint".to_string())?,
        input_raw: u64_field(body, &["inAmount", "inputAmount"])
            .ok_or_else(|| "Jupiter order omitted inAmount".to_string())?,
        output_raw: u64_field(body, &["outAmount", "outputAmount"])
            .ok_or_else(|| "Jupiter order omitted outAmount".to_string())?,
        price_impact_pct: f64_field(body, &["priceImpactPct"]).unwrap_or(f64::INFINITY),
        slippage_bps: u64_field(body, &["slippageBps"]).unwrap_or(u64::MAX),
        fee_bps: u64_field(body, &["feeBps"]).unwrap_or(u64::MAX),
        router: text_field(body, &["router"]).unwrap_or_else(|| "unknown".into()),
    })
}

fn validate_order(
    order: &OrderSummary,
    input_mint: &str,
    output_mint: &str,
    input_raw: u64,
    require_transaction: bool,
) -> Result<(), String> {
    if order.input_mint != input_mint || order.output_mint != output_mint {
        return Err("Jupiter route mints do not match the requested swap".into());
    }
    if order.input_raw != input_raw {
        return Err("Jupiter route input amount changed unexpectedly".into());
    }
    if order.output_raw == 0 {
        return Err("Jupiter route has zero expected output".into());
    }
    if !order.price_impact_pct.is_finite() || order.price_impact_pct > MAX_PRICE_IMPACT_PCT {
        return Err(format!(
            "Jupiter route impact {:.2}% exceeds the {:.2}% hard cap",
            order.price_impact_pct, MAX_PRICE_IMPACT_PCT
        ));
    }
    if order.slippage_bps > MAX_SLIPPAGE_BPS {
        return Err(format!(
            "Jupiter route slippage {} bps exceeds the {} bps hard cap",
            order.slippage_bps, MAX_SLIPPAGE_BPS
        ));
    }
    if order.fee_bps > MAX_FEE_BPS {
        return Err(format!(
            "Jupiter route fee {} bps exceeds the {} bps hard cap",
            order.fee_bps, MAX_FEE_BPS
        ));
    }
    if require_transaction && order.transaction.as_deref().unwrap_or_default().is_empty() {
        return Err("Jupiter did not return a signable transaction".into());
    }
    Ok(())
}

fn sign_versioned_transaction(encoded: &str, keypair: &solana_sdk::signature::Keypair) -> Result<String, String> {
    let bytes = BASE64
        .decode(encoded)
        .map_err(|error| format!("Jupiter transaction was not valid base64: {error}"))?;
    let mut transaction: VersionedTransaction = bincode::deserialize(&bytes)
        .map_err(|error| format!("Jupiter transaction could not be decoded: {error}"))?;
    let required = transaction.message.header().num_required_signatures as usize;
    let signer_index = transaction
        .message
        .static_account_keys()
        .iter()
        .take(required)
        .position(|key| key == &keypair.pubkey())
        .ok_or_else(|| "Imported wallet is not a required signer in the Jupiter transaction".to_string())?;
    if transaction.signatures.len() < required {
        transaction.signatures.resize(required, Signature::default());
    }
    transaction.signatures[signer_index] = keypair.sign_message(&transaction.message.serialize());
    let signed = bincode::serialize(&transaction)
        .map_err(|error| format!("Signed transaction could not be encoded: {error}"))?;
    Ok(BASE64.encode(signed))
}

async fn sol_balance_and_price(client: &Client, owner: &str) -> Result<(f64, f64), String> {
    let balance_response = client
        .post(wallet::rpc_url())
        .json(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "getBalance",
            "params": [owner, { "commitment": "confirmed" }]
        }))
        .send()
        .await
        .map_err(|error| format!("Solana balance request failed: {error}"))?;
    let balance_body: Value = balance_response
        .json()
        .await
        .map_err(|error| format!("Solana balance response was invalid: {error}"))?;
    let lamports = balance_body.pointer("/result/value").and_then(Value::as_u64)
        .ok_or_else(|| response_message(&balance_body))?;

    let price_response = crate::jupiter_requests::send(client
        .get(format!("https://api.jup.ag/price/v3?ids={SOL_MINT}"))
        .header("x-api-key", jupiter_api_key()?), crate::jupiter_requests::Priority::Entry).await?;
    let price_body: Value = price_response
        .json()
        .await
        .map_err(|error| format!("SOL price response was invalid: {error}"))?;
    let price = price_body
        .pointer(&format!("/{SOL_MINT}/usdPrice"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| "Jupiter did not return a positive SOL/USD price".to_string())?;
    Ok((lamports as f64 / 1_000_000_000.0, price))
}

async fn token_balance(client: &Client, owner: &str, mint: &str) -> Result<(u64, u8), String> {
    let response = client
        .post(wallet::rpc_url())
        .json(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
            "params": [owner, { "mint": mint }, { "encoding": "jsonParsed", "commitment": "confirmed" }]
        }))
        .send()
        .await
        .map_err(|error| format!("Solana token-balance request failed: {error}"))?;
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Solana token-balance response was invalid: {error}"))?;
    let accounts = body.pointer("/result/value").and_then(Value::as_array)
        .ok_or_else(|| response_message(&body))?;
    let mut total: u128 = 0;
    let mut decimals = None;
    for account in accounts {
        let amount = account.pointer("/account/data/parsed/info/tokenAmount/amount")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let account_decimals = account.pointer("/account/data/parsed/info/tokenAmount/decimals")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok());
        if let Some(account_decimals) = account_decimals {
            if decimals.is_some_and(|known| known != account_decimals) {
                return Err("Token accounts reported inconsistent decimal precision".into());
            }
            decimals = Some(account_decimals);
        }
        total = total.saturating_add(amount as u128);
    }
    let total = u64::try_from(total).map_err(|_| "Token balance exceeds supported range".to_string())?;
    Ok((total, decimals.ok_or_else(|| "No token account was found for this mint".to_string())?))
}

async fn mint_decimals(client: &Client, mint: &str) -> Result<u8, String> {
    let response = client
        .post(wallet::rpc_url())
        .json(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "getTokenSupply",
            "params": [mint, { "commitment": "confirmed" }]
        }))
        .send()
        .await
        .map_err(|error| format!("Solana mint-precision request failed: {error}"))?;
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Solana mint-precision response was invalid: {error}"))?;
    body.pointer("/result/value/decimals")
        .and_then(Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .ok_or_else(|| response_message(&body))
}

fn to_raw_amount(display: f64, decimals: u8) -> Result<u64, String> {
    let scaled = (display * 10_f64.powi(decimals as i32)).floor();
    if !scaled.is_finite() || scaled < 1.0 || scaled > u64::MAX as f64 {
        return Err("The requested amount cannot be represented on-chain".into());
    }
    Ok(scaled as u64)
}

fn challenge_store() -> &'static Mutex<HashMap<String, PendingChallenge>> {
    CHALLENGES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cooldown_remaining(last_success_ms: Option<i64>) -> u64 {
    let Some(last_success_ms) = last_success_ms else { return 0 };
    let elapsed = (Utc::now().timestamp_millis() - last_success_ms).max(0) as u64 / 1_000;
    COOLDOWN_SECONDS.saturating_sub(elapsed)
}

fn db_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let connection = Connection::open(directory.join("live-canary-v1.sqlite3"))
        .map_err(|error| format!("Could not open live trade journal: {error}"))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS live_canary_trades (
            id TEXT PRIMARY KEY,
            created_at_ms INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            side TEXT NOT NULL,
            mint TEXT NOT NULL,
            symbol TEXT NOT NULL,
            requested_usd REAL,
            status TEXT NOT NULL,
            signature TEXT,
            router TEXT,
            detail TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_live_canary_created ON live_canary_trades(created_at_ms);",
    ).map_err(|error| format!("Could not initialize live trade journal: {error}"))?;
    Ok(connection)
}

fn audit_summary(app: &tauri::AppHandle) -> Result<(f64, Option<i64>, Vec<LiveCanaryTrade>), String> {
    let connection = db_connection(app)?;
    let day_start = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("midnight is valid")
        .and_utc()
        .timestamp_millis();
    let daily_buy_used = connection
        .query_row(
            "SELECT COALESCE(SUM(requested_usd), 0) FROM live_canary_trades WHERE side='BUY' AND status='Success' AND created_at_ms>=?1",
            params![day_start],
            |row| row.get::<_, f64>(0),
        )
        .map_err(|error| error.to_string())?;
    let last_success = connection
        .query_row(
            "SELECT created_at_ms FROM live_canary_trades WHERE status='Success' ORDER BY created_at_ms DESC LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT id, created_at, side, mint, symbol, requested_usd, status, signature, router, detail FROM live_canary_trades ORDER BY created_at_ms DESC LIMIT 10")
        .map_err(|error| error.to_string())?;
    let recent = statement
        .query_map([], |row| {
            Ok(LiveCanaryTrade {
                id: row.get(0)?, created_at: row.get(1)?, side: row.get(2)?, mint: row.get(3)?,
                symbol: row.get(4)?, requested_usd: row.get(5)?, status: row.get(6)?,
                signature: row.get(7)?, router: row.get(8)?, detail: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok((daily_buy_used, last_success, recent))
}

fn record_audit(
    app: &tauri::AppHandle,
    pending: &PendingChallenge,
    status: &str,
    signature: Option<&str>,
    router: Option<&str>,
    detail: Option<&str>,
) -> Result<(), String> {
    let connection = db_connection(app)?;
    let now = Utc::now();
    connection.execute(
        "INSERT INTO live_canary_trades (id, created_at_ms, created_at, side, mint, symbol, requested_usd, status, signature, router, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            pending.id, now.timestamp_millis(), now.to_rfc3339_opts(SecondsFormat::Secs, true),
            pending.side.as_str(), pending.mint, pending.symbol, pending.requested_usd, status,
            signature, router, detail,
        ],
    ).map_err(|error| format!("Could not record live trade journal: {error}"))?;
    Ok(())
}

fn text_field(value: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| value.get(*name)).and_then(|field| match field {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn u64_field(value: &Value, names: &[&str]) -> Option<u64> {
    names.iter().find_map(|name| value.get(*name)).and_then(|field| {
        field.as_u64().or_else(|| field.as_str()?.parse().ok())
    })
}

fn f64_field(value: &Value, names: &[&str]) -> Option<f64> {
    names.iter().find_map(|name| value.get(*name)).and_then(|field| {
        field.as_f64().or_else(|| field.as_str()?.parse().ok())
    })
}

fn response_message(value: &Value) -> String {
    text_field(value, &["error", "message", "errorMessage", "status"])
        .unwrap_or_else(|| "provider returned no explanation".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_jupiter_order_caps_and_identity() {
        let order = parse_order(&json!({
            "requestId": "r1", "inputMint": SOL_MINT, "outputMint": "mint",
            "inAmount": "1000", "outAmount": "2000", "priceImpactPct": "0.25",
            "slippageBps": 50, "feeBps": 10, "router": "jupiter", "transaction": "abc"
        })).unwrap();
        assert!(validate_order(&order, SOL_MINT, "mint", 1000, true).is_ok());
        let mut unsafe_order = order.clone();
        unsafe_order.price_impact_pct = 1.01;
        assert!(validate_order(&unsafe_order, SOL_MINT, "mint", 1000, true).is_err());
    }

    #[test]
    fn live_buy_size_and_sell_fraction_are_hard_bounded() {
        assert_eq!(validate_buy_amount(Some(5.0)).unwrap(), 5.0);
        assert!(validate_buy_amount(Some(10.01)).is_err());
        assert!(validate_buy_amount(Some(f64::NAN)).is_err());
        assert_eq!(validate_sell_percent(Some(25)).unwrap(), 25);
        assert!(validate_sell_percent(Some(75)).is_err());
    }
}
