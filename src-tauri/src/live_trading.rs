//! Owner-bound live automation. Signing is confined to `execute`; status and
//! recovery never resubmit a transaction or infer a fill from a quote.
mod quarantine;
#[path = "live_entry_safety.rs"]
mod entry_safety;
use crate::{
    market,
    types::MarketToken,
    wallet::{self, GAS_RESERVE_SOL, SOL_MINT},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Signature, Signer},
    transaction::VersionedTransaction,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::Manager;

const ACK: &str = "I AUTHORIZE AUTOMATIC TRADING WITH REAL FUNDS";
const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM: &str = "11111111111111111111111111111111";
const JUPITER: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const LOOKUP: &str = "AddressLookupTab1e1111111111111111111111111";
const MAX_FEE_BPS: u64 = 50;
pub const MAX_TRANSACTION_COST_SOL: f64 = 0.02;
const MAINNET_GENESIS: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);
static EXECUTION: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LiveEntryMode {
    GuardedDiscovery,
    PaperSignals,
}
impl Default for LiveEntryMode {
    fn default() -> Self { Self::GuardedDiscovery }
}

/// Native-enforced entry criteria captured when the owner starts a session.
/// Paper fills supply a signal only; their prices and quantities are never used.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaperEntryCriteria {
    pub min_token_age_seconds: f64,
    pub max_token_age_seconds: f64,
    pub min_liquidity_usd: f64,
    pub max_top_ten_holder_pct: f64,
    pub min_traders_5m: u64,
    pub min_sells_5m: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveTradingConfig {
    pub max_order_usd: f64,
    pub daily_buy_cap_usd: f64,
    pub max_open_positions: usize,
    pub daily_loss_limit_usd: f64,
    pub max_slippage_bps: u64,
    pub max_price_impact_pct: f64,
    pub min_liquidity_usd: f64,
    pub allow_high_risk: bool,
    #[serde(default)]
    pub entry_mode: LiveEntryMode,
    #[serde(default)]
    pub paper_entry_criteria: Option<PaperEntryCriteria>,
}
impl Default for LiveTradingConfig {
    fn default() -> Self {
        Self {
            max_order_usd: 5.0,
            daily_buy_cap_usd: 25.0,
            max_open_positions: 2,
            daily_loss_limit_usd: 10.0,
            max_slippage_bps: 100,
            max_price_impact_pct: 2.0,
            min_liquidity_usd: entry_safety::MIN_LIQUIDITY_USD,
            allow_high_risk: false,
            entry_mode: LiveEntryMode::GuardedDiscovery,
            paper_entry_criteria: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTradingRequest {
    pub session_generation: u64,
    pub intent_id: String,
    pub side: String,
    pub mint: String,
    pub amount_usd: Option<f64>,
    pub position_id: Option<String>,
    pub reason: String,
    pub signal_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePosition {
    pub id: String,
    pub mint: String,
    pub symbol: String,
    pub quantity_raw: String,
    pub decimals: u8,
    pub entry_price_usd: f64,
    pub cost_basis_usd: f64,
    pub opened_at_ms: i64,
    pub high_water_price_usd: f64,
    pub last_price_usd: f64,
    #[serde(default)]
    pub entry_liquidity_usd: f64,
    #[serde(default)]
    pub last_mark_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveOrder {
    pub id: String,
    pub side: String,
    pub mint: String,
    pub symbol: String,
    pub status: String,
    pub signature: Option<String>,
    pub amount_usd: Option<f64>,
    pub detail: Option<String>,
    pub created_at_ms: i64,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTradingStatus {
    pub entry_safety: HashMap<String, entry_safety::EntrySafetyStatus>,
    pub exit_attempts: HashMap<String, LiveExitAttempt>,
    pub session_generation: u64,
    pub available: bool,
    pub armed: bool,
    pub owner: Option<String>,
    pub blocker: Option<String>,
    pub config: LiveTradingConfig,
    pub acknowledgement_phrase: String,
    pub daily_buy_used_usd: f64,
    pub daily_realized_pnl_usd: f64,
    pub daily_quarantine_loss_usd: f64,
    pub quarantined_positions: Vec<quarantine::QuarantinedPosition>,
    pub pending_count: usize,
    pub positions: Vec<LivePosition>,
    pub recent_orders: Vec<LiveOrder>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveExitAttempt {
    pub order: LiveOrder,
    pub retry_after_ms: i64,
}

#[derive(Clone)]
struct Session {
    owner: String,
    config: LiveTradingConfig,
    generation: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Journal {
    order: LiveOrder,
    owner: String,
    position_id: Option<String>,
    input_raw: u64,
    expected_output_raw: u64,
    sol_price_usd: f64,
    decimals: u8,
    entry_liquidity_usd: f64,
    request_id: Option<String>,
    /// Exact account key order of the persisted signed message, including ALTs.
    account_keys: Vec<String>,
    input_mint: String,
    output_mint: String,
    #[serde(default)]
    realized_pnl_usd: f64,
    #[serde(default)]
    recent_blockhash: Option<String>,
    #[serde(default)]
    expiry_after_block_height: Option<u64>,
    #[serde(default)]
    market_at_ms: i64,
    #[serde(default)]
    rent_refund_lamports: u64,
    #[serde(default)]
    settled_at_ms: Option<i64>,
}
#[derive(Clone)]
struct Account {
    lamports: u64,
    program: String,
    data: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq)]
struct TokenAccount {
    mint: String,
    owner: String,
    amount: u64,
    delegate: Option<[u8; 32]>,
    close_authority: Option<[u8; 32]>,
    state: u8,
}
struct Route {
    transaction: String,
    request_id: String,
    output_raw: u64,
}

fn session_store() -> &'static Mutex<Option<Session>> {
    SESSION.get_or_init(|| Mutex::new(None))
}
fn execution_lock() -> &'static tokio::sync::Mutex<()> {
    EXECUTION.get_or_init(|| tokio::sync::Mutex::new(()))
}
fn now() -> i64 {
    Utc::now().timestamp_millis()
}
fn day_start() -> i64 {
    Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("midnight")
        .and_utc()
        .timestamp_millis()
}
fn pending(status: &str) -> bool {
    matches!(status, "Prepared" | "Pending" | "Unknown")
}

pub fn disarm() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut session) = session_store().lock() {
        *session = None;
    }
}
pub fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

pub async fn arm(
    app: &tauri::AppHandle,
    config: LiveTradingConfig,
    acknowledgement: String,
) -> Result<LiveTradingStatus, String> {
    let requested_generation = GENERATION.load(Ordering::SeqCst);
    validate_config(&config)?;
    if acknowledgement.trim() != ACK {
        return Err(format!("Type exactly: {ACK}"));
    }
    let _guard = execution_lock().lock().await;
    api_key()?;
    let owner = current_owner()?;
    let client = client()?;
    verify_mainnet(&client).await?;
    let mut connection = db(app)?;
    reconcile_all(&client, &mut connection, &owner).await?;
    connection.execute("INSERT INTO live_config(owner, config) VALUES(?1,?2) ON CONFLICT(owner) DO UPDATE SET config=excluded.config", params![owner, serde_json::to_string(&config).map_err(db_error)?]).map_err(db_error)?;
    let mut session = session_store()
        .lock()
        .map_err(|_| "Live session lock unavailable")?;
    if GENERATION.load(Ordering::SeqCst) != requested_generation {
        return Err("Live arming was cancelled by Stop or a wallet change".into());
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    *session = Some(Session {
        owner: owner.clone(),
        config: config.clone(),
        generation,
    });
    drop(session);
    status_from_db(&connection, Some(owner), None)
}

pub async fn quarantine_position(app: &tauri::AppHandle, owner: String, position_id: String) -> Result<LiveTradingStatus, String> {
    let _guard = execution_lock().lock().await;
    if current_owner()? != owner { return Err("Imported wallet changed; reload the position before quarantining".into()); }
    if session_store().lock().map_err(|_| "Live session lock unavailable")?.is_some() {
        return Err("Stop the live session before quarantining a position".into());
    }
    let mut connection = db(app)?;
    quarantine::apply(&mut connection, &owner, &position_id, now())?;
    status_from_db(&connection, Some(owner), None)
}

pub async fn status(app: &tauri::AppHandle) -> Result<LiveTradingStatus, String> {
    let owner_result = current_owner();
    let owner = owner_result.as_ref().ok().cloned();
    let mut blocker = owner_result.err().or_else(|| api_key().err());
    {
        let session = session_store()
            .lock()
            .map_err(|_| "Live session lock unavailable")?
            .clone();
        if session
            .as_ref()
            .is_some_and(|s| owner.as_deref() != Some(s.owner.as_str()))
        {
            disarm();
        }
    }
    if let Some(ref owner) = owner {
        let _guard = execution_lock().lock().await;
        let mut connection = db(app)?;
        if let Err(error) = reconcile_all(&client()?, &mut connection, owner).await {
            blocker = Some(error);
        }
    }
    status_from_db(&db(app)?, owner, blocker)
}

/// Called only with market observations fetched inside the native refresh
/// commands, never exposed as a WebView-supplied mark command.
pub fn record_market_marks(app: &tauri::AppHandle, tokens: &[MarketToken]) -> Result<(), String> {
    let at = now();
    // A cache failure blocks BUY validation, but must not prevent held-token
    // marks, SELL handling or wallet reconciliation from continuing.
    let _ = entry_safety::record(tokens, at);
    record_marks(&mut db(app)?, tokens, at)
}
fn record_marks(
    connection: &mut Connection,
    tokens: &[MarketToken],
    at: i64,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let rows = {
        let mut statement = transaction
            .prepare("SELECT owner,payload FROM live_positions")
            .map_err(db_error)?;
        let values = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        values
    };
    for (owner, payload) in rows {
        let mut position: LivePosition = serde_json::from_str(&payload).map_err(db_error)?;
        if let Some(token) = tokens.iter().find(|token| token.mint == position.mint) {
            if valid_market_time(token, at).is_err()
                || !token.price_usd.is_finite()
                || token.price_usd <= 0.0
            {
                continue;
            }
            let timestamp = chrono::DateTime::parse_from_rfc3339(&token.updated_at)
                .map_err(db_error)?
                .timestamp_millis();
            if timestamp <= position.last_mark_at_ms {
                continue;
            }
            position.last_price_usd = token.price_usd;
            position.high_water_price_usd = position.high_water_price_usd.max(token.price_usd);
            position.last_mark_at_ms = timestamp;
            transaction
                .execute(
                    "UPDATE live_positions SET payload=?1 WHERE owner=?2 AND id=?3",
                    params![
                        serde_json::to_string(&position).map_err(db_error)?,
                        owner,
                        position.id
                    ],
                )
                .map_err(db_error)?;
        }
    }
    transaction.commit().map_err(db_error)
}

pub async fn execute(
    app: &tauri::AppHandle,
    request: LiveTradingRequest,
) -> Result<LiveTradingStatus, String> {
    let requested_generation = generation();
    let _guard = execution_lock().lock().await;
    if generation() != requested_generation {
        return Err("Queued live intent was cancelled by a session or wallet change".into());
    }
    let session = session_store()
        .lock()
        .map_err(|_| "Live session lock unavailable")?
        .clone()
        .ok_or("Live automation is disarmed")?;
    if request.session_generation != session.generation
        || request.session_generation != requested_generation
    {
        return Err(
            "Live intent belongs to an earlier session; refresh live status before trading".into(),
        );
    }
    ensure_session(&session)?;
    validate_identity(&request)?;
    let mut connection = db(app)?;
    // Every valid identity is permanently consumed, including failed attempts.
    if load_order(&connection, &session.owner, &request.intent_id)?.is_some() {
        return Err("This live intent was already processed; inspect its existing order".into());
    }
    let mut journal = Journal {
        order: LiveOrder {
            id: request.intent_id.clone(),
            side: request.side.clone(),
            mint: request.mint.clone(),
            symbol: request.mint.chars().take(6).collect(),
            status: "Prepared".into(),
            signature: None,
            amount_usd: request.amount_usd,
            detail: None,
            created_at_ms: now(),
            reason: request.reason.clone(),
        },
        owner: session.owner.clone(),
        position_id: request.position_id.clone(),
        input_raw: 0,
        expected_output_raw: 0,
        sol_price_usd: 0.0,
        decimals: 0,
        entry_liquidity_usd: 0.0,
        request_id: None,
        account_keys: vec![],
        input_mint: String::new(),
        output_mint: String::new(),
        realized_pnl_usd: 0.0,
        recent_blockhash: None,
        expiry_after_block_height: None,
        market_at_ms: 0,
        rent_refund_lamports: 0,
        settled_at_ms: None,
    };
    insert_order(&connection, &journal)?;
    let result = execute_inner(&mut connection, &session, &request, &mut journal).await;
    if let Err(error) = result {
        // A persisted signature means the outcome may already exist on-chain.
        journal.order.status =
            if journal.order.signature.is_some() && journal.order.status != "Failed" {
                "Unknown"
            } else {
                "Failed"
            }
            .into();
        journal.order.detail = Some(error.clone());
        save_order(&connection, &journal)?;
        if journal.order.signature.is_none() {
            return Err(error);
        }
    }
    status_from_db(&connection, Some(session.owner), None)
}

async fn execute_inner(
    connection: &mut Connection,
    session: &Session,
    request: &LiveTradingRequest,
    journal: &mut Journal,
) -> Result<(), String> {
    let client = client()?;
    verify_mainnet(&client).await?;
    reconcile_all(&client, connection, &session.owner).await?;
    validate_signal(request.signal_at_ms, now())?;
    let positions = load_positions(connection, &session.owner)?;
    let orders = load_orders(connection, &session.owner)?;
    let others: Vec<_> = orders
        .iter()
        .filter(|o| o.order.id != request.intent_id)
        .collect();
    if others
        .iter()
        .any(|o| pending(&o.order.status) && o.order.mint == request.mint)
    {
        return Err(
            "This mint has an unresolved live transaction; waiting for reconciliation".into(),
        );
    }
    if request.side == "BUY" {
        let quarantined = quarantine::load(connection, &session.owner)?;
        quarantine::validate_entry(&quarantined, &request.mint, totals(others.iter().copied(), day_start()).1, session.config.daily_loss_limit_usd, day_start())?;
    }
    let priority = if request.side == "SELL" { crate::jupiter_requests::Priority::Exit } else { crate::jupiter_requests::Priority::Entry };
    let _exit_priority = (request.side == "SELL").then(crate::jupiter_requests::prioritize_exit);
    let (sol_lamports, sol_price) = balance_and_price(&client, &session.owner, priority).await?;
    journal.sol_price_usd = sol_price;
    let token_accounts = owned_token_accounts(&client, &session.owner).await?;
    if request.side == "BUY" {
        validate_entry_limits(
            &session.config,
            request.amount_usd,
            &positions,
            &others,
            day_start(),
        )?;
        if positions.iter().any(|p| p.mint == request.mint)
            || token_accounts
                .iter()
                .any(|(_, t)| t.mint == request.mint && t.amount > 0)
        {
            return Err("This wallet already holds the mint; automatic buys cannot mix with existing holdings".into());
        }
        let token = market::token_by_mint(&request.mint).await?;
        // Include the fresh native BUY lookup. Guarded discovery still requires
        // a full history; paper signals use independently fresh native evidence.
        entry_safety::record(std::slice::from_ref(&token), now())?;
        validate_buy_token(&token, &session.config, now())?;
        validate_entry_observations(&request.side, &request.mint, &session.config, now())?;
        journal.market_at_ms = chrono::DateTime::parse_from_rfc3339(&token.updated_at)
            .map_err(|_| "Invalid token market timestamp")?
            .timestamp_millis();
        journal.order.symbol = token.symbol;
        journal.entry_liquidity_usd = token.liquidity_usd;
        journal.decimals = mint_decimals(&client, &request.mint).await?;
        journal.input_raw =
            raw_sol(request.amount_usd.ok_or("Live buy amount is required")? / sol_price)?;
        journal.input_mint = SOL_MINT.into();
        journal.output_mint = request.mint.clone();
        if sol_lamports < journal.input_raw.saturating_add(reserve_lamports()) {
            return Err(format!(
                "Insufficient native SOL after the {GAS_RESERVE_SOL:.2} SOL fee and rent reserve"
            ));
        }
    } else {
        let position_id = request
            .position_id
            .as_deref()
            .ok_or("Live sell requires a managed position ID")?;
        let position = positions
            .iter()
            .find(|p| p.id == position_id && p.mint == request.mint)
            .ok_or("Managed position does not belong to this wallet and mint")?;
        let managed = parse_raw(&position.quantity_raw)?;
        let actual = token_accounts
            .iter()
            .filter(|(_, t)| t.mint == request.mint)
            .try_fold(0u64, |sum, (_, t)| {
                sum.checked_add(t.amount).ok_or("Token balance overflow")
            })?;
        journal.input_raw = managed.min(actual);
        if journal.input_raw == 0 {
            return Err("Managed position has no spendable on-chain tokens; reconcile the external withdrawal before trading".into());
        }
        journal.order.symbol = position.symbol.clone();
        journal.decimals = position.decimals;
        journal.input_mint = request.mint.clone();
        journal.output_mint = SOL_MINT.into();
        if sol_lamports < reserve_lamports() {
            return Err("Insufficient native SOL for the configured network fee reserve".into());
        }
    }
    save_order(connection, journal)?;
    let route = fetch_route(&client, session, journal).await?;
    if route.request_id.is_empty() || route.request_id.len() > 256 {
        return Err("Jupiter returned an invalid request identifier".into());
    }
    if others
        .iter()
        .any(|o| o.request_id.as_deref() == Some(route.request_id.as_str()))
    {
        return Err("Jupiter reused an execution request identifier".into());
    }
    let (mut transaction, keys) =
        decode_transaction(&client, &route.transaction, &session.owner).await?;
    journal.account_keys = keys.clone();
    journal.recent_blockhash = Some(transaction.message.recent_blockhash().to_string());
    // Conservative bound beyond the normal recent-blockhash processing window.
    // Never confuse a new hash not yet rooted with an expired old hash.
    journal.expiry_after_block_height = Some(
        rpc(
            &client,
            "getBlockHeight",
            json!([{"commitment":"confirmed"}]),
        )
        .await?
        .as_u64()
        .ok_or("RPC omitted confirmed block height")?
        .saturating_add(300),
    );
    journal.expected_output_raw = route.output_raw;
    journal.request_id = Some(route.request_id.clone());
    let before = get_accounts(&client, &keys).await?;
    validate_instructions(
        &transaction,
        &keys,
        &session.owner,
        journal,
        &session.config,
    )?;
    // Simulate unsigned with signature verification disabled. No transaction is
    // signed until the complete account effect checks have passed.
    let simulation = rpc(&client, "simulateTransaction", json!([route.transaction, {"encoding":"base64", "sigVerify":false, "replaceRecentBlockhash":false, "commitment":"confirmed", "accounts":{"encoding":"base64", "addresses":keys}}])).await?;
    if !simulation.pointer("/value/err").is_some_and(Value::is_null) {
        return Err("Swap simulation failed; no transaction was submitted".into());
    }
    let after = simulation
        .pointer("/value/accounts")
        .and_then(Value::as_array)
        .ok_or("Simulation omitted account effects")?
        .iter()
        .map(parse_account)
        .collect::<Result<Vec<_>, _>>()?;
    journal.rent_refund_lamports = simulation_rent_refund(journal, &before, &after)?;
    validate_effects(journal, &before, &after, session.config.max_slippage_bps)?;
    if request.side == "BUY" {
        // One quote-only reverse check immediately before signing, using the same
        // supported router and limits. No taker: no transaction is assembled.
        preflight_sell_route(&client, session, journal, route.output_raw).await?;
    }
    ensure_session(session)?;
    validate_signal(request.signal_at_ms, now())?;
    if request.side == "BUY" {
        validate_signal(journal.market_at_ms, now())?;
    }
    let keypair = wallet::load_keypair()?;
    if keypair.pubkey().to_string() != session.owner {
        return Err("Imported wallet changed; live automation must be rearmed".into());
    }
    // Recheck native source/receipt freshness and the captured entry policy
    // after route/simulation work, immediately before signing. No extra fetch.
    validate_entry_observations(&request.side, &request.mint, &session.config, now())?;
    transaction.signatures[0] = keypair.sign_message(&transaction.message.serialize());
    drop(keypair);
    let signature = transaction.signatures[0].to_string();
    let signed = BASE64.encode(
        bincode::serialize(&transaction).map_err(|_| "Could not serialize the validated swap")?,
    );
    journal.order.signature = Some(signature);
    journal.order.status = "Pending".into();
    journal.order.detail = Some("Signed intent saved; awaiting on-chain confirmation".into());
    // FULL synchronous SQLite commit precedes the first possible submission.
    save_order(connection, journal)?;
    if let Err(error) = ensure_session(session) {
        journal.order.status = "Failed".into();
        journal.order.detail =
            Some("Disarmed before submission; signed transaction was never sent".into());
        save_order(connection, journal)?;
        return Err(error);
    }
    let send_result = send_route(&client, &signed, &route.request_id).await;
    journal.order.detail = Some(match send_result {
        Ok(()) => "Submitted; waiting for verified on-chain balances".into(),
        Err(error) => error,
    });
    save_order(connection, journal)?;
    reconcile_one(&client, connection, journal).await?;
    Ok(())
}

fn validate_config(config: &LiveTradingConfig) -> Result<(), String> {
    if !config.max_order_usd.is_finite() || !(1.0..=1000.0).contains(&config.max_order_usd) {
        return Err("Maximum live order must be between $1 and $1,000".into());
    }
    if !config.daily_buy_cap_usd.is_finite()
        || config.daily_buy_cap_usd < config.max_order_usd
        || config.daily_buy_cap_usd > 10000.0
    {
        return Err("Daily buy cap must cover one order and cannot exceed $10,000".into());
    }
    if !(1..=25).contains(&config.max_open_positions)
        || !config.daily_loss_limit_usd.is_finite()
        || !(1.0..=10000.0).contains(&config.daily_loss_limit_usd)
    {
        return Err("Invalid live position or loss limit".into());
    }
    if !(1..=500).contains(&config.max_slippage_bps)
        || !config.max_price_impact_pct.is_finite()
        || config.max_price_impact_pct <= 0.0
        || config.max_price_impact_pct > 5.0
    {
        return Err("Live slippage must be 1–500 bps and impact above zero through 5%".into());
    }
    if !config.min_liquidity_usd.is_finite() || config.min_liquidity_usd < 2000.0 {
        return Err("Live minimum liquidity must be at least $2,000".into());
    }
    if config.entry_mode == LiveEntryMode::PaperSignals {
        validate_paper_entry_criteria(config.paper_entry_criteria.as_ref()
            .ok_or("Paper signal mode requires entry criteria captured at session start")?)?;
    } else if let Some(criteria) = &config.paper_entry_criteria {
        // Reject malformed supplied data even when this session does not use it.
        validate_paper_entry_criteria(criteria)?;
    }
    Ok(())
}

fn validate_paper_entry_criteria(criteria: &PaperEntryCriteria) -> Result<(), String> {
    if !criteria.min_token_age_seconds.is_finite()
        || !criteria.max_token_age_seconds.is_finite()
        || criteria.min_token_age_seconds < 0.0
        || criteria.max_token_age_seconds < criteria.min_token_age_seconds
        || criteria.max_token_age_seconds > 1_000_000_000_000.0
    {
        return Err("Paper signal pool-age limits must be finite, nonnegative and ordered".into());
    }
    if !criteria.min_liquidity_usd.is_finite() || criteria.min_liquidity_usd < 2000.0 {
        return Err("Paper signal minimum liquidity must be at least $2,000".into());
    }
    if !criteria.max_top_ten_holder_pct.is_finite()
        || !(0.0..=35.0).contains(&criteria.max_top_ten_holder_pct)
        || criteria.min_traders_5m > 1_000_000_000
        || criteria.min_sells_5m > 1_000_000_000
    {
        return Err("Paper signal holder concentration or activity limits are invalid".into());
    }
    Ok(())
}
fn validate_identity(request: &LiveTradingRequest) -> Result<(), String> {
    if request.intent_id.len() < 8
        || request.intent_id.len() > 128
        || !request
            .intent_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_:./".contains(&c))
    {
        return Err("Invalid live intent identifier".into());
    }
    if !matches!(request.side.as_str(), "BUY" | "SELL") {
        return Err("Live side must be BUY or SELL".into());
    }
    request
        .mint
        .parse::<Pubkey>()
        .map_err(|_| "Invalid Solana mint")?;
    if request.mint == SOL_MINT {
        return Err("Wrapped SOL cannot be the target mint".into());
    }
    if request.reason.is_empty() || request.reason.len() > 512 {
        return Err("A bounded live strategy reason is required".into());
    }
    if request.side == "SELL" && request.amount_usd.is_some() {
        return Err("Managed sells use exact owned token quantities, not USD amounts".into());
    }
    Ok(())
}
fn validate_signal(signal: i64, at: i64) -> Result<(), String> {
    if signal <= 0 || signal > at + 5000 || at.saturating_sub(signal) > 75_000 {
        Err("Live signal is stale or has an invalid timestamp".into())
    } else {
        Ok(())
    }
}
fn valid_market_time(token: &MarketToken, at: i64) -> Result<(), String> {
    let time = chrono::DateTime::parse_from_rfc3339(&token.updated_at)
        .map_err(|_| "Token market timestamp is missing")?
        .timestamp_millis();
    validate_signal(time, at)
}
fn validate_buy_token(
    token: &MarketToken,
    config: &LiveTradingConfig,
    at: i64,
) -> Result<(), String> {
    valid_market_time(token, at)?;
    match config.entry_mode {
        LiveEntryMode::GuardedDiscovery => entry_safety::validate_token(token, at)?,
        LiveEntryMode::PaperSignals => {
            entry_safety::validate_source(token, at)?;
            let criteria = config.paper_entry_criteria.as_ref()
                .ok_or("Paper signal mode requires entry criteria captured at session start")?;
            validate_paper_entry_criteria(criteria)?;
            let age = token.age_seconds as f64;
            if age < criteria.min_token_age_seconds || age > criteria.max_token_age_seconds {
                return Err("Live pool age is outside the captured paper entry limits".into());
            }
            if !token.liquidity_usd.is_finite() || token.liquidity_usd < criteria.min_liquidity_usd {
                return Err("Live liquidity is below the captured paper entry minimum".into());
            }
            if !token.safety.top_ten_holder_pct.is_finite()
                || !(0.0..=criteria.max_top_ten_holder_pct).contains(&token.safety.top_ten_holder_pct)
                || token.traders_5m < criteria.min_traders_5m
                || token.sells_5m < criteria.min_sells_5m
            {
                return Err("Live token fails the captured paper holder or activity limits".into());
            }
        }
    }
    if !token.price_usd.is_finite()
        || token.price_usd <= 0.0
        || !token.liquidity_usd.is_finite()
        || token.liquidity_usd < config.min_liquidity_usd
    {
        return Err("Live token price or liquidity does not meet the session limits".into());
    }
    if !token.safety.mint_authority_revoked
        || !token.safety.freeze_authority_revoked
        || token.safety.transfer_tax_unknown
        || !token.safety.transfer_tax_pct.is_finite()
        || token.safety.transfer_tax_pct < 0.0
        || token.safety.transfer_tax_pct > 1.0
        || !token.safety.top_ten_holder_pct.is_finite()
        || token.safety.top_ten_holder_pct < 0.0
        || token.safety.top_ten_holder_pct > 35.0
    {
        return Err(
            "Live token failed authority, transfer-fee or holder-concentration safety checks"
                .into(),
        );
    }
    if !config.allow_high_risk && matches!(token.risk_level.as_str(), "High" | "Med-High") {
        return Err("Token risk is outside the authorized live session".into());
    }
    Ok(())
}
fn validate_entry_observations(
    side: &str,
    mint: &str,
    config: &LiveTradingConfig,
    at: i64,
) -> Result<(), String> {
    if side != "BUY" {
        return Ok(());
    }
    match config.entry_mode {
        LiveEntryMode::GuardedDiscovery =>
            entry_safety::validate_cached(mint, at, |token| validate_buy_token(token, config, at)),
        LiveEntryMode::PaperSignals =>
            entry_safety::validate_latest_cached(mint, at, |token| validate_buy_token(token, config, at)),
    }
}
fn validate_entry_limits(
    config: &LiveTradingConfig,
    amount: Option<f64>,
    positions: &[LivePosition],
    orders: &[&Journal],
    start: i64,
) -> Result<(), String> {
    let amount = amount.ok_or("Live buy amount is required")?;
    if !amount.is_finite() || amount < 1.0 || amount > config.max_order_usd {
        return Err("Live buy exceeds the authorized per-order limit".into());
    }
    if orders.iter().any(|o| pending(&o.order.status)) {
        return Err("A live order is unresolved; new buys wait for confirmation".into());
    }
    let (spent, pnl) = totals(orders.iter().copied(), start);
    if spent + amount > config.daily_buy_cap_usd + 0.000001 {
        return Err("Live UTC daily buy cap reached".into());
    }
    if pnl <= -config.daily_loss_limit_usd {
        return Err(
            "Live UTC daily realized-loss limit reached; managed exits remain available".into(),
        );
    }
    if positions.len() >= config.max_open_positions {
        return Err("Maximum live open positions reached".into());
    }
    Ok(())
}
fn ensure_session(expected: &Session) -> Result<(), String> {
    let session = session_store()
        .lock()
        .map_err(|_| "Live session lock unavailable")?;
    validate_session_identity(
        expected,
        session.as_ref(),
        GENERATION.load(Ordering::SeqCst),
    )?;
    drop(session);
    if current_owner()? != expected.owner {
        disarm();
        return Err("Imported wallet changed; live automation is disarmed".into());
    }
    Ok(())
}
fn validate_session_identity(
    expected: &Session,
    current: Option<&Session>,
    generation: u64,
) -> Result<(), String> {
    if generation != expected.generation
        || !current
            .is_some_and(|s| s.owner == expected.owner && s.generation == expected.generation)
    {
        return Err("Live automation was disarmed; no new submission is authorized".into());
    }
    Ok(())
}
fn current_owner() -> Result<String, String> {
    let keypair =
        wallet::load_keypair().map_err(|_| "Import a Solana wallet to use live trading")?;
    Ok(keypair.pubkey().to_string())
}
fn api_key() -> Result<String, String> {
    std::env::var("JUPITER_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "JUPITER_API_KEY is required for live swaps".into())
}
fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(3))
        .user_agent(concat!("PulseForge/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Could not create live network client".into())
}
async fn read_json(mut response: reqwest::Response, label: &str) -> Result<Value, String> {
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        while let Ok(Some(chunk)) = response.chunk().await {
            if bytes.len() + chunk.len() > 4096 { break; }
            bytes.extend_from_slice(&chunk);
        }
        return Err(provider_http_error(label, status, &bytes));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE as u64)
    {
        return Err(format!("{label} response exceeded the size limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| format!("{label} response interrupted"))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(format!("{label} response exceeded the size limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| format!("{label} returned invalid JSON"))
}

fn provider_http_error(label: &str, status: u16, bytes: &[u8]) -> String {
    let body = serde_json::from_slice::<Value>(bytes).ok();
    let detail = body.as_ref().and_then(|body| {
        ["/error", "/errorMessage", "/message", "/error/message"].iter()
            .find_map(|pointer| body.pointer(pointer).and_then(Value::as_str))
    }).map(|message| message.chars().filter(|c| !c.is_control()).take(200).collect::<String>())
        .filter(|message| !message.trim().is_empty());
    match detail {
        Some(detail) => format!("{label} returned HTTP {status}: {detail}"),
        None => format!("{label} returned HTTP {status}"),
    }
}
async fn rpc(client: &Client, method: &str, parameters: Value) -> Result<Value, String> {
    let response = client
        .post(wallet::rpc_url())
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":parameters}))
        .send()
        .await
        .map_err(|_| format!("Solana {method} request unavailable"))?;
    let body = read_json(response, "Solana RPC").await?;
    if body.get("error").is_some() {
        return Err(format!("Solana {method} returned an RPC error"));
    }
    body.get("result")
        .cloned()
        .ok_or_else(|| format!("Solana {method} omitted its result"))
}
async fn verify_mainnet(client: &Client) -> Result<(), String> {
    validate_genesis(&rpc(client, "getGenesisHash", json!([])).await?)
}
fn validate_genesis(value: &Value) -> Result<(), String> {
    if value.as_str() != Some(MAINNET_GENESIS) {
        return Err("Live trading requires a Solana mainnet RPC".into());
    }
    Ok(())
}
async fn balance_and_price(client: &Client, owner: &str, priority: crate::jupiter_requests::Priority) -> Result<(u64, f64), String> {
    let balance = rpc(
        client,
        "getBalance",
        json!([owner,{"commitment":"confirmed"}]),
    )
    .await?
    .get("value")
    .and_then(Value::as_u64)
    .ok_or("RPC omitted native SOL balance")?;
    let response = crate::jupiter_requests::send(client
        .get(format!("https://api.jup.ag/price/v3?ids={SOL_MINT}"))
        .header("x-api-key", api_key()?), priority).await?;
    let price = read_json(response, "SOL price")
        .await?
        .pointer(&format!("/{SOL_MINT}/usdPrice"))
        .and_then(Value::as_f64)
        .filter(|p| p.is_finite() && *p > 0.0)
        .ok_or("SOL/USD price is unavailable")?;
    Ok((balance, price))
}
async fn owned_token_accounts(
    client: &Client,
    owner: &str,
) -> Result<Vec<(String, TokenAccount)>, String> {
    let mut result = vec![];
    for program in [TOKEN, TOKEN_2022] {
        let body = rpc(
            client,
            "getTokenAccountsByOwner",
            json!([owner,{"programId":program},{"encoding":"base64","commitment":"confirmed"}]),
        )
        .await?;
        let values = body
            .get("value")
            .and_then(Value::as_array)
            .ok_or("RPC omitted token accounts")?;
        for value in values {
            let address = value
                .get("pubkey")
                .and_then(Value::as_str)
                .ok_or("Token account omitted address")?
                .to_string();
            let account = parse_account(value.get("account").ok_or("Token account omitted data")?)?
                .ok_or("Token account missing")?;
            let token = token_account(&account)?.ok_or("Invalid SPL token account")?;
            if token.owner != owner {
                return Err("RPC token account owner mismatch".into());
            }
            result.push((address, token));
        }
    }
    Ok(result)
}
async fn mint_decimals(client: &Client, mint: &str) -> Result<u8, String> {
    let value = rpc(
        client,
        "getTokenSupply",
        json!([mint,{"commitment":"confirmed"}]),
    )
    .await?;
    value
        .pointer("/value/decimals")
        .and_then(Value::as_u64)
        .filter(|d| *d <= 18)
        .map(|d| d as u8)
        .ok_or_else(|| "Unsupported token decimals".into())
}
fn raw_sol(value: f64) -> Result<u64, String> {
    let raw = (value * 1e9).floor();
    if !raw.is_finite() || raw < 1.0 || raw >= u64::MAX as f64 {
        Err("Invalid native SOL amount".into())
    } else {
        Ok(raw as u64)
    }
}
fn reserve_lamports() -> u64 {
    (GAS_RESERVE_SOL * 1e9) as u64
}
fn transaction_cost_lamports() -> u64 {
    (MAX_TRANSACTION_COST_SOL * 1e9) as u64
}
fn parse_raw(value: &str) -> Result<u64, String> {
    value
        .parse()
        .map_err(|_| "Invalid stored token quantity".into())
}
fn number(body: &Value, key: &str) -> Option<f64> {
    body.get(key)
        .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))
}
fn integer(body: &Value, key: &str) -> Option<u64> {
    body.get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
}
async fn fetch_route(
    client: &Client,
    session: &Session,
    journal: &Journal,
) -> Result<Route, String> {
    let response = crate::jupiter_requests::send(client
        .get("https://api.jup.ag/swap/v2/order")
        .header("x-api-key", api_key()?)
        .query(&[
            ("inputMint", journal.input_mint.as_str()),
            ("outputMint", journal.output_mint.as_str()),
            ("amount", &journal.input_raw.to_string()),
            ("taker", session.owner.as_str()),
            ("slippageBps", &session.config.max_slippage_bps.to_string()),
            ("excludeRouters", "jupiterz,dflow,okx"),
        ]), if journal.order.side == "SELL" { crate::jupiter_requests::Priority::Exit } else { crate::jupiter_requests::Priority::Entry }).await?;
    let body = read_json(response, "Jupiter order").await?;
    parse_route(&body, session, journal)
}
fn parse_quote(body: &Value, session: &Session, journal: &Journal) -> Result<u64, String> {
    if body.get("inputMint").and_then(Value::as_str) != Some(journal.input_mint.as_str())
        || body.get("outputMint").and_then(Value::as_str) != Some(journal.output_mint.as_str())
        || integer(body, "inAmount") != Some(journal.input_raw)
    {
        return Err("Jupiter route identity or input amount changed".into());
    }
    let impact = number(body, "priceImpactPct").ok_or("Jupiter omitted price impact")?;
    if !impact.is_finite() || impact.abs() > session.config.max_price_impact_pct {
        return Err("Jupiter route exceeds the live price-impact limit".into());
    }
    if integer(body, "slippageBps")
        .filter(|s| *s <= session.config.max_slippage_bps)
        .is_none()
    {
        return Err("Jupiter slippage is missing or exceeds the live limit".into());
    }
    if integer(body, "feeBps")
        .filter(|f| *f <= MAX_FEE_BPS)
        .is_none()
    {
        return Err("Jupiter fee is unknown or exceeds the 50 bps live fee cap".into());
    }
    let output_raw = integer(body, "outAmount")
        .filter(|n| *n > 0)
        .ok_or("Jupiter route has no output")?;
    Ok(output_raw)
}
fn parse_route(body: &Value, session: &Session, journal: &Journal) -> Result<Route, String> {
    let output_raw = parse_quote(body, session, journal)?;
    Ok(Route {
        transaction: body
            .get("transaction")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("Jupiter omitted a signable transaction")?
            .to_string(),
        request_id: body
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or("Jupiter omitted request ID")?
            .to_string(),
        output_raw,
    })
}
async fn preflight_sell_route(client: &Client, session: &Session, buy: &Journal, tokens: u64) -> Result<(), String> {
    let mut reverse = buy.clone();
    reverse.input_mint = buy.output_mint.clone();
    reverse.output_mint = buy.input_mint.clone();
    reverse.input_raw = tokens;
    let response = crate::jupiter_requests::send(client.get("https://api.jup.ag/swap/v2/order")
        .header("x-api-key", api_key()?)
        .query(&[("inputMint", reverse.input_mint.as_str()), ("outputMint", reverse.output_mint.as_str()),
            ("amount", &tokens.to_string()), ("slippageBps", &session.config.max_slippage_bps.to_string()),
            ("excludeRouters", "jupiterz,dflow,okx")]), crate::jupiter_requests::Priority::Entry).await
        .map_err(|error| format!("Buy blocked: sell-route preflight unavailable: {error}"))?;
    let body = read_json(response, "Sell-route preflight").await.map_err(|error| format!("Buy blocked: {error}"))?;
    let recovered = parse_quote(&body, session, &reverse).map_err(|error| format!("Buy blocked: sell-route preflight: {error}"))?;
    validate_roundtrip_recovery(buy.input_raw, recovered, &session.config)
}
fn validate_roundtrip_recovery(input: u64, recovered: u64, config: &LiveTradingConfig) -> Result<(), String> {
    // Sum both sides' existing impact, slippage and platform-fee allowances.
    let allowance_pct = 2.0 * (config.max_price_impact_pct + config.max_slippage_bps as f64 / 100.0 + MAX_FEE_BPS as f64 / 100.0);
    let minimum = input as f64 * (1.0 - allowance_pct / 100.0);
    if input == 0 || !minimum.is_finite() || minimum <= 0.0 || (recovered as f64) < minimum {
        return Err("Buy blocked: sell-route preflight would recover too little SOL within the configured cost allowances".into());
    }
    Ok(())
}

async fn send_route(client: &Client, signed: &str, request_id: &str) -> Result<(), String> {
    let response = client
        .post("https://api.jup.ag/swap/v2/execute")
        .header("x-api-key", api_key()?)
        .json(&json!({"signedTransaction":signed,"requestId":request_id}))
        .send()
        .await
        .map_err(|_| "Submission outcome unknown; checking the persisted signature on-chain")?;
    let body = read_json(response, "Jupiter submission").await?;
    if body.get("status").and_then(Value::as_str) != Some("Success")
        || integer(&body, "code") != Some(0)
    {
        return Err(
            "Provider did not confirm submission; checking the persisted signature on-chain".into(),
        );
    }
    Ok(())
}

async fn decode_transaction(
    client: &Client,
    encoded: &str,
    owner: &str,
) -> Result<(VersionedTransaction, Vec<String>), String> {
    if encoded.len() > 1800 {
        return Err("Jupiter transaction exceeds Solana packet bounds".into());
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Invalid transaction encoding")?;
    if bytes.len() > 1232 {
        return Err("Jupiter transaction exceeds Solana packet bounds".into());
    }
    let transaction: VersionedTransaction =
        bincode::deserialize(&bytes).map_err(|_| "Invalid versioned transaction")?;
    let required = transaction.message.header().num_required_signatures;
    if required != 1
        || transaction.signatures.len() != 1
        || transaction
            .message
            .static_account_keys()
            .first()
            .map(ToString::to_string)
            .as_deref()
            != Some(owner)
        || transaction.signatures[0] != Signature::default()
    {
        return Err("Live automation supports only an unsigned single-wallet fee-payer transaction; co-signed or gasless routes are unsupported".into());
    }
    let mut keys: Vec<String> = transaction
        .message
        .static_account_keys()
        .iter()
        .map(ToString::to_string)
        .collect();
    if let Some(lookups) = transaction.message.address_table_lookups() {
        let mut writable = vec![];
        let mut readonly = vec![];
        for lookup in lookups {
            let body=rpc(client,"getAccountInfo",json!([lookup.account_key.to_string(),{"encoding":"base64","commitment":"confirmed"}])).await?;
            let account = parse_account(body.get("value").ok_or("Lookup account missing")?)?
                .ok_or("Lookup table does not exist")?;
            if account.program != LOOKUP
                || account.data.len() < 56
                || (account.data.len() - 56) % 32 != 0
            {
                return Err("Invalid address lookup table".into());
            }
            for (indices, target) in [
                (&lookup.writable_indexes, &mut writable),
                (&lookup.readonly_indexes, &mut readonly),
            ] {
                for index in indices {
                    let offset = 56 + *index as usize * 32;
                    let bytes: [u8; 32] = account
                        .data
                        .get(offset..offset + 32)
                        .ok_or("Lookup index exceeds its table")?
                        .try_into()
                        .map_err(|_| "Invalid lookup address")?;
                    target.push(Pubkey::new_from_array(bytes).to_string());
                }
            }
        }
        keys.extend(writable);
        keys.extend(readonly);
    }
    if keys.len() > 100 || keys.iter().collect::<HashSet<_>>().len() != keys.len() {
        return Err("Swap has unsupported account count or duplicate account keys".into());
    }
    Ok((transaction, keys))
}

fn validate_instructions(
    transaction: &VersionedTransaction,
    keys: &[String],
    owner: &str,
    journal: &Journal,
    config: &LiveTradingConfig,
) -> Result<(), String> {
    let mut swap_count = 0;
    let wallet_key = owner.parse::<Pubkey>().map_err(|_| "Invalid wallet key")?;
    let token_key = TOKEN
        .parse::<Pubkey>()
        .map_err(|_| "Invalid token program")?;
    let sol_key = SOL_MINT.parse::<Pubkey>().map_err(|_| "Invalid SOL mint")?;
    let ata_key = ATA.parse::<Pubkey>().map_err(|_| "Invalid ATA program")?;
    let expected_wsol = Pubkey::find_program_address(
        &[wallet_key.as_ref(), token_key.as_ref(), sol_key.as_ref()],
        &ata_key,
    )
    .0
    .to_string();
    for instruction in transaction.message.instructions() {
        let program = keys
            .get(instruction.program_id_index as usize)
            .ok_or("Instruction program index out of bounds")?;
        let account = |index: usize| -> Result<&str, String> {
            keys.get(
                *instruction
                    .accounts
                    .get(index)
                    .ok_or("Instruction account omitted")? as usize,
            )
            .map(String::as_str)
            .ok_or_else(|| "Instruction account index out of bounds".into())
        };
        match program.as_str() {
            JUPITER=>{
                crate::live_route_validation::validate_jupiter_instruction(&instruction.data,journal.input_raw,journal.expected_output_raw,config.max_slippage_bps,MAX_FEE_BPS)?;
                swap_count+=1;
            },
            "ComputeBudget111111111111111111111111111111"=>{ if instruction.data.is_empty() { return Err("Invalid compute-budget instruction".into()); } },
            SYSTEM=>{
                // Only wrapping SOL into this wallet's canonical ATA. Tips and
                // arbitrary direct SOL transfers are not authorized here.
                if instruction.data.len()!=12 || instruction.data[..4]!=2u32.to_le_bytes() || account(0)?!=owner || account(1)?!=expected_wsol { return Err("Unsupported direct system transfer in swap".into()); }
            },
            TOKEN|TOKEN_2022=>{
                match instruction.data.first().copied() {
                    Some(17) if instruction.data.len()==1 && account(0)?==expected_wsol =>{},
                    Some(9) if instruction.data.len()==1 && account(1)?==owner && account(2)?==owner =>{},
                    _=>return Err("Swap contains an unsupported direct token instruction or authority/delegate change".into()),
                }
            },
            ATA=>{
                if !instruction.data.is_empty() && instruction.data!=[1] { return Err("Unsupported associated-token instruction".into()); }
                if account(0)?!=owner || account(2)?!=owner { return Err("Associated token account is not owned and funded by the session wallet".into()); }
            },
            _=>return Err("Swap uses an unsupported top-level program; no transaction was signed".into()),
        }
        for index in &instruction.accounts {
            if *index as usize >= keys.len() {
                return Err("Instruction account index out of bounds".into());
            }
        }
    }
    if swap_count != 1 {
        return Err("Transaction must contain exactly one supported Jupiter swap".into());
    }
    Ok(())
}

fn parse_account(value: &Value) -> Result<Option<Account>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let lamports = value
        .get("lamports")
        .and_then(Value::as_u64)
        .ok_or("Account omitted lamports")?;
    let program = value
        .get("owner")
        .and_then(Value::as_str)
        .ok_or("Account omitted program owner")?
        .to_string();
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .ok_or("Account omitted base64 data")?;
    if data.len() > 512 * 1024 {
        return Err("Account data exceeded live verification bounds".into());
    }
    let data = BASE64
        .decode(data)
        .map_err(|_| "Account data was not valid base64")?;
    Ok(Some(Account {
        lamports,
        program,
        data,
    }))
}
fn token_account(account: &Account) -> Result<Option<TokenAccount>, String> {
    if account.program != TOKEN && account.program != TOKEN_2022 {
        return Ok(None);
    }
    if account.data.len() < 165 {
        return Ok(None);
    } // A mint, not a token account.
    if account.data.len() > 165
        && (account.program != TOKEN_2022 || account.data.get(165) != Some(&2))
    {
        return Ok(None);
    }
    let bytes = &account.data;
    let key = |offset: usize| -> Result<String, String> {
        Ok(Pubkey::new_from_array(
            bytes[offset..offset + 32]
                .try_into()
                .map_err(|_| "Invalid token key")?,
        )
        .to_string())
    };
    let option = |offset: usize| -> Result<Option<[u8; 32]>, String> {
        match u32::from_le_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .map_err(|_| "Invalid token authority")?,
        ) {
            0 => Ok(None),
            1 => Ok(Some(
                bytes[offset + 4..offset + 36]
                    .try_into()
                    .map_err(|_| "Invalid token authority")?,
            )),
            _ => Err("Invalid token authority option".into()),
        }
    };
    Ok(Some(TokenAccount {
        mint: key(0)?,
        owner: key(32)?,
        amount: u64::from_le_bytes(
            bytes[64..72]
                .try_into()
                .map_err(|_| "Invalid token amount")?,
        ),
        delegate: option(72)?,
        close_authority: option(129)?,
        state: bytes[108],
    }))
}
async fn get_accounts(client: &Client, keys: &[String]) -> Result<Vec<Option<Account>>, String> {
    let result = rpc(
        client,
        "getMultipleAccounts",
        json!([keys,{"encoding":"base64","commitment":"confirmed"}]),
    )
    .await?;
    let accounts = result
        .get("value")
        .and_then(Value::as_array)
        .ok_or("RPC omitted transaction accounts")?;
    if accounts.len() != keys.len() {
        return Err("RPC account response length mismatch".into());
    }
    accounts.iter().map(parse_account).collect()
}
fn validate_effects(
    journal: &Journal,
    before: &[Option<Account>],
    after: &[Option<Account>],
    slippage_bps: u64,
) -> Result<(), String> {
    if before.len() != after.len() || before.len() != journal.account_keys.len() {
        return Err("Simulation account response length mismatch".into());
    }
    let owner_index = journal
        .account_keys
        .iter()
        .position(|key| key == &journal.owner)
        .ok_or("Simulation omitted wallet")?;
    let pre_sol = before[owner_index]
        .as_ref()
        .ok_or("Wallet account missing before swap")?;
    let post_sol = after[owner_index]
        .as_ref()
        .ok_or("Swap would close the wallet account")?;
    if pre_sol.program != SYSTEM || post_sol.program != SYSTEM || !post_sol.data.is_empty() {
        return Err("Swap would change wallet account ownership or data".into());
    }
    let mut deltas: HashMap<String, i128> = HashMap::new();
    for (pre, post) in before.iter().zip(after) {
        let pre_token = pre.as_ref().map(token_account).transpose()?.flatten();
        let post_token = post.as_ref().map(token_account).transpose()?.flatten();
        let owned_before = pre_token.as_ref().filter(|t| t.owner == journal.owner);
        let owned_after = post_token.as_ref().filter(|t| t.owner == journal.owner);
        if let Some(prior) = owned_before {
            if let Some(next) = post_token.as_ref() {
                if next.owner != journal.owner
                    || next.mint != prior.mint
                    || next.delegate != prior.delegate
                    || next.close_authority != prior.close_authority
                    || next.state != prior.state
                {
                    return Err("Simulation changes a wallet token authority, delegate, mint or frozen state".into());
                }
            } else if post.is_some() {
                return Err(
                    "Simulation replaces an owned token account with incompatible data".into(),
                );
            }
        }
        if owned_before.is_none() {
            if let Some(next) = owned_after {
                if next.delegate.is_some() || next.close_authority.is_some() || next.state != 1 {
                    return Err("Simulation creates an unsafe owned token account".into());
                }
            }
        }
        for (token, sign) in [(owned_before, -1i128), (owned_after, 1i128)] {
            if let Some(token) = token {
                *deltas.entry(token.mint.clone()).or_default() += sign * token.amount as i128;
            }
        }
        if owned_before.is_some() || owned_after.is_some() {
            let mint = owned_before
                .or(owned_after)
                .expect("owned token")
                .mint
                .as_str();
            if mint != journal.order.mint && mint != SOL_MINT && pre_token != post_token {
                return Err("Simulation changes another asset in the imported wallet".into());
            }
        }
    }
    if deltas
        .iter()
        .any(|(mint, delta)| mint != &journal.order.mint && mint != SOL_MINT && *delta != 0)
    {
        return Err("Simulation spends an unrelated wallet asset".into());
    }
    if deltas.get(SOL_MINT).copied().unwrap_or(0) != 0 {
        return Err("Simulation changes existing wrapped-SOL holdings".into());
    }
    let token_delta = deltas.get(&journal.order.mint).copied().unwrap_or(0);
    let sol_delta = post_sol.lamports as i128 - pre_sol.lamports as i128;
    if journal.order.side == "BUY" {
        let min_output =
            (journal.expected_output_raw as u128 * (10000 - slippage_bps) as u128 / 10000) as i128;
        let input_after_refund = journal.input_raw as i128 - journal.rent_refund_lamports as i128;
        if token_delta < min_output.max(1)
            || sol_delta >= 0
            || -sol_delta < input_after_refund
            || -sol_delta > input_after_refund + transaction_cost_lamports() as i128
        {
            return Err(
                "Simulation does not match the authorized buy debit and token output".into(),
            );
        }
    } else {
        let min_output =
            (journal.expected_output_raw as u128 * (10000 - slippage_bps) as u128 / 10000) as i128;
        // Output is net of network fees; the fixed reserve bounds their effect.
        if token_delta != -(journal.input_raw as i128) {
            return Err("Simulation token debit does not match the exact managed sell quantity; no transaction was submitted".into());
        }
        if sol_delta <= 0 {
            return Err("Sell blocked: simulated SOL proceeds do not exceed network fees and account rent; no transaction was submitted".into());
        }
        if sol_delta + (transaction_cost_lamports() as i128)
            < min_output + journal.rent_refund_lamports as i128
        {
            return Err("Simulation SOL output is below the quoted minimum after the authorized transaction-cost allowance; no transaction was submitted".into());
        }
    }
    if post_sol.lamports < reserve_lamports() {
        return Err("Simulated swap would consume the configured SOL reserve".into());
    }
    Ok(())
}
fn simulation_rent_refund(
    journal: &Journal,
    before: &[Option<Account>],
    after: &[Option<Account>],
) -> Result<u64, String> {
    if before.len() != after.len() {
        return Err("Simulation account response length mismatch".into());
    }
    let mut refund = 0u64;
    for (before, after) in before.iter().zip(after) {
        if after.is_some() {
            continue;
        }
        if let Some(account) = before {
            if let Some(token) = token_account(account)? {
                let permitted = (token.mint == SOL_MINT && token.amount == 0)
                    || (journal.order.side == "SELL" && token.mint == journal.order.mint);
                if token.owner == journal.owner && permitted {
                    refund = refund
                        .checked_add(account.lamports)
                        .ok_or("Rent refund overflow")?;
                }
            }
        }
    }
    Ok(refund)
}

async fn reconcile_all(
    client: &Client,
    connection: &mut Connection,
    owner: &str,
) -> Result<(), String> {
    let orders = load_orders(connection, owner)?;
    for mut journal in orders.into_iter().filter(|o| pending(&o.order.status)) {
        if journal.order.signature.is_none() {
            // A Prepared row cannot have been sent: signature persistence is
            // ordered before submission. Current in-flight row stays reserved.
            if journal.order.created_at_ms < now() - 120_000 {
                journal.order.status = "Failed".into();
                journal.order.detail =
                    Some("Interrupted before signing; no transaction was submitted".into());
                save_order(connection, &journal)?;
            }
            continue;
        }
        reconcile_one(client, connection, &mut journal).await?;
    }
    Ok(())
}
async fn reconcile_one(
    client: &Client,
    connection: &mut Connection,
    journal: &mut Journal,
) -> Result<(), String> {
    let signature = journal
        .order
        .signature
        .as_deref()
        .ok_or("Pending order has no signature")?;
    let statuses = rpc(
        client,
        "getSignatureStatuses",
        json!([[signature],{"searchTransactionHistory":true}]),
    )
    .await?;
    let observed = statuses
        .get("value")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or("RPC omitted signature status")?;
    if observed.is_null() {
        if let (Some(blockhash), Some(expiry_height)) = (
            journal.recent_blockhash.as_deref(),
            journal.expiry_after_block_height,
        ) {
            let finalized_height = rpc(
                client,
                "getBlockHeight",
                json!([{"commitment":"finalized"}]),
            )
            .await?
            .as_u64()
            .ok_or("RPC omitted finalized block height")?;
            if finalized_height <= expiry_height {
                return Ok(());
            }
            let valid = rpc(
                client,
                "isBlockhashValid",
                json!([blockhash,{"commitment":"finalized"}]),
            )
            .await?;
            if valid.get("value").and_then(Value::as_bool) == Some(false) {
                // After the blockhash is invalid at finalized commitment,
                // repeat both historical lookups before releasing reservations.
                let second = rpc(
                    client,
                    "getSignatureStatuses",
                    json!([[signature],{"searchTransactionHistory":true}]),
                )
                .await?;
                let second_status = second
                    .pointer("/value/0")
                    .ok_or("RPC omitted repeated signature status")?;
                let transaction = rpc(client,"getTransaction",json!([signature,{"encoding":"json","commitment":"confirmed","maxSupportedTransactionVersion":0}])).await?;
                if may_expire(false, second_status, &transaction) {
                    journal.order.status = "Expired".into();
                    journal.order.detail=Some("Blockhash expired at finalized commitment; repeated historical lookups found no transaction".into());
                    save_order(connection, journal)?;
                }
            }
        }
        return Ok(());
    }
    let commitment = observed
        .get("confirmationStatus")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !matches!(commitment, "confirmed" | "finalized") {
        return Ok(());
    }
    let transaction=rpc(client,"getTransaction",json!([signature,{"encoding":"json","commitment":"confirmed","maxSupportedTransactionVersion":0}])).await?;
    if transaction.is_null() {
        return Ok(());
    }
    journal.settled_at_ms = Some(
        transaction
            .get("blockTime")
            .and_then(Value::as_i64)
            .and_then(|time| time.checked_mul(1000))
            .filter(|time| *time > 0 && *time <= now() + 5000)
            .unwrap_or_else(now),
    );
    if !transaction.pointer("/meta/err").is_some_and(Value::is_null) {
        if transaction.pointer("/meta/err").is_none() {
            return Err("Confirmed transaction omitted execution metadata".into());
        }
        journal.order.status = "Failed".into();
        journal.order.detail =
            Some("Transaction failed on-chain; no swap position was created".into());
        let fee = transaction
            .pointer("/meta/fee")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        journal.realized_pnl_usd = -(fee as f64 / 1e9 * journal.sol_price_usd);
        save_order(connection, journal)?;
        return Ok(());
    }
    let fill = confirmed_fill(journal, &transaction)?;
    apply_fill(connection, journal, fill)
}
fn may_expire(blockhash_valid: bool, signature_status: &Value, transaction: &Value) -> bool {
    !blockhash_valid && signature_status.is_null() && transaction.is_null()
}
#[derive(Debug)]
struct Fill {
    token_raw: u64,
    sol_delta: i128,
    decimals: u8,
}
fn confirmed_fill(journal: &Journal, transaction: &Value) -> Result<Fill, String> {
    if transaction
        .pointer("/transaction/signatures/0")
        .and_then(Value::as_str)
        != journal.order.signature.as_deref()
    {
        return Err("Confirmed transaction signature does not match the saved order".into());
    }
    let static_keys = transaction
        .pointer("/transaction/message/accountKeys")
        .and_then(Value::as_array)
        .ok_or("Confirmed transaction omitted account keys")?;
    let mut keys = static_keys
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "Invalid confirmed account key".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    for pointer in [
        "/meta/loadedAddresses/writable",
        "/meta/loadedAddresses/readonly",
    ] {
        if let Some(loaded) = transaction.pointer(pointer).and_then(Value::as_array) {
            for value in loaded {
                keys.push(
                    value
                        .as_str()
                        .ok_or("Invalid confirmed lookup address")?
                        .to_string(),
                );
            }
        }
    }
    if keys != journal.account_keys || keys.first() != Some(&journal.owner) {
        return Err(
            "Confirmed transaction account identities do not match the signed message".into(),
        );
    }
    let pre = transaction
        .pointer("/meta/preBalances")
        .and_then(Value::as_array)
        .ok_or("Confirmed transaction omitted pre-balances")?;
    let post = transaction
        .pointer("/meta/postBalances")
        .and_then(Value::as_array)
        .ok_or("Confirmed transaction omitted post-balances")?;
    if pre.len() != keys.len() || post.len() != keys.len() {
        return Err("Confirmed SOL balance length mismatch".into());
    }
    let sol_delta = post[0].as_u64().ok_or("Invalid confirmed SOL balance")? as i128
        - pre[0].as_u64().ok_or("Invalid confirmed SOL balance")? as i128;
    let mut deltas: HashMap<String, i128> = HashMap::new();
    let mut precision = None;
    for (path, sign) in [
        ("/meta/preTokenBalances", -1i128),
        ("/meta/postTokenBalances", 1i128),
    ] {
        let rows = transaction
            .pointer(path)
            .and_then(Value::as_array)
            .ok_or("Confirmed transaction omitted token balances")?;
        let mut seen = HashSet::new();
        for row in rows {
            let index = row
                .get("accountIndex")
                .and_then(Value::as_u64)
                .ok_or("Token balance omitted account index")? as usize;
            if index >= keys.len() || !seen.insert(index) {
                return Err("Invalid or duplicate token balance account index".into());
            }
            let owner = row
                .get("owner")
                .and_then(Value::as_str)
                .ok_or("Token balance owner is missing; retaining pending order")?;
            if owner != journal.owner {
                continue;
            }
            let mint = row
                .get("mint")
                .and_then(Value::as_str)
                .ok_or("Token balance mint missing")?;
            let amount = row
                .pointer("/uiTokenAmount/amount")
                .and_then(Value::as_str)
                .ok_or("Raw token amount missing")?
                .parse::<u64>()
                .map_err(|_| "Invalid raw token amount")?;
            let decimals = row
                .pointer("/uiTokenAmount/decimals")
                .and_then(Value::as_u64)
                .filter(|d| *d <= 18)
                .ok_or("Invalid token decimal precision")? as u8;
            if mint == journal.order.mint {
                if precision.is_some_and(|d| d != decimals) || decimals != journal.decimals {
                    return Err("Confirmed token decimals mismatch".into());
                }
                precision = Some(decimals);
            }
            *deltas.entry(mint.to_string()).or_default() += sign * amount as i128;
        }
    }
    if deltas
        .iter()
        .any(|(mint, delta)| mint != &journal.order.mint && *delta != 0)
    {
        return Err(
            "Confirmed transaction changed another wallet asset; manual reconciliation required"
                .into(),
        );
    }
    let delta = deltas.get(&journal.order.mint).copied().unwrap_or(0);
    if journal.order.side == "BUY" {
        let input_after_refund = journal.input_raw as i128 - journal.rent_refund_lamports as i128;
        if delta <= 0
            || delta > u64::MAX as i128
            || sol_delta >= 0
            || -sol_delta < input_after_refund
            || -sol_delta > input_after_refund + transaction_cost_lamports() as i128
        {
            return Err(
                "Confirmed buy deltas do not match the authorized input; order remains unresolved"
                    .into(),
            );
        }
        Ok(Fill {
            token_raw: delta as u64,
            sol_delta,
            decimals: precision.ok_or("Confirmed fill precision missing")?,
        })
    } else {
        if delta != -(journal.input_raw as i128) || sol_delta <= 0 {
            return Err(
                "Confirmed sell deltas do not match the managed input; order remains unresolved"
                    .into(),
            );
        }
        Ok(Fill {
            token_raw: journal.input_raw,
            sol_delta,
            decimals: precision.ok_or("Confirmed fill precision missing")?,
        })
    }
}
fn apply_fill(connection: &Connection, journal: &mut Journal, fill: Fill) -> Result<(), String> {
    if journal.settled_at_ms.is_none() {
        journal.settled_at_ms = Some(now());
    }
    let transaction = connection.unchecked_transaction().map_err(db_error)?;
    let latest = load_order(&transaction, &journal.owner, &journal.order.id)?
        .ok_or("Live order disappeared before reconciliation")?;
    if !pending(&latest.order.status) {
        return Ok(());
    }
    if journal.order.side == "BUY" {
        if load_positions(&transaction, &journal.owner)?
            .iter()
            .any(|p| p.mint == journal.order.mint)
        {
            return Err("Confirmed buy conflicts with an existing managed mint".into());
        }
        let cost = (-fill.sol_delta) as f64 / 1e9 * journal.sol_price_usd;
        let quantity = fill.token_raw as f64 / 10f64.powi(fill.decimals as i32);
        let position = LivePosition {
            id: journal.order.id.clone(),
            mint: journal.order.mint.clone(),
            symbol: journal.order.symbol.clone(),
            quantity_raw: fill.token_raw.to_string(),
            decimals: fill.decimals,
            entry_price_usd: cost / quantity,
            cost_basis_usd: cost,
            opened_at_ms: journal.settled_at_ms.unwrap_or(journal.order.created_at_ms),
            high_water_price_usd: cost / quantity,
            last_price_usd: cost / quantity,
            entry_liquidity_usd: journal.entry_liquidity_usd,
            last_mark_at_ms: 0,
        };
        transaction
            .execute(
                "INSERT INTO live_positions(owner,id,payload) VALUES(?1,?2,?3)",
                params![
                    journal.owner,
                    position.id,
                    serde_json::to_string(&position).map_err(db_error)?
                ],
            )
            .map_err(db_error)?;
    } else {
        let id = journal
            .position_id
            .as_deref()
            .ok_or("Confirmed sell omitted managed position")?;
        let mut position = load_position(&transaction, &journal.owner, id)?
            .ok_or("Confirmed sell has no matching managed position")?;
        let managed = parse_raw(&position.quantity_raw)?;
        if fill.token_raw > managed
            || position.mint != journal.order.mint
            || position.decimals != fill.decimals
        {
            return Err("Confirmed sell exceeds the managed position".into());
        }
        let removed_cost = position.cost_basis_usd * (fill.token_raw as f64 / managed as f64);
        journal.realized_pnl_usd =
            fill.sol_delta as f64 / 1e9 * journal.sol_price_usd - removed_cost;
        let remaining = managed - fill.token_raw;
        if remaining == 0 {
            transaction
                .execute(
                    "DELETE FROM live_positions WHERE owner=?1 AND id=?2",
                    params![journal.owner, id],
                )
                .map_err(db_error)?;
        } else {
            position.quantity_raw = remaining.to_string();
            position.cost_basis_usd -= removed_cost;
            transaction
                .execute(
                    "UPDATE live_positions SET payload=?1 WHERE owner=?2 AND id=?3",
                    params![
                        serde_json::to_string(&position).map_err(db_error)?,
                        journal.owner,
                        id
                    ],
                )
                .map_err(db_error)?;
        }
    }
    journal.order.status = "Confirmed".into();
    journal.order.detail = Some("Verified on-chain wallet balance changes".into());
    save_order(&transaction, journal)?;
    transaction.commit().map_err(db_error)
}

fn db_error(error: impl std::fmt::Display) -> String {
    format!("Live journal error: {error}")
}
fn db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let directory = app.path().app_data_dir().map_err(db_error)?;
    std::fs::create_dir_all(&directory).map_err(db_error)?;
    let connection =
        Connection::open(directory.join("live-trading-v1.sqlite3")).map_err(db_error)?;
    initialize_db(&connection)?;
    Ok(connection)
}
fn initialize_db(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(db_error)?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS live_orders(owner TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,created_at_ms INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,id));
        CREATE INDEX IF NOT EXISTS live_orders_pending ON live_orders(owner,status);
        CREATE TABLE IF NOT EXISTS live_positions(owner TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,id));
        CREATE TABLE IF NOT EXISTS live_config(owner TEXT PRIMARY KEY,config TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS live_quarantine(owner TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,id));").map_err(db_error)
}
fn insert_order(connection: &Connection, journal: &Journal) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO live_orders(owner,id,status,created_at_ms,payload) VALUES(?1,?2,?3,?4,?5)",
            params![
                journal.owner,
                journal.order.id,
                journal.order.status,
                journal.order.created_at_ms,
                serde_json::to_string(journal).map_err(db_error)?
            ],
        )
        .map_err(db_error)?;
    Ok(())
}
fn save_order(connection: &Connection, journal: &Journal) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE live_orders SET status=?1,payload=?2 WHERE owner=?3 AND id=?4",
            params![
                journal.order.status,
                serde_json::to_string(journal).map_err(db_error)?,
                journal.owner,
                journal.order.id
            ],
        )
        .map_err(db_error)?;
    if changed != 1 {
        return Err("Could not persist the live execution state".into());
    }
    Ok(())
}
fn load_order(connection: &Connection, owner: &str, id: &str) -> Result<Option<Journal>, String> {
    let payload: Option<String> = connection
        .query_row(
            "SELECT payload FROM live_orders WHERE owner=?1 AND id=?2",
            params![owner, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    payload
        .map(|value| serde_json::from_str(&value).map_err(db_error))
        .transpose()
}
fn load_orders(connection: &Connection, owner: &str) -> Result<Vec<Journal>, String> {
    let mut statement = connection
        .prepare("SELECT payload FROM live_orders WHERE owner=?1 ORDER BY created_at_ms DESC")
        .map_err(db_error)?;
    let payloads = statement
        .query_map(params![owner], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    payloads
        .into_iter()
        .map(|value| serde_json::from_str(&value).map_err(db_error))
        .collect()
}
fn load_position(
    connection: &Connection,
    owner: &str,
    id: &str,
) -> Result<Option<LivePosition>, String> {
    let payload: Option<String> = connection
        .query_row(
            "SELECT payload FROM live_positions WHERE owner=?1 AND id=?2",
            params![owner, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    payload
        .map(|value| serde_json::from_str(&value).map_err(db_error))
        .transpose()
}
fn load_positions(connection: &Connection, owner: &str) -> Result<Vec<LivePosition>, String> {
    let mut statement = connection
        .prepare("SELECT payload FROM live_positions WHERE owner=?1 ORDER BY id")
        .map_err(db_error)?;
    let values = statement
        .query_map(params![owner], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    values
        .into_iter()
        .map(|v| serde_json::from_str(&v).map_err(db_error))
        .collect()
}
fn totals<'a>(orders: impl Iterator<Item = &'a Journal>, start: i64) -> (f64, f64) {
    let mut spent = 0.0;
    let mut pnl = 0.0;
    for journal in orders {
        let settled_at = journal.settled_at_ms.unwrap_or(journal.order.created_at_ms);
        // Unresolved buys remain reserved across midnight and app restart.
        if journal.order.side == "BUY"
            && (pending(&journal.order.status)
                || (journal.order.status == "Confirmed" && settled_at >= start))
        {
            spent += journal.order.amount_usd.unwrap_or(0.0);
        }
        if settled_at >= start && !pending(&journal.order.status) {
            pnl += journal.realized_pnl_usd;
        }
    }
    (spent, pnl)
}
fn exit_attempts(positions: &[LivePosition], orders: &[Journal]) -> HashMap<String, LiveExitAttempt> {
    positions.iter().filter_map(|position| {
        let matching: Vec<_> = orders.iter().filter(|j| j.order.side == "SELL"
            && j.position_id.as_deref() == Some(position.id.as_str()) && j.order.mint == position.mint
            && j.order.created_at_ms >= position.opened_at_ms).collect();
        let latest = matching.iter().max_by_key(|j| j.order.created_at_ms)?;
        let failures = matching.iter().filter(|j| j.order.status == "Failed").count();
        let backoff = 15_000i64 * (1i64 << failures.saturating_sub(1).min(3));
        Some((position.id.clone(), LiveExitAttempt { order: latest.order.clone(), retry_after_ms: latest.order.created_at_ms.saturating_add(backoff) }))
    }).collect()
}

fn status_from_db(
    connection: &Connection,
    owner: Option<String>,
    blocker: Option<String>,
) -> Result<LiveTradingStatus, String> {
    let session = session_store()
        .lock()
        .map_err(|_| "Live session lock unavailable")?
        .clone();
    let config = if let Some(ref owner) = owner {
        let saved: Option<String> = connection
            .query_row(
                "SELECT config FROM live_config WHERE owner=?1",
                params![owner],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        saved
            .map(|value| serde_json::from_str(&value).map_err(db_error))
            .transpose()?
            .unwrap_or_default()
    } else {
        LiveTradingConfig::default()
    };
    let orders = owner
        .as_deref()
        .map(|owner| load_orders(connection, owner))
        .transpose()?
        .unwrap_or_default();
    let positions = owner
        .as_deref()
        .map(|owner| load_positions(connection, owner))
        .transpose()?
        .unwrap_or_default();
    let quarantined_positions = owner.as_deref().map(|owner| quarantine::load(connection, owner)).transpose()?.unwrap_or_default();
    let daily_quarantine_loss_usd = quarantine::daily_loss(&quarantined_positions, day_start());
    let (spent, pnl) = totals(orders.iter(), day_start());
    let pending_count = orders.iter().filter(|o| pending(&o.order.status)).count();
    let blocker = blocker.or_else(|| {
        if pending_count > 0 {
            Some("Waiting for on-chain reconciliation; new buys are blocked".into())
        } else {
            None
        }
    });
    let at = now();
    Ok(LiveTradingStatus {
        entry_safety: match config.entry_mode {
            LiveEntryMode::GuardedDiscovery => entry_safety::statuses(at, |token| validate_buy_token(token, &config, at)),
            LiveEntryMode::PaperSignals => entry_safety::latest_statuses(at, |token| validate_buy_token(token, &config, at)),
        },
        exit_attempts: exit_attempts(&positions, &orders),
        session_generation: session
            .as_ref()
            .map(|s| s.generation)
            .unwrap_or_else(generation),
        available: owner.is_some() && api_key().is_ok(),
        armed: session
            .as_ref()
            .is_some_and(|s| Some(s.owner.as_str()) == owner.as_deref()),
        owner,
        blocker,
        config,
        acknowledgement_phrase: ACK.into(),
        daily_buy_used_usd: spent,
        daily_realized_pnl_usd: pnl,
        daily_quarantine_loss_usd,
        quarantined_positions,
        pending_count,
        positions,
        recent_orders: orders.into_iter().take(50).map(|o| o.order).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_errors_preserve_the_quote_rejection_without_dumping_payloads() {
        let body = br#"{"error":"Failed to get quotes","transaction":"DO_NOT_LOG","requestId":"DO_NOT_LOG"}"#;
        assert_eq!(provider_http_error("Jupiter order", 400, body), "Jupiter order returned HTTP 400: Failed to get quotes");
        assert_eq!(provider_http_error("Jupiter order", 400, br#"{"error":{"message":"No route"}}"#), "Jupiter order returned HTTP 400: No route");
        assert_eq!(provider_http_error("Jupiter order", 500, b"<html>internal response</html>"), "Jupiter order returned HTTP 500");
    }

    #[test]
    fn provider_errors_bound_text_and_remove_control_characters() {
        let payload = serde_json::to_vec(&json!({"errorMessage": format!("No route\n{}", "x".repeat(1000))})).unwrap();
        let message = provider_http_error("Jupiter order", 400, &payload);
        assert!(!message.contains('\n'));
        assert_eq!(message.chars().count(), "Jupiter order returned HTTP 400: ".len() + 200);
    }
    #[test]
    fn quarantine_waits_for_all_pending_orders_and_preserves_order_history() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_db(&connection).unwrap();
        let mut j = fixture();
        j.order.status = "Pending".into();
        insert_order(&connection, &j).unwrap();
        let p = LivePosition { id: "quarantine-test".into(), mint: j.order.mint.clone(), symbol: "TEST".into(), quantity_raw: "100".into(), decimals: 6, entry_price_usd: 1.0, cost_basis_usd: 5.6, opened_at_ms: 1, last_mark_at_ms: 1, high_water_price_usd: 1.0, last_price_usd: 1.0, entry_liquidity_usd: 2000.0 };
        connection.execute("INSERT INTO live_positions VALUES(?1,?2,?3)", params![j.owner,p.id,serde_json::to_string(&p).unwrap()]).unwrap();
        assert!(quarantine::apply(&mut connection, &j.owner, &p.id, 100_000).unwrap_err().contains("Pending"));
        assert_eq!(load_positions(&connection, &j.owner).unwrap().len(), 1);
        j.order.status = "Failed".into();
        save_order(&connection, &j).unwrap();
        let before = serde_json::to_string(&load_orders(&connection, &j.owner).unwrap()).unwrap();
        quarantine::apply(&mut connection, &j.owner, &p.id, 100_000).unwrap();
        assert_eq!(serde_json::to_string(&load_orders(&connection, &j.owner).unwrap()).unwrap(), before);
        assert!(load_positions(&connection, &j.owner).unwrap().is_empty());
    }

    #[test]
    fn sell_preflight_rejects_dust_recovery_and_mismatched_quotes_without_requiring_a_transaction() {
        let j=fixture();
        let session=Session {owner:j.owner.clone(),config:LiveTradingConfig::default(),generation:0};
        let good=json!({"inputMint":j.input_mint,"outputMint":j.output_mint,"inAmount":j.input_raw.to_string(),"outAmount":"1000000","priceImpactPct":0.2,"slippageBps":100,"feeBps":5});
        assert_eq!(parse_quote(&good,&session,&j).unwrap(),1_000_000);
        assert!(parse_route(&good,&session,&j).is_err());
        let mut bad=good.clone();bad["outputMint"]=json!("wrong");
        assert!(parse_quote(&bad,&session,&j).is_err());
        assert!(validate_roundtrip_recovery(100_000_000,1,&session.config).is_err());
        assert!(validate_roundtrip_recovery(100_000_000,90_000_000,&session.config).is_err());
        assert!(validate_roundtrip_recovery(100_000_000,98_000_000,&session.config).is_ok());
    }
    #[test]
    fn persisted_exit_retry_uses_exact_position_and_backoff_across_the_full_journal() {
        let mut j=fixture();
        let p=LivePosition {id:"held".into(),mint:j.order.mint.clone(),symbol:"TEST".into(),quantity_raw:"100".into(),decimals:6,entry_price_usd:1.0,cost_basis_usd:5.0,opened_at_ms:1,high_water_price_usd:1.0,last_price_usd:1.0,entry_liquidity_usd:10000.0,last_mark_at_ms:1};
        j.position_id=Some(p.id.clone());j.order.side="SELL".into();j.order.status="Failed".into();j.order.created_at_ms=100_000;
        let first=exit_attempts(&[p.clone()],&[j.clone()]);assert_eq!(first[&p.id].retry_after_ms,115_000);
        let mut second=j.clone();second.order.id="second".into();second.order.created_at_ms=120_000;
        let result=exit_attempts(&[p.clone()],&[j.clone(),second]);assert_eq!(result[&p.id].retry_after_ms,150_000);
        j.position_id=Some("different-position".into());assert!(exit_attempts(&[p],&[j]).is_empty());
    }

    fn fixture() -> Journal {
        let owner = Pubkey::new_unique().to_string();
        let mint = Pubkey::new_unique().to_string();
        Journal {
            order: LiveOrder {
                id: "intent-fixture-1".into(),
                side: "BUY".into(),
                mint: mint.clone(),
                symbol: "TEST".into(),
                status: "Pending".into(),
                signature: Some(Signature::default().to_string()),
                amount_usd: Some(10.0),
                detail: None,
                created_at_ms: now(),
                reason: "Launch breakout".into(),
            },
            owner: owner.clone(),
            position_id: None,
            input_raw: 100_000_000,
            expected_output_raw: 1_000_000,
            sol_price_usd: 100.0,
            decimals: 6,
            entry_liquidity_usd: 5000.0,
            request_id: Some("provider-request-1".into()),
            account_keys: vec![owner, Pubkey::new_unique().to_string()],
            input_mint: SOL_MINT.into(),
            output_mint: mint,
            realized_pnl_usd: 0.0,
            recent_blockhash: Some("blockhash".into()),
            expiry_after_block_height: Some(1000),
            market_at_ms: now(),
            rent_refund_lamports: 0,
            settled_at_ms: None,
        }
    }
    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        initialize_db(&connection).unwrap();
        connection
    }
    fn wallet_account(lamports: u64) -> Option<Account> {
        Some(Account {
            lamports,
            program: SYSTEM.into(),
            data: vec![],
        })
    }
    fn owned_token(owner: &str, mint: &str, amount: u64) -> Option<Account> {
        let mut data = vec![0; 165];
        data[..32].copy_from_slice(mint.parse::<Pubkey>().unwrap().as_ref());
        data[32..64].copy_from_slice(owner.parse::<Pubkey>().unwrap().as_ref());
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data[108] = 1;
        Some(Account {
            lamports: 2_039_280,
            program: TOKEN.into(),
            data,
        })
    }
    fn chain_fixture(
        j: &Journal,
        before: u64,
        after: u64,
        pre_tokens: u64,
        post_tokens: u64,
    ) -> Value {
        let row = |amount: u64| json!({"accountIndex":1,"mint":j.order.mint,"owner":j.owner,"uiTokenAmount":{"amount":amount.to_string(),"decimals":j.decimals}});
        json!({"transaction":{"signatures":[j.order.signature],"message":{"accountKeys":j.account_keys}},"meta":{"err":null,"fee":5000,"preBalances":[before,2039280],"postBalances":[after,2039280],"preTokenBalances":[row(pre_tokens)],"postTokenBalances":[row(post_tokens)]}})
    }
    fn market_fixture(j: &Journal, price: f64, timestamp: i64) -> MarketToken {
        serde_json::from_value(json!({"mint":j.order.mint,"symbol":"TEST","name":"Test","iconUrl":null,"ageSeconds":120,"priceUsd":price,"marketCapUsd":10000,"change5mPct":5,"liquidityUsd":5000,"volume5mUsd":3000,"buyRatio":0.65,"buys5m":10,"sells5m":5,"traders5m":15,"organicBuyers5m":5,"organicScore":80,"riskLevel":"Low","modelScore":80,"safety":{"mintAuthorityRevoked":true,"freezeAuthorityRevoked":true,"topTenHolderPct":20,"liquidityLocked":null,"priceImpactPct":0.5,"transferTaxPct":0,"transferTaxUnknown":false,"verified":true},"source":"test","updatedAt":chrono::DateTime::from_timestamp_millis(timestamp).unwrap().to_rfc3339()})).unwrap()
    }
    #[test]
    fn config_limits_reject_nonfinite_and_cross_field_errors() {
        assert!(validate_config(&LiveTradingConfig::default()).is_ok());
        for value in [f64::NAN, f64::INFINITY, 0.0, 1000.01] {
            let mut c = LiveTradingConfig::default();
            c.max_order_usd = value;
            assert!(validate_config(&c).is_err());
        }
        let mut c = LiveTradingConfig::default();
        c.daily_buy_cap_usd = 4.99;
        assert!(validate_config(&c).is_err());
        c = LiveTradingConfig::default();
        c.min_liquidity_usd = 1999.0;
        assert!(validate_config(&c).is_err());
        c = LiveTradingConfig::default();
        c.max_slippage_bps = 501;
        assert!(validate_config(&c).is_err());
        c = LiveTradingConfig::default();
        c.max_price_impact_pct = -1.0;
        assert!(validate_config(&c).is_err());
    }
    #[test]
    fn mainnet_genesis_requires_the_full_rpc_hash() {
        assert!(validate_genesis(&json!("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")).is_ok());
        assert!(validate_genesis(&json!("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).is_err());
        assert!(validate_genesis(&json!("EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).is_err());
    }
    #[test]
    fn signal_freshness_rejects_stale_future_and_missing() {
        assert!(validate_signal(100_000, 175_000).is_ok());
        assert!(validate_signal(99_999, 175_000).is_err());
        assert!(validate_signal(180_001, 175_000).is_err());
        assert!(validate_signal(0, 175_000).is_err());
    }
    #[test]
    fn session_cannot_cross_owner_generation_or_disarm() {
        let expected = Session {
            owner: "owner-a".into(),
            config: LiveTradingConfig::default(),
            generation: 4,
        };
        assert!(validate_session_identity(&expected, Some(&expected), 4).is_ok());
        assert!(validate_session_identity(&expected, None, 4).is_err());
        assert!(validate_session_identity(&expected, Some(&expected), 5).is_err());
        let other = Session {
            owner: "owner-b".into(),
            ..expected.clone()
        };
        assert!(validate_session_identity(&expected, Some(&other), 4).is_err());
    }
    #[test]
    fn idempotency_is_persistent_and_wallet_scoped_even_after_failure() {
        let connection = memory_db();
        let mut j = fixture();
        j.order.status = "Failed".into();
        insert_order(&connection, &j).unwrap();
        assert!(insert_order(&connection, &j).is_err());
        assert_eq!(
            load_order(&connection, &j.owner, &j.order.id)
                .unwrap()
                .unwrap()
                .order
                .status,
            "Failed"
        );
        j.owner = Pubkey::new_unique().to_string();
        assert!(insert_order(&connection, &j).is_ok());
    }
    #[test]
    fn ambiguous_submission_round_trips_exact_signature_and_reservation() {
        let connection = memory_db();
        let mut j = fixture();
        j.order.status = "Unknown".into();
        j.order.created_at_ms = 1;
        insert_order(&connection, &j).unwrap();
        let recovered = load_orders(&connection, &j.owner).unwrap();
        assert_eq!(recovered[0].order.signature, j.order.signature);
        assert_eq!(recovered[0].input_raw, j.input_raw);
        assert_eq!(recovered[0].request_id, j.request_id);
        assert_eq!(recovered[0].recent_blockhash, j.recent_blockhash);
        assert_eq!(totals(recovered.iter(), day_start()).0, 10.0);
        assert!(load_positions(&connection, &j.owner).unwrap().is_empty());
        assert!(validate_entry_limits(
            &LiveTradingConfig::default(),
            Some(5.0),
            &[],
            &recovered.iter().collect::<Vec<_>>(),
            day_start()
        )
        .is_err());
    }
    #[test]
    fn process_restart_recovers_unknown_order_from_disk_without_a_position() {
        let path = std::env::temp_dir().join(format!(
            "pulseforge-live-journal-test-{}.sqlite3",
            Pubkey::new_unique()
        ));
        let mut j = fixture();
        j.order.status = "Unknown".into();
        {
            let connection = Connection::open(&path).unwrap();
            initialize_db(&connection).unwrap();
            insert_order(&connection, &j).unwrap();
        }
        {
            let connection = Connection::open(&path).unwrap();
            initialize_db(&connection).unwrap();
            let restored = load_order(&connection, &j.owner, &j.order.id)
                .unwrap()
                .unwrap();
            assert_eq!(restored.order.signature, j.order.signature);
            assert!(pending(&restored.order.status));
            assert_eq!(restored.input_raw, j.input_raw);
            assert!(load_positions(&connection, &j.owner).unwrap().is_empty());
            assert!(insert_order(&connection, &j).is_err());
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn expired_and_failed_orders_release_reservations_but_not_identity() {
        let connection = memory_db();
        let mut j = fixture();
        insert_order(&connection, &j).unwrap();
        j.order.status = "Expired".into();
        save_order(&connection, &j).unwrap();
        assert_eq!(totals([&j].into_iter(), day_start()).0, 0.0);
        assert!(insert_order(&connection, &j).is_err());
        j.order.status = "Failed".into();
        j.realized_pnl_usd = -0.01;
        assert_eq!(totals([&j].into_iter(), day_start()), (0.0, -0.01));
    }
    #[test]
    fn utc_limits_follow_confirmed_block_time_across_midnight() {
        let mut j = fixture();
        j.order.created_at_ms = 99;
        j.order.status = "Confirmed".into();
        j.settled_at_ms = Some(101);
        assert_eq!(totals([&j].into_iter(), 100).0, 10.0);
        j.order.side = "SELL".into();
        j.realized_pnl_usd = -10.0;
        assert_eq!(totals([&j].into_iter(), 100).1, -10.0);
        j.settled_at_ms = Some(99);
        assert_eq!(totals([&j].into_iter(), 100).1, 0.0);
    }
    #[test]
    fn live_requests_require_the_reviewed_session_generation() {
        let j = fixture();
        let mut value = json!({"intentId":"intent-new-1","side":"BUY","mint":j.order.mint,"amountUsd":5.0,"positionId":null,"reason":"Launch breakout","signalAtMs":now()});
        assert!(serde_json::from_value::<LiveTradingRequest>(value.clone()).is_err());
        value["sessionGeneration"] = json!(7);
        assert_eq!(
            serde_json::from_value::<LiveTradingRequest>(value)
                .unwrap()
                .session_generation,
            7
        );
    }
    #[test]
    fn expiry_requires_invalid_blockhash_and_both_historical_absences() {
        assert!(may_expire(false, &Value::Null, &Value::Null));
        assert!(!may_expire(true, &Value::Null, &Value::Null));
        assert!(!may_expire(
            false,
            &json!({"confirmationStatus":"confirmed"}),
            &Value::Null
        ));
        assert!(!may_expire(
            false,
            &Value::Null,
            &json!({"meta":{"err":null}})
        ));
    }
    #[test]
    fn entry_caps_count_success_and_pending_but_never_prevent_managed_fill() {
        let c = LiveTradingConfig::default();
        let mut j = fixture();
        j.order.status = "Confirmed".into();
        j.order.amount_usd = Some(23.0);
        assert!(validate_entry_limits(&c, Some(5.0), &[], &[&j], day_start()).is_err());
        j.order.side = "SELL".into();
        j.realized_pnl_usd = -10.0;
        assert!(validate_entry_limits(&c, Some(5.0), &[], &[&j], day_start()).is_err());
        // Sell execution does not call this buy-only validator. Ledger fill
        // application is independent of buy spend and realized-loss limits.
        j.realized_pnl_usd = -9.99;
        assert!(validate_entry_limits(&c, Some(5.0), &[], &[&j], day_start()).is_ok());
    }
    #[test]
    fn route_unknown_fees_negative_impact_and_amount_changes_fail_closed() {
        let j = fixture();
        let s = Session {
            owner: j.owner.clone(),
            config: LiveTradingConfig::default(),
            generation: 0,
        };
        let mut body = json!({"inputMint":j.input_mint,"outputMint":j.output_mint,"inAmount":j.input_raw.to_string(),"outAmount":"1000000","priceImpactPct":0.25,"slippageBps":100,"feeBps":5,"transaction":"encoded","requestId":"r1"});
        assert!(parse_route(&body, &s, &j).is_ok());
        body.as_object_mut().unwrap().remove("feeBps");
        assert!(parse_route(&body, &s, &j).is_err());
        body["feeBps"] = json!(5);
        body["priceImpactPct"] = json!(-10);
        assert!(parse_route(&body, &s, &j).is_err());
        body["priceImpactPct"] = json!(0.25);
        body["inAmount"] = json!(1);
        assert!(parse_route(&body, &s, &j).is_err());
    }
    #[test]
    #[allow(deprecated)]
    fn transaction_cannot_bundle_multiple_individually_valid_swaps() {
        let j = fixture();
        let mut data = vec![229, 23, 203, 151, 122, 227, 173, 42];
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&[7, 100, 0, 1]);
        data.extend_from_slice(&j.input_raw.to_le_bytes());
        data.extend_from_slice(&j.expected_output_raw.to_le_bytes());
        data.extend_from_slice(&100u16.to_le_bytes());
        data.push(0);
        let instruction = solana_sdk::instruction::Instruction {
            program_id: JUPITER.parse().unwrap(),
            accounts: vec![],
            data,
        };
        let owner = j.owner.parse::<Pubkey>().unwrap();
        let make = |instructions: &[solana_sdk::instruction::Instruction]| {
            let message = solana_sdk::message::Message::new(instructions, Some(&owner));
            let keys = message
                .account_keys
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>();
            (
                VersionedTransaction {
                    signatures: vec![Signature::default()],
                    message: solana_sdk::message::VersionedMessage::Legacy(message),
                },
                keys,
            )
        };
        let (single, keys) = make(&[instruction.clone()]);
        assert!(
            validate_instructions(&single, &keys, &j.owner, &j, &LiveTradingConfig::default())
                .is_ok()
        );
        let (double, keys) = make(&[instruction.clone(), instruction]);
        assert!(
            validate_instructions(&double, &keys, &j.owner, &j, &LiveTradingConfig::default())
                .unwrap_err()
                .contains("exactly one")
        );
    }
    #[test]
    fn simulation_validates_buy_output_and_fee_reserve() {
        let j = fixture();
        let before = vec![wallet_account(1_000_000_000), None];
        let after = vec![
            wallet_account(899_995_000),
            owned_token(&j.owner, &j.order.mint, 1_000_000),
        ];
        assert!(validate_effects(&j, &before, &after, 100).is_ok());
        let short = vec![
            wallet_account(899_995_000),
            owned_token(&j.owner, &j.order.mint, 900_000),
        ];
        assert!(validate_effects(&j, &before, &short, 100).is_err());
        let expensive = vec![
            wallet_account(850_000_000),
            owned_token(&j.owner, &j.order.mint, 1_000_000),
        ];
        assert!(validate_effects(&j, &before, &expensive, 100).is_err());
    }
    #[test]
    fn empty_wrapped_sol_rent_refund_is_verified_without_raising_fee_allowance() {
        let mut j = fixture();
        j.account_keys.push(Pubkey::new_unique().to_string());
        let before = vec![
            wallet_account(1_000_000_000),
            None,
            owned_token(&j.owner, SOL_MINT, 0),
        ];
        let after = vec![
            wallet_account(902_034_280),
            owned_token(&j.owner, &j.order.mint, 1_000_000),
            None,
        ];
        j.rent_refund_lamports = simulation_rent_refund(&j, &before, &after).unwrap();
        assert_eq!(j.rent_refund_lamports, 2_039_280);
        assert!(validate_effects(&j, &before, &after, 100).is_ok());
        let too_expensive = vec![
            wallet_account(881_000_000),
            owned_token(&j.owner, &j.order.mint, 1_000_000),
            None,
        ];
        assert!(validate_effects(&j, &before, &too_expensive, 100).is_err());
    }
    #[test]
    fn simulation_rejects_authority_delegation_and_other_asset_effects() {
        let mut j = fixture();
        let extra_mint = Pubkey::new_unique().to_string();
        j.account_keys.push(Pubkey::new_unique().to_string());
        let before = vec![
            wallet_account(1_000_000_000),
            None,
            owned_token(&j.owner, &extra_mint, 100),
        ];
        let after = vec![
            wallet_account(899_995_000),
            owned_token(&j.owner, &j.order.mint, 1_000_000),
            owned_token(&j.owner, &extra_mint, 99),
        ];
        assert!(validate_effects(&j, &before, &after, 100).is_err());
        let mut after = vec![
            wallet_account(899_995_000),
            owned_token(&j.owner, &j.order.mint, 1_000_000),
            owned_token(&j.owner, &extra_mint, 100),
        ];
        after[1].as_mut().unwrap().data[72..76].copy_from_slice(&1u32.to_le_bytes());
        assert!(validate_effects(&j, &before, &after, 100).is_err());
    }
    #[test]
    fn simulation_sell_cannot_spend_whole_wallet_instead_of_managed_quantity() {
        let mut j = fixture();
        j.order.side = "SELL".into();
        j.input_raw = 500_000;
        j.expected_output_raw = 50_000_000;
        let before = vec![
            wallet_account(1_000_000_000),
            owned_token(&j.owner, &j.order.mint, 1_000_000),
        ];
        let correct = vec![
            wallet_account(1_049_995_000),
            owned_token(&j.owner, &j.order.mint, 500_000),
        ];
        assert!(validate_effects(&j, &before, &correct, 100).is_ok());
        let excess = vec![wallet_account(1_099_995_000), None];
        assert!(validate_effects(&j, &before, &excess, 100).is_err());
    }
    #[test]
    fn simulation_sell_distinguishes_quantity_mismatch_from_nonpositive_net_proceeds() {
        let mut j = fixture();
        j.order.side = "SELL".into();
        j.input_raw = 500_000;
        // The cost allowance exceeds this dust quote, but a sale must still
        // leave strictly positive net SOL and spend exactly the managed input.
        j.expected_output_raw = 1_000_000;
        let before = vec![
            wallet_account(1_000_000_000),
            owned_token(&j.owner, &j.order.mint, 1_000_000),
        ];
        let wrong_quantity = vec![
            wallet_account(1_000_995_000),
            owned_token(&j.owner, &j.order.mint, 499_999),
        ];
        assert_eq!(validate_effects(&j, &before, &wrong_quantity, 100).unwrap_err(),
            "Simulation token debit does not match the exact managed sell quantity; no transaction was submitted");
        for final_lamports in [999_995_000, 1_000_000_000] {
            let after = vec![
                wallet_account(final_lamports),
                owned_token(&j.owner, &j.order.mint, 500_000),
            ];
            assert_eq!(validate_effects(&j, &before, &after, 100).unwrap_err(),
                "Sell blocked: simulated SOL proceeds do not exceed network fees and account rent; no transaction was submitted");
        }
        let positive_net = vec![
            wallet_account(1_000_000_001),
            owned_token(&j.owner, &j.order.mint, 500_000),
        ];
        assert!(validate_effects(&j, &before, &positive_net, 100).is_ok());
    }
    #[test]
    fn simulation_sell_preserves_minimum_output_boundary_and_rent_refund_accounting() {
        let mut j = fixture();
        j.order.side = "SELL".into();
        j.input_raw = 500_000;
        j.expected_output_raw = 50_000_000;
        let before = vec![
            wallet_account(1_000_000_000),
            owned_token(&j.owner, &j.order.mint, 1_000_000),
        ];
        // The 1% slippage floor is 49,500,000 lamports. After the existing
        // 20,000,000 cost allowance, net output must reach 29,500,000.
        for refund in [0, 2_039_280] {
            j.rent_refund_lamports = refund;
            let at_minimum = vec![
                wallet_account(1_029_500_000 + refund),
                owned_token(&j.owner, &j.order.mint, 500_000),
            ];
            assert!(validate_effects(&j, &before, &at_minimum, 100).is_ok());
            let short = vec![
                wallet_account(1_029_499_999 + refund),
                owned_token(&j.owner, &j.order.mint, 500_000),
            ];
            assert_eq!(validate_effects(&j, &before, &short, 100).unwrap_err(),
                "Simulation SOL output is below the quoted minimum after the authorized transaction-cost allowance; no transaction was submitted");
        }
    }
    #[test]
    fn confirmed_fill_uses_exact_owned_raw_deltas_not_quote_amount() {
        let mut j = fixture();
        j.expected_output_raw = 9_999_999;
        let transaction = chain_fixture(&j, 1_000_000_000, 899_995_000, 0, 1_234_567);
        let fill = confirmed_fill(&j, &transaction).unwrap();
        assert_eq!(fill.token_raw, 1_234_567);
        assert_eq!(fill.sol_delta, -100_005_000);
        let mut wrong = transaction.clone();
        wrong["meta"]["postTokenBalances"][0]["owner"] = json!(Pubkey::new_unique().to_string());
        assert!(confirmed_fill(&j, &wrong).is_err());
        let mut missing = transaction;
        missing["meta"]
            .as_object_mut()
            .unwrap()
            .remove("postTokenBalances");
        assert!(confirmed_fill(&j, &missing).is_err());
    }
    #[test]
    fn confirmed_fill_rejects_signature_accounts_and_decimal_mismatch() {
        let j = fixture();
        let base = chain_fixture(&j, 1_000_000_000, 899_995_000, 0, 1_000_000);
        let mut value = base.clone();
        value["transaction"]["signatures"][0] = json!("other");
        assert!(confirmed_fill(&j, &value).is_err());
        value = base.clone();
        value["transaction"]["message"]["accountKeys"][0] = json!("other");
        assert!(confirmed_fill(&j, &value).is_err());
        value = base;
        value["meta"]["postTokenBalances"][0]["uiTokenAmount"]["decimals"] = json!(9);
        assert!(confirmed_fill(&j, &value).is_err());
    }
    #[test]
    fn confirmed_reconciliation_is_atomic_idempotent_and_preserves_partial_cost_basis() {
        let connection = memory_db();
        let mut buy = fixture();
        insert_order(&connection, &buy).unwrap();
        apply_fill(
            &connection,
            &mut buy,
            Fill {
                token_raw: 1_000_000,
                sol_delta: -100_005_000,
                decimals: 6,
            },
        )
        .unwrap();
        apply_fill(
            &connection,
            &mut buy,
            Fill {
                token_raw: 1_000_000,
                sol_delta: -100_005_000,
                decimals: 6,
            },
        )
        .unwrap();
        let initial = load_positions(&connection, &buy.owner).unwrap();
        assert_eq!(initial.len(), 1);
        assert_eq!(initial[0].quantity_raw, "1000000");
        assert!((initial[0].cost_basis_usd - 10.0005).abs() < 1e-9);
        let mut sell = buy.clone();
        sell.order.id = "sell-fixture-2".into();
        sell.order.side = "SELL".into();
        sell.order.status = "Pending".into();
        sell.order.amount_usd = None;
        sell.position_id = Some(buy.order.id.clone());
        sell.input_raw = 500_000;
        insert_order(&connection, &sell).unwrap();
        apply_fill(
            &connection,
            &mut sell,
            Fill {
                token_raw: 500_000,
                sol_delta: 80_000_000,
                decimals: 6,
            },
        )
        .unwrap();
        let remaining = load_positions(&connection, &buy.owner).unwrap();
        assert_eq!(remaining[0].quantity_raw, "500000");
        assert!((remaining[0].cost_basis_usd - 5.00025).abs() < 1e-9);
        assert!((sell.realized_pnl_usd - 2.99975).abs() < 1e-9);
        sell.order.id = "sell-fixture-3".into();
        sell.order.status = "Pending".into();
        insert_order(&connection, &sell).unwrap();
        apply_fill(
            &connection,
            &mut sell,
            Fill {
                token_raw: 500_000,
                sol_delta: 70_000_000,
                decimals: 6,
            },
        )
        .unwrap();
        assert!(load_positions(&connection, &buy.owner).unwrap().is_empty());
    }
    #[test]
    fn invalid_sell_cannot_mutate_another_wallet_position() {
        let connection = memory_db();
        let mut buy = fixture();
        insert_order(&connection, &buy).unwrap();
        apply_fill(
            &connection,
            &mut buy,
            Fill {
                token_raw: 1_000_000,
                sol_delta: -100_005_000,
                decimals: 6,
            },
        )
        .unwrap();
        let mut sell = buy.clone();
        sell.owner = Pubkey::new_unique().to_string();
        sell.order.id = "sell-other-wallet".into();
        sell.order.side = "SELL".into();
        sell.order.status = "Pending".into();
        sell.position_id = Some(buy.order.id.clone());
        insert_order(&connection, &sell).unwrap();
        assert!(apply_fill(
            &connection,
            &mut sell,
            Fill {
                token_raw: 1_000_000,
                sol_delta: 100_000_000,
                decimals: 6
            }
        )
        .is_err());
        assert_eq!(load_positions(&connection, &buy.owner).unwrap().len(), 1);
        assert_eq!(
            load_order(&connection, &sell.owner, &sell.order.id)
                .unwrap()
                .unwrap()
                .order
                .status,
            "Pending"
        );
    }
    #[test]
    fn raw_quantities_above_javascript_integer_precision_are_preserved() {
        let connection = memory_db();
        let mut j = fixture();
        insert_order(&connection, &j).unwrap();
        let raw = (1u64 << 54) + 123;
        apply_fill(
            &connection,
            &mut j,
            Fill {
                token_raw: raw,
                sol_delta: -100_005_000,
                decimals: 6,
            },
        )
        .unwrap();
        assert_eq!(
            load_positions(&connection, &j.owner).unwrap()[0].quantity_raw,
            raw.to_string()
        );
    }
    #[test]
    fn native_marks_are_monotonic_fresh_and_do_not_restore_sold_positions() {
        let mut connection = memory_db();
        let mut j = fixture();
        insert_order(&connection, &j).unwrap();
        apply_fill(
            &connection,
            &mut j,
            Fill {
                token_raw: 1_000_000,
                sol_delta: -100_005_000,
                decimals: 6,
            },
        )
        .unwrap();
        let at = now();
        record_marks(&mut connection, &[market_fixture(&j, 12.0, at)], at).unwrap();
        record_marks(&mut connection, &[market_fixture(&j, 1.0, at - 1)], at).unwrap();
        let position = load_positions(&connection, &j.owner).unwrap().remove(0);
        assert_eq!(position.last_price_usd, 12.0);
        assert_eq!(position.high_water_price_usd, 12.0);
        assert_eq!(position.quantity_raw, "1000000");
        record_marks(
            &mut connection,
            &[market_fixture(&j, 11.0, at + 1000)],
            at + 1000,
        )
        .unwrap();
        record_marks(
            &mut connection,
            &[market_fixture(&j, 100.0, at + 100_000)],
            at + 1000,
        )
        .unwrap();
        let position = load_positions(&connection, &j.owner).unwrap().remove(0);
        assert_eq!(position.last_price_usd, 11.0);
        assert_eq!(position.high_water_price_usd, 12.0);
        connection
            .execute(
                "DELETE FROM live_positions WHERE owner=?1",
                params![j.owner],
            )
            .unwrap();
        record_marks(
            &mut connection,
            &[market_fixture(&j, 15.0, at + 2000)],
            at + 2000,
        )
        .unwrap();
        assert!(load_positions(&connection, &j.owner).unwrap().is_empty());
    }
    #[test]
    fn live_safety_rejects_unknown_fees_and_invalid_holder_percentages() {
        let j = fixture();
        let mut token = market_fixture(&j, 1.0, now());
        token.source = "Jupiter Tokens V2".into();
        token.age_seconds = entry_safety::MIN_POOL_AGE_SECONDS;
        token.liquidity_usd = entry_safety::MIN_LIQUIDITY_USD;
        token.traders_5m = 25;
        token.sells_5m = 10;
        let config = LiveTradingConfig::default();
        assert!(validate_buy_token(&token, &config, now()).is_ok());
        token.safety.transfer_tax_unknown = true;
        assert!(validate_buy_token(&token, &config, now()).is_err());
        token.safety.transfer_tax_unknown = false;
        token.safety.top_ten_holder_pct = -1.0;
        assert!(validate_buy_token(&token, &config, now()).is_err());
        token.safety.top_ten_holder_pct = f64::NAN;
        assert!(validate_buy_token(&token, &config, now()).is_err());
    }
    #[test]
    fn elevated_risk_flag_cannot_bypass_fixed_entry_floors_and_sells_need_no_history() {
        let mut token = market_fixture(&fixture(), 1.0, now());
        token.source = "Jupiter Tokens V2".into();
        token.risk_level = "High".into();
        let mut config = LiveTradingConfig::default();
        config.allow_high_risk = true;
        assert!(validate_buy_token(&token, &config, now()).is_err());
        token.age_seconds = entry_safety::MIN_POOL_AGE_SECONDS;
        token.liquidity_usd = entry_safety::MIN_LIQUIDITY_USD;
        token.traders_5m = 25;
        token.sells_5m = 10;
        assert!(validate_buy_token(&token, &config, now()).is_ok());
        token.liquidity_usd = 19_999.99;
        config.min_liquidity_usd = 2_000.0;
        assert_eq!(
            validate_buy_token(&token, &config, now()).unwrap_err(),
            "Entry protection: liquidity must be at least $20,000"
        );
        token.liquidity_usd = 20_000.0;
        config.allow_high_risk = false;
        assert!(validate_buy_token(&token, &config, now()).is_err());
        assert!(validate_entry_observations("BUY", &token.mint, &config, now()).is_err());
        assert!(validate_entry_observations("SELL", &token.mint, &config, now()).is_ok());
    }
    #[test]
    fn lower_liquidity_floor_preserves_stricter_session_minimum() {
        let at = now();
        let mut token = market_fixture(&fixture(), 1.0, at);
        token.source = "Jupiter Tokens V2".into();
        token.age_seconds = entry_safety::MIN_POOL_AGE_SECONDS;
        token.liquidity_usd = 20_000.0;
        token.traders_5m = 25;
        token.sells_5m = 10;
        let mut config = LiveTradingConfig::default();
        assert_eq!(config.min_liquidity_usd, 20_000.0);
        assert!(validate_buy_token(&token, &config, at).is_ok());
        config.min_liquidity_usd = 250_000.0;
        assert_eq!(
            validate_buy_token(&token, &config, at).unwrap_err(),
            "Live token price or liquidity does not meet the session limits"
        );
        token.liquidity_usd = 250_000.0;
        assert!(validate_buy_token(&token, &config, at).is_ok());
    }

    fn paper_signal_config() -> LiveTradingConfig {
        LiveTradingConfig {
            entry_mode: LiveEntryMode::PaperSignals,
            min_liquidity_usd: 5_000.0,
            paper_entry_criteria: Some(PaperEntryCriteria {
                min_token_age_seconds: 90.0,
                max_token_age_seconds: 2_700.0,
                min_liquidity_usd: 5_000.0,
                max_top_ten_holder_pct: 35.0,
                min_traders_5m: 8,
                min_sells_5m: 1,
            }),
            ..LiveTradingConfig::default()
        }
    }

    fn paper_signal_token(at: i64) -> MarketToken {
        let mut token = market_fixture(&fixture(), 1.0, at);
        token.source = "Jupiter Tokens V2".into();
        token.age_seconds = 120;
        token.liquidity_usd = 12_542.0;
        token.safety.top_ten_holder_pct = 30.0;
        token.traders_5m = 8;
        token.sells_5m = 1;
        token
    }

    #[test]
    fn legacy_configs_stay_guarded_and_paper_snapshot_roundtrips() {
        let mut legacy = serde_json::to_value(LiveTradingConfig::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("entryMode");
        legacy.as_object_mut().unwrap().remove("paperEntryCriteria");
        let loaded: LiveTradingConfig = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(loaded.entry_mode, LiveEntryMode::GuardedDiscovery);
        assert_eq!(loaded.paper_entry_criteria, None);
        let paper = paper_signal_config();
        assert_eq!(serde_json::from_str::<LiveTradingConfig>(&serde_json::to_string(&paper).unwrap()).unwrap(), paper);
        legacy["entryMode"] = json!("unknownMode");
        assert!(serde_json::from_value::<LiveTradingConfig>(legacy).is_err());
    }

    #[test]
    fn paper_signal_config_rejects_missing_and_malformed_captured_criteria() {
        let good = paper_signal_config();
        assert!(validate_config(&good).is_ok());
        let mut missing = good.clone();
        missing.paper_entry_criteria = None;
        assert!(validate_config(&missing).is_err());
        let original = good.paper_entry_criteria.clone().unwrap();
        let mut invalid = Vec::new();
        for value in [-1.0, f64::NAN, f64::INFINITY, 2_701.0] {
            let mut criteria = original.clone(); criteria.min_token_age_seconds = value; invalid.push(criteria);
        }
        for value in [89.0, f64::NAN, f64::INFINITY, 1_000_000_000_001.0] {
            let mut criteria = original.clone(); criteria.max_token_age_seconds = value; invalid.push(criteria);
        }
        for value in [1_999.99, f64::NAN, f64::INFINITY] {
            let mut criteria = original.clone(); criteria.min_liquidity_usd = value; invalid.push(criteria);
        }
        for value in [-1.0, 35.01, f64::NAN, f64::INFINITY] {
            let mut criteria = original.clone(); criteria.max_top_ten_holder_pct = value; invalid.push(criteria);
        }
        let mut criteria = original.clone(); criteria.min_traders_5m = 1_000_000_001; invalid.push(criteria);
        let mut criteria = original; criteria.min_sells_5m = 1_000_000_001; invalid.push(criteria);
        for criteria in invalid {
            let mut config = good.clone(); config.paper_entry_criteria = Some(criteria);
            assert!(validate_config(&config).is_err());
            config.entry_mode = LiveEntryMode::GuardedDiscovery;
            assert!(validate_config(&config).is_err());
        }
    }

    #[test]
    fn zcat_like_paper_signal_uses_captured_rules_and_live_liquidity_limit() {
        let at = now();
        let token = paper_signal_token(at);
        let mut config = paper_signal_config();
        assert!(validate_buy_token(&token, &config, at).is_ok());
        assert!(validate_buy_token(&token, &LiveTradingConfig::default(), at).is_err());
        config.min_liquidity_usd = 20_000.0;
        assert!(validate_buy_token(&token, &config, at).is_err());
        config.min_liquidity_usd = 5_000.0;
        config.paper_entry_criteria.as_mut().unwrap().min_liquidity_usd = 20_000.0;
        assert!(validate_buy_token(&token, &config, at).is_err());
    }

    #[test]
    fn paper_signal_captured_age_holder_and_activity_bounds_are_enforced() {
        let at = now();
        let good = paper_signal_token(at);
        let config = paper_signal_config();
        for age in [90, 2_700] {
            let mut token = good.clone(); token.age_seconds = age;
            assert!(validate_buy_token(&token, &config, at).is_ok());
        }
        for age in [89, 2_701] {
            let mut token = good.clone(); token.age_seconds = age;
            assert!(validate_buy_token(&token, &config, at).is_err());
        }
        let mut token = good.clone(); token.traders_5m = 7;
        assert!(validate_buy_token(&token, &config, at).is_err());
        token = good.clone(); token.sells_5m = 0;
        assert!(validate_buy_token(&token, &config, at).is_err());
        let mut tighter = config; tighter.paper_entry_criteria.as_mut().unwrap().max_top_ten_holder_pct = 25.0;
        assert!(validate_buy_token(&good, &tighter, at).is_err());
    }

    #[test]
    fn paper_signals_preserve_native_source_authority_fee_risk_and_order_limits() {
        let at = now();
        let good = paper_signal_token(at);
        let config = paper_signal_config();
        let mut invalid = Vec::new();
        let mut token = good.clone(); token.source = "Deterministic demo".into(); invalid.push(token);
        for timestamp in [at - 75_001, at + 1] {
            let mut token = good.clone();
            token.updated_at = chrono::DateTime::from_timestamp_millis(timestamp).unwrap().to_rfc3339(); invalid.push(token);
        }
        let mut token = good.clone(); token.safety.mint_authority_revoked = false; invalid.push(token);
        let mut token = good.clone(); token.safety.freeze_authority_revoked = false; invalid.push(token);
        let mut token = good.clone(); token.safety.transfer_tax_unknown = true; invalid.push(token);
        for fee in [-1.0, 1.01, f64::NAN] {
            let mut token = good.clone(); token.safety.transfer_tax_pct = fee; invalid.push(token);
        }
        let mut token = good.clone(); token.safety.top_ten_holder_pct = 35.01; invalid.push(token);
        let mut token = good.clone(); token.risk_level = "High".into(); invalid.push(token);
        for token in invalid { assert!(validate_buy_token(&token, &config, at).is_err()); }
        assert!(validate_entry_limits(&config, Some(5.0), &[], &[], day_start()).is_ok());
        assert!(validate_entry_limits(&config, Some(5.01), &[], &[], day_start()).is_err());
        let mut risky = config; risky.allow_high_risk = true;
        let mut token = good; token.risk_level = "High".into();
        assert!(validate_buy_token(&token, &risky, at).is_ok());
        token.safety.transfer_tax_unknown = true;
        assert!(validate_buy_token(&token, &risky, at).is_err());
    }

    #[test]
    fn paper_signal_final_native_evidence_rechecks_without_history_and_never_blocks_sells() {
        let at = now();
        let config = paper_signal_config();
        let mut token = paper_signal_token(at);
        token.mint = "paper-signal-final-evidence-test".into();
        assert!(validate_entry_observations("BUY", &token.mint, &config, at).is_err());
        assert!(validate_entry_observations("SELL", &token.mint, &config, at).is_ok());
        entry_safety::record(std::slice::from_ref(&token), at).unwrap();
        assert!(validate_entry_observations("BUY", &token.mint, &config, at).is_ok());
        assert!(validate_entry_observations("BUY", &token.mint, &config, at + 75_001).is_err());
        token.safety.freeze_authority_revoked = false;
        entry_safety::record(std::slice::from_ref(&token), at + 1).unwrap();
        assert!(validate_entry_observations("BUY", &token.mint, &config, at + 1).is_err());
        assert!(validate_entry_observations("SELL", &token.mint, &config, at + 75_001).is_ok());
    }
    #[tokio::test]
    #[ignore = "Read-only public-wallet Jupiter order + unsigned simulation; requires configured JUPITER_API_KEY"]
    async fn public_wallet_unsigned_route_preflight() {
        const OWNER: &str = "ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT";
        const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        let mint = std::env::var("PULSEFORGE_PREFLIGHT_MINT").unwrap_or_else(|_| USDC.into());
        let mint = mint
            .parse::<Pubkey>()
            .expect("Preflight target must be a valid public mint")
            .to_string();
        assert_ne!(
            mint, SOL_MINT,
            "Preflight requires a target mint other than wrapped SOL"
        );
        let client = client().unwrap();
        verify_mainnet(&client).await.unwrap();
        let (balance, price) = balance_and_price(&client, OWNER, crate::jupiter_requests::Priority::Entry).await.unwrap();
        let mut j = fixture();
        j.owner = OWNER.into();
        j.order.mint = mint.clone();
        j.order.symbol = if mint == USDC { "USDC" } else { "PREFLIGHT" }.into();
        j.order.amount_usd = Some(5.0);
        j.input_raw = raw_sol(5.0 / price).unwrap();
        j.input_mint = SOL_MINT.into();
        j.output_mint = mint.clone();
        j.sol_price_usd = price;
        j.decimals = mint_decimals(&client, &mint).await.unwrap();
        assert!(
            balance > j.input_raw + reserve_lamports(),
            "Public fixture wallet no longer has enough SOL for unsigned simulation"
        );
        let session = Session {
            owner: OWNER.into(),
            config: LiveTradingConfig::default(),
            generation: 0,
        };
        let route = fetch_route(&client, &session, &j).await.unwrap();
        let (transaction, keys) = decode_transaction(&client, &route.transaction, OWNER)
            .await
            .unwrap();
        j.account_keys = keys.clone();
        j.expected_output_raw = route.output_raw;
        validate_instructions(&transaction, &keys, OWNER, &j, &session.config).unwrap();
        let before = get_accounts(&client, &keys).await.unwrap();
        let simulated=rpc(&client,"simulateTransaction",json!([route.transaction,{"encoding":"base64","sigVerify":false,"replaceRecentBlockhash":false,"commitment":"confirmed","accounts":{"encoding":"base64","addresses":keys}}])).await.unwrap();
        assert!(
            simulated.pointer("/value/err").is_some_and(Value::is_null),
            "Read-only swap simulation failed"
        );
        let after = simulated
            .pointer("/value/accounts")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .map(parse_account)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        j.rent_refund_lamports = simulation_rent_refund(&j, &before, &after).unwrap();
        validate_effects(&j, &before, &after, 100).unwrap();
        // Intentionally no keypair load, signing, execute endpoint or sendTransaction.
        println!(
            "Public-wallet read-only order, transaction validation and unsigned simulation passed"
        );
    }
}
