use std::{
    collections::HashSet,
    fs,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::types::{MarketSnapshot, MarketToken};

const TARGET_HORIZON_MS: i64 = 45 * 60 * 1_000;
const OUTCOME_GRACE_MS: i64 = 15 * 60 * 1_000;
const ESTIMATED_ROUND_TRIP_FEE_PCT: f64 = 0.70;
const TAKE_PROFIT_PCT: f64 = 8.0;
const STOP_LOSS_PCT: f64 = 5.0;
const TRAILING_STOP_PCT: f64 = 4.0;
const LIQUIDITY_DRAWDOWN_PCT: f64 = 30.0;
const FLOW_EXIT_BUY_RATIO: f64 = 0.47;
const MIN_RESEARCH_READY_DAYS: f64 = 1.0;
const MIN_RESEARCH_READY_LABELS: i64 = 10_000;
const MIN_RESEARCH_READY_CLASS: i64 = 1_000;
const PROMOTION_EVIDENCE_DAYS: i64 = 30;
const MIN_OUTCOME_RETURN_PCT: f64 = -100.0;
const MAX_OUTCOME_RETURN_PCT: f64 = 100.0;
const QUOTE_PROBES_PER_MINUTE: usize = 3;
const QUOTE_INPUT_USDC_RAW: u64 = 20_000_000;
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE_URL: &str = "https://api.jup.ag/swap/v1/quote";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationStatus {
    pub storage_path: String,
    pub observation_count: i64,
    pub labeled_count: i64,
    pub pending_count: i64,
    pub positive_count: i64,
    pub negative_count: i64,
    pub unavailable_count: i64,
    pub invalid_outcome_count: i64,
    pub bounded_outcome_count: i64,
    pub observation_days: f64,
    pub target_horizon_minutes: i64,
    pub quote_sample_count: i64,
    pub quote_success_count: i64,
    pub quote_failure_count: i64,
    pub real_quote_coverage_pct: Option<f64>,
    pub median_round_trip_cost_pct: Option<f64>,
    pub drift_psi: Option<f64>,
    pub drift_status: String,
    pub ready_for_first_calibration: bool,
    pub promotion_evidence_days: i64,
    pub research_artifact: Option<ResearchArtifactSummary>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchArtifactSummary {
    pub champion: String,
    pub trained_at: String,
    pub dataset_rows: i64,
    pub observation_span_days: f64,
    pub test_rows: i64,
    pub baseline_roc_auc: Option<f64>,
    pub calibrated_roc_auc: Option<f64>,
    pub calibrated_brier: f64,
    pub selected_observations: i64,
    pub cost_stressed_mean_return_pct: f64,
    pub excluded_invalid_rows: i64,
    pub bounded_return_rows: i64,
    pub promotion_eligible: bool,
}

#[derive(Debug, Clone)]
struct QuoteCandidate {
    id: i64,
    mint: String,
    model_score: f64,
    liquidity_usd: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JupiterQuote {
    out_amount: String,
    price_impact_pct: String,
    route_plan: Vec<RouteStep>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteStep {
    swap_info: RouteSwapInfo,
}

#[derive(Debug, Deserialize)]
struct RouteSwapInfo {
    label: Option<String>,
}

#[derive(Debug)]
struct PathPoint {
    observed_at_ms: i64,
    price_usd: f64,
    liquidity_usd: f64,
    buy_ratio: f64,
    exit_impact_pct: f64,
}

#[derive(Debug)]
struct PolicyOutcome {
    observed_at_ms: i64,
    price_usd: Option<f64>,
    net_return_pct: Option<f64>,
    success: bool,
    available: bool,
    reason: &'static str,
    hold_ms: i64,
    mfe_pct: Option<f64>,
    mae_pct: Option<f64>,
}

pub async fn record(
    app: &tauri::AppHandle,
    snapshot: &MarketSnapshot,
) -> Result<CalibrationStatus, String> {
    let path = database_path(app)?;
    let quote_candidates = {
        let mut connection = open(&path)?;
        record_snapshot(&mut connection, snapshot)?
    };

    if let Ok(api_key) = std::env::var("JUPITER_API_KEY") {
        if !api_key.trim().is_empty() && !quote_candidates.is_empty() {
            let probes = probe_round_trips(&api_key, quote_candidates).await;
            let mut connection = open(&path)?;
            let transaction = connection
                .transaction()
                .map_err(|error| error.to_string())?;
            for probe in probes {
                save_quote_probe(&transaction, probe)?;
            }
            transaction.commit().map_err(|error| error.to_string())?;
        }
    }

    let connection = open(&path)?;
    status_from_connection(&connection, &path)
}

pub fn status(app: &tauri::AppHandle) -> Result<CalibrationStatus, String> {
    let path = database_path(app)?;
    let connection = open(&path)?;
    status_from_connection(&connection, &path)
}

pub fn export_csv(app: &tauri::AppHandle) -> Result<String, String> {
    let database = database_path(app)?;
    let connection = open(&database)?;
    let Some(destination) = rfd::FileDialog::new()
        .set_title("Export PulseForge calibration observations")
        .set_file_name("pulseforge-calibration.csv")
        .add_filter("CSV dataset", &["csv"])
        .save_file()
    else {
        return Err("Export cancelled".into());
    };
    write_csv(&connection, &destination)?;
    Ok(destination.to_string_lossy().into_owned())
}

pub fn import_research_artifact(app: &tauri::AppHandle) -> Result<CalibrationStatus, String> {
    let Some(source) = rfd::FileDialog::new()
        .set_title("Import PulseForge research calibration report")
        .add_filter("PulseForge calibration report", &["json"])
        .pick_file()
    else {
        return Err("Artifact import cancelled".into());
    };
    let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
    if metadata.len() > 5_000_000 {
        return Err("Research report is larger than the 5 MB safety limit".into());
    }
    let contents = fs::read_to_string(&source)
        .map_err(|error| format!("Could not read research report: {error}"))?;
    parse_research_artifact(&contents)?;
    let database = database_path(app)?;
    let destination = research_artifact_path(&database);
    if source != destination {
        fs::copy(&source, &destination)
            .map_err(|error| format!("Could not install research report: {error}"))?;
    }
    let connection = open(&database)?;
    status_from_connection(&connection, &database)
}

pub fn forget_research_artifact(app: &tauri::AppHandle) -> Result<CalibrationStatus, String> {
    let database = database_path(app)?;
    let artifact = research_artifact_path(&database);
    if artifact.exists() {
        fs::remove_file(&artifact)
            .map_err(|error| format!("Could not remove research report: {error}"))?;
    }
    let connection = open(&database)?;
    status_from_connection(&connection, &database)
}

fn research_artifact_path(database: &Path) -> PathBuf {
    database.with_file_name("model-research-v1.json")
}

fn nested<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a serde_json::Value> {
    path.iter().try_fold(value, |current, key| current.get(key))
}

fn finite_json_number(value: &serde_json::Value, path: &[&str]) -> Result<f64, String> {
    let result = nested(value, path)
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| format!("Research report is missing {}", path.join(".")))?;
    if !result.is_finite() {
        return Err(format!(
            "Research report has a non-finite {}",
            path.join(".")
        ));
    }
    Ok(result)
}

fn optional_json_number(value: &serde_json::Value, path: &[&str]) -> Option<f64> {
    nested(value, path)
        .and_then(serde_json::Value::as_f64)
        .filter(|number| number.is_finite())
}

fn parse_research_artifact(contents: &str) -> Result<ResearchArtifactSummary, String> {
    let value: serde_json::Value = serde_json::from_str(contents)
        .map_err(|error| format!("Research report is not valid JSON: {error}"))?;
    let schema = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    if schema < 3 {
        return Err(
            "Research report schema is too old; retrain with PulseForge v0.8 or later".into(),
        );
    }
    let champion = value
        .get("champion")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if !matches!(champion, "histGradientBoosting" | "randomForest") {
        return Err("Research report does not contain a supported model champion".into());
    }
    let trained_at = value
        .get("trainedAt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if trained_at.is_empty() {
        return Err("Research report is missing its training timestamp".into());
    }
    let dataset_rows = finite_json_number(&value, &["datasetAudit", "rows"])? as i64;
    let test_rows = finite_json_number(&value, &["segments", "test"])? as i64;
    if dataset_rows <= 0 || test_rows <= 0 {
        return Err("Research report contains no usable training or test rows".into());
    }
    Ok(ResearchArtifactSummary {
        champion: champion.into(),
        trained_at: trained_at.into(),
        dataset_rows,
        observation_span_days: finite_json_number(
            &value,
            &["datasetAudit", "observationSpanDays"],
        )?,
        test_rows,
        baseline_roc_auc: optional_json_number(
            &value,
            &["untouchedTest", "shippedBaselineRaw", "roc_auc"],
        ),
        calibrated_roc_auc: optional_json_number(
            &value,
            &["untouchedTest", "calibrated", "roc_auc"],
        ),
        calibrated_brier: finite_json_number(&value, &["untouchedTest", "calibrated", "brier"])?,
        selected_observations: finite_json_number(
            &value,
            &[
                "untouchedTest",
                "costStressedThresholdPerformance",
                "observations",
            ],
        )? as i64,
        cost_stressed_mean_return_pct: finite_json_number(
            &value,
            &[
                "untouchedTest",
                "costStressedThresholdPerformance",
                "meanNetReturnPct",
            ],
        )?,
        excluded_invalid_rows: finite_json_number(
            &value,
            &["dataQuality", "excludedNonFiniteReturns"],
        )? as i64
            + finite_json_number(&value, &["dataQuality", "excludedMissingAvailableReturns"])?
                as i64,
        bounded_return_rows: finite_json_number(
            &value,
            &["dataQuality", "returnsWinsorizedForEvaluation"],
        )? as i64,
        promotion_eligible: value
            .get("promotionEligible")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

fn load_research_artifact(database: &Path) -> Option<ResearchArtifactSummary> {
    let contents = fs::read_to_string(research_artifact_path(database)).ok()?;
    parse_research_artifact(&contents).ok()
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create calibration data directory: {error}"))?;
    Ok(directory.join("calibration-v1.sqlite3"))
}

fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("Could not open calibration database: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS observations (
           id INTEGER PRIMARY KEY,
           minute_bucket INTEGER NOT NULL,
           observed_at_ms INTEGER NOT NULL,
           mode TEXT NOT NULL,
           provider TEXT NOT NULL,
           mint TEXT NOT NULL,
           symbol TEXT NOT NULL,
           age_seconds INTEGER NOT NULL,
           price_usd REAL NOT NULL,
           change_5m_pct REAL NOT NULL,
           liquidity_usd REAL NOT NULL,
           volume_5m_usd REAL NOT NULL,
           buy_ratio REAL NOT NULL,
           buys_5m INTEGER NOT NULL,
           sells_5m INTEGER NOT NULL,
           traders_5m INTEGER NOT NULL,
           organic_buyers_5m INTEGER NOT NULL,
           organic_score REAL,
           model_raw_score REAL NOT NULL,
           risk_level TEXT NOT NULL,
           mint_authority_revoked INTEGER NOT NULL,
           freeze_authority_revoked INTEGER NOT NULL,
           top_ten_holder_pct REAL NOT NULL,
           liquidity_locked INTEGER,
           entry_price_impact_pct REAL NOT NULL,
           transfer_tax_pct REAL NOT NULL,
           verified INTEGER NOT NULL,
           source TEXT NOT NULL,
           outcome_observed_at_ms INTEGER,
           outcome_price_usd REAL,
           outcome_net_return_pct REAL,
           outcome_success INTEGER,
           outcome_available INTEGER,
           UNIQUE(mint, minute_bucket)
         );",
        )
        .map_err(|error| format!("Could not initialize calibration database: {error}"))?;
    ensure_columns(&connection)?;
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_observations_mint_time ON observations(mint, observed_at_ms);
         CREATE INDEX IF NOT EXISTS idx_observations_pending ON observations(outcome_success, observed_at_ms);
         CREATE INDEX IF NOT EXISTS idx_observations_quotes ON observations(quote_attempted, quote_succeeded);"
    ).map_err(|error| error.to_string())?;
    Ok(connection)
}

fn ensure_columns(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(observations)")
        .map_err(|error| error.to_string())?;
    let existing: HashSet<String> = statement
        .query_map([], |row| row.get(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    for (name, sql_type) in [
        ("momentum_1m_pct", "REAL"),
        ("momentum_15m_pct", "REAL"),
        ("liquidity_change_5m_pct", "REAL"),
        ("volume_to_liquidity", "REAL"),
        ("flow_imbalance", "REAL"),
        ("trades_5m", "INTEGER"),
        ("market_median_change_5m_pct", "REAL"),
        ("market_positive_share", "REAL"),
        ("quote_attempted", "INTEGER"),
        ("quote_succeeded", "INTEGER"),
        ("quote_input_usd", "REAL"),
        ("quote_roundtrip_usd", "REAL"),
        ("quote_roundtrip_cost_pct", "REAL"),
        ("quote_buy_impact_pct", "REAL"),
        ("quote_sell_impact_pct", "REAL"),
        ("quote_route", "TEXT"),
        ("quote_error", "TEXT"),
        ("outcome_reason", "TEXT"),
        ("outcome_hold_ms", "INTEGER"),
        ("outcome_mfe_pct", "REAL"),
        ("outcome_mae_pct", "REAL"),
    ] {
        if !existing.contains(name) {
            connection
                .execute(
                    &format!("ALTER TABLE observations ADD COLUMN {name} {sql_type}"),
                    [],
                )
                .map_err(|error| format!("Could not upgrade calibration database: {error}"))?;
        }
    }
    Ok(())
}

fn snapshot_timestamp(snapshot: &MarketSnapshot) -> i64 {
    DateTime::parse_from_rfc3339(&snapshot.updated_at)
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|_| Utc::now().timestamp_millis())
}

fn market_regime(tokens: &[MarketToken]) -> (f64, f64) {
    let mut changes: Vec<f64> = tokens
        .iter()
        .map(|token| token.change_5m_pct)
        .filter(|value| value.is_finite())
        .collect();
    if changes.is_empty() {
        return (0.0, 0.0);
    }
    let positive_share =
        changes.iter().filter(|value| **value > 0.0).count() as f64 / changes.len() as f64;
    changes.sort_by(|left, right| left.total_cmp(right));
    let middle = changes.len() / 2;
    let median = if changes.len() % 2 == 0 {
        (changes[middle - 1] + changes[middle]) / 2.0
    } else {
        changes[middle]
    };
    (median, positive_share)
}

fn historical_mark(
    connection: &Connection,
    mint: &str,
    target_ms: i64,
    tolerance_ms: i64,
) -> Result<Option<(f64, f64)>, String> {
    connection
        .query_row(
            "SELECT price_usd,liquidity_usd FROM observations
         WHERE mint=?1 AND observed_at_ms<=?2 AND observed_at_ms>=?3
         ORDER BY observed_at_ms DESC LIMIT 1",
            params![mint, target_ms, target_ms - tolerance_ms],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn percent_change(current: f64, previous: Option<f64>) -> Option<f64> {
    previous
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| (current / value - 1.0) * 100.0)
}

fn record_snapshot(
    connection: &mut Connection,
    snapshot: &MarketSnapshot,
) -> Result<Vec<QuoteCandidate>, String> {
    let observed_at_ms = snapshot_timestamp(snapshot);
    let minute_bucket = observed_at_ms.div_euclid(60_000);
    let (market_median_change, market_positive_share) = market_regime(&snapshot.tokens);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut quote_candidates = Vec::new();
    {
        let mut statement = transaction
            .prepare_cached(
                "INSERT OR IGNORE INTO observations (
              minute_bucket,observed_at_ms,mode,provider,mint,symbol,age_seconds,
              price_usd,change_5m_pct,liquidity_usd,volume_5m_usd,buy_ratio,
              buys_5m,sells_5m,traders_5m,organic_buyers_5m,organic_score,
              model_raw_score,risk_level,mint_authority_revoked,freeze_authority_revoked,
              top_ten_holder_pct,liquidity_locked,entry_price_impact_pct,
              transfer_tax_pct,verified,source,momentum_1m_pct,momentum_15m_pct,
              liquidity_change_5m_pct,volume_to_liquidity,flow_imbalance,trades_5m,
              market_median_change_5m_pct,market_positive_share
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,
                      ?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35)",
            )
            .map_err(|error| error.to_string())?;
        for token in &snapshot.tokens {
            let one_minute =
                historical_mark(&transaction, &token.mint, observed_at_ms - 60_000, 90_000)?;
            let five_minutes =
                historical_mark(&transaction, &token.mint, observed_at_ms - 300_000, 120_000)?;
            let fifteen_minutes =
                historical_mark(&transaction, &token.mint, observed_at_ms - 900_000, 180_000)?;
            let momentum_1m = percent_change(token.price_usd, one_minute.map(|mark| mark.0));
            let momentum_15m = percent_change(token.price_usd, fifteen_minutes.map(|mark| mark.0));
            let liquidity_change_5m =
                percent_change(token.liquidity_usd, five_minutes.map(|mark| mark.1));
            let volume_to_liquidity = token.volume_5m_usd / token.liquidity_usd.max(1.0);
            let flow_imbalance = token.buy_ratio * 2.0 - 1.0;
            let trades_5m = token.buys_5m.saturating_add(token.sells_5m);
            let inserted = statement
                .execute(params![
                    minute_bucket,
                    observed_at_ms,
                    snapshot.mode,
                    snapshot.provider,
                    token.mint,
                    token.symbol,
                    token.age_seconds,
                    token.price_usd,
                    token.change_5m_pct,
                    token.liquidity_usd,
                    token.volume_5m_usd,
                    token.buy_ratio,
                    token.buys_5m,
                    token.sells_5m,
                    token.traders_5m,
                    token.organic_buyers_5m,
                    token.organic_score,
                    token.model_score,
                    token.risk_level,
                    token.safety.mint_authority_revoked,
                    token.safety.freeze_authority_revoked,
                    token.safety.top_ten_holder_pct,
                    token.safety.liquidity_locked,
                    token.safety.price_impact_pct,
                    token.safety.transfer_tax_pct,
                    token.safety.verified,
                    token.source,
                    momentum_1m,
                    momentum_15m,
                    liquidity_change_5m,
                    volume_to_liquidity,
                    flow_imbalance,
                    trades_5m,
                    market_median_change,
                    market_positive_share,
                ])
                .map_err(|error| format!("Could not record calibration observation: {error}"))?;
            if inserted > 0 && quote_probe_eligible(token) {
                quote_candidates.push(QuoteCandidate {
                    id: transaction.last_insert_rowid(),
                    mint: token.mint.clone(),
                    model_score: token.model_score,
                    liquidity_usd: token.liquidity_usd,
                });
            }
        }
    }
    label_policy_outcomes(&transaction, observed_at_ms)?;
    transaction.commit().map_err(|error| error.to_string())?;
    quote_candidates.sort_by(|left, right| {
        right
            .model_score
            .total_cmp(&left.model_score)
            .then_with(|| right.liquidity_usd.total_cmp(&left.liquidity_usd))
    });
    quote_candidates.truncate(QUOTE_PROBES_PER_MINUTE);
    Ok(quote_candidates)
}

fn quote_probe_eligible(token: &MarketToken) -> bool {
    token.price_usd > 0.0
        && token.liquidity_usd >= 250_000.0
        && token.model_score >= 0.70
        && (0.58..=0.75).contains(&token.buy_ratio)
        && matches!(token.risk_level.as_str(), "Low" | "Medium")
        && token.safety.mint_authority_revoked
        && token.safety.freeze_authority_revoked
}

fn calculate_policy_outcome(
    start_ms: i64,
    entry_price: f64,
    entry_liquidity: f64,
    entry_impact: f64,
    now_ms: i64,
    path: &[PathPoint],
) -> Option<PolicyOutcome> {
    let target_ms = start_ms + TARGET_HORIZON_MS;
    if !entry_price.is_finite() || entry_price <= 0.0 || !entry_liquidity.is_finite() {
        return None;
    }
    let mut peak_price = entry_price;
    let mut mfe = f64::NEG_INFINITY;
    let mut mae = f64::INFINITY;
    for point in path {
        if !point.price_usd.is_finite()
            || point.price_usd <= 0.0
            || !point.liquidity_usd.is_finite()
            || !point.exit_impact_pct.is_finite()
        {
            continue;
        }
        peak_price = peak_price.max(point.price_usd);
        let raw_net_return = (point.price_usd / entry_price - 1.0) * 100.0
            - entry_impact
            - point.exit_impact_pct
            - ESTIMATED_ROUND_TRIP_FEE_PCT;
        if !raw_net_return.is_finite() {
            continue;
        }
        // Minute snapshots cannot establish the exact fill inside a gap. Bound
        // markouts before they become labels so one bad provider tick cannot
        // dominate threshold selection or create an infinite training target.
        let net_return = raw_net_return.clamp(MIN_OUTCOME_RETURN_PCT, MAX_OUTCOME_RETURN_PCT);
        mfe = mfe.max(net_return);
        mae = mae.min(net_return);
        let trailing = (peak_price - point.price_usd) / peak_price * 100.0;
        let liquidity_drawdown =
            (entry_liquidity - point.liquidity_usd) / entry_liquidity.max(1.0) * 100.0;
        let reason = if net_return <= -STOP_LOSS_PCT {
            Some("stop_loss")
        } else if trailing >= TRAILING_STOP_PCT {
            Some("trailing_stop")
        } else if net_return >= TAKE_PROFIT_PCT {
            Some("take_profit")
        } else if liquidity_drawdown >= LIQUIDITY_DRAWDOWN_PCT {
            Some("liquidity_drawdown")
        } else if point.buy_ratio < FLOW_EXIT_BUY_RATIO {
            Some("buy_ratio_deterioration")
        } else if point.observed_at_ms >= target_ms {
            Some("max_hold")
        } else {
            None
        };
        if let Some(reason) = reason {
            return Some(PolicyOutcome {
                observed_at_ms: point.observed_at_ms,
                price_usd: Some(point.price_usd),
                net_return_pct: Some(net_return),
                success: net_return > 0.0,
                available: true,
                reason,
                hold_ms: point.observed_at_ms - start_ms,
                mfe_pct: Some(mfe),
                mae_pct: Some(mae),
            });
        }
    }
    if now_ms >= target_ms + OUTCOME_GRACE_MS {
        return Some(PolicyOutcome {
            observed_at_ms: target_ms + OUTCOME_GRACE_MS,
            price_usd: None,
            net_return_pct: None,
            success: false,
            available: false,
            reason: "route_unavailable",
            hold_ms: TARGET_HORIZON_MS + OUTCOME_GRACE_MS,
            mfe_pct: if mfe.is_finite() { Some(mfe) } else { None },
            mae_pct: if mae.is_finite() { Some(mae) } else { None },
        });
    }
    None
}

fn label_policy_outcomes(connection: &Connection, now_ms: i64) -> Result<(), String> {
    let mut pending = connection
        .prepare(
            "SELECT id,mint,observed_at_ms,price_usd,liquidity_usd,entry_price_impact_pct
         FROM observations WHERE outcome_success IS NULL AND observed_at_ms < ?1",
        )
        .map_err(|error| error.to_string())?;
    let due = pending
        .query_map(params![now_ms], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?,
                row.get::<_, f64>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut path_query = connection
        .prepare_cached(
            "SELECT observed_at_ms,price_usd,liquidity_usd,buy_ratio,entry_price_impact_pct
         FROM observations WHERE mint=?1 AND observed_at_ms>?2 AND observed_at_ms<=?3
         ORDER BY observed_at_ms",
        )
        .map_err(|error| error.to_string())?;
    for (id, mint, start_ms, entry_price, entry_liquidity, entry_impact) in due {
        let rows = path_query
            .query_map(
                params![
                    mint,
                    start_ms,
                    (start_ms + TARGET_HORIZON_MS + OUTCOME_GRACE_MS).min(now_ms)
                ],
                |row| {
                    Ok(PathPoint {
                        observed_at_ms: row.get(0)?,
                        price_usd: row.get(1)?,
                        liquidity_usd: row.get(2)?,
                        buy_ratio: row.get(3)?,
                        exit_impact_pct: row.get(4)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        let path = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if let Some(outcome) = calculate_policy_outcome(
            start_ms,
            entry_price,
            entry_liquidity,
            entry_impact,
            now_ms,
            &path,
        ) {
            connection.execute(
                "UPDATE observations SET outcome_observed_at_ms=?1,outcome_price_usd=?2,
                 outcome_net_return_pct=?3,outcome_success=?4,outcome_available=?5,
                 outcome_reason=?6,outcome_hold_ms=?7,outcome_mfe_pct=?8,outcome_mae_pct=?9 WHERE id=?10",
                params![outcome.observed_at_ms,outcome.price_usd,outcome.net_return_pct,outcome.success,outcome.available,outcome.reason,outcome.hold_ms,outcome.mfe_pct,outcome.mae_pct,id],
            ).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[derive(Debug)]
struct QuoteProbe {
    id: i64,
    succeeded: bool,
    roundtrip_usd: Option<f64>,
    roundtrip_cost_pct: Option<f64>,
    buy_impact_pct: Option<f64>,
    sell_impact_pct: Option<f64>,
    route: Option<String>,
    error: Option<String>,
}

async fn probe_round_trips(api_key: &str, candidates: Vec<QuoteCandidate>) -> Vec<QuoteProbe> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent(concat!("PulseForge/", env!("CARGO_PKG_VERSION")))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return candidates
                .into_iter()
                .map(|candidate| failed_probe(candidate.id, error.to_string()))
                .collect()
        }
    };
    let mut probes = Vec::new();
    for (index, candidate) in candidates.into_iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(Duration::from_millis(350)).await;
        }
        let buy = fetch_quote(
            &client,
            api_key,
            USDC_MINT,
            &candidate.mint,
            QUOTE_INPUT_USDC_RAW,
        )
        .await;
        let probe = match buy {
            Ok(buy) => match buy.out_amount.parse::<u64>() {
                Ok(token_amount) if token_amount > 0 => {
                    match fetch_quote(&client, api_key, &candidate.mint, USDC_MINT, token_amount)
                        .await
                    {
                        Ok(sell) => {
                            let roundtrip_raw = sell.out_amount.parse::<u64>().unwrap_or(0);
                            let roundtrip_usd = roundtrip_raw as f64 / 1_000_000.0;
                            let cost_pct =
                                (1.0 - roundtrip_raw as f64 / QUOTE_INPUT_USDC_RAW as f64) * 100.0;
                            QuoteProbe {
                                id: candidate.id,
                                succeeded: roundtrip_raw > 0,
                                roundtrip_usd: Some(roundtrip_usd),
                                roundtrip_cost_pct: Some(cost_pct),
                                buy_impact_pct: buy.price_impact_pct.parse().ok(),
                                sell_impact_pct: sell.price_impact_pct.parse().ok(),
                                route: Some(route_labels(&buy, &sell)),
                                error: None,
                            }
                        }
                        Err(error) => failed_probe(candidate.id, format!("sell quote: {error}")),
                    }
                }
                _ => failed_probe(candidate.id, "buy quote returned no tokens".into()),
            },
            Err(error) => failed_probe(candidate.id, format!("buy quote: {error}")),
        };
        probes.push(probe);
    }
    probes
}

async fn fetch_quote(
    client: &reqwest::Client,
    api_key: &str,
    input_mint: &str,
    output_mint: &str,
    amount: u64,
) -> Result<JupiterQuote, String> {
    let response = client
        .get(QUOTE_URL)
        .header("x-api-key", api_key)
        .query(&[
            ("inputMint", input_mint.to_string()),
            ("outputMint", output_mint.to_string()),
            ("amount", amount.to_string()),
            ("slippageBps", "100".into()),
            ("restrictIntermediateTokens", "true".into()),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    response
        .json::<JupiterQuote>()
        .await
        .map_err(|error| error.to_string())
}

fn route_labels(buy: &JupiterQuote, sell: &JupiterQuote) -> String {
    let mut labels: Vec<String> = buy
        .route_plan
        .iter()
        .chain(&sell.route_plan)
        .filter_map(|step| step.swap_info.label.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    labels.sort();
    if labels.is_empty() {
        "Jupiter route".into()
    } else {
        labels.join(" + ")
    }
}

fn failed_probe(id: i64, error: String) -> QuoteProbe {
    QuoteProbe {
        id,
        succeeded: false,
        roundtrip_usd: None,
        roundtrip_cost_pct: None,
        buy_impact_pct: None,
        sell_impact_pct: None,
        route: None,
        error: Some(error.chars().take(180).collect()),
    }
}

fn save_quote_probe(connection: &Connection, probe: QuoteProbe) -> Result<(), String> {
    connection
        .execute(
            "UPDATE observations SET quote_attempted=1,quote_succeeded=?1,quote_input_usd=20,
         quote_roundtrip_usd=?2,quote_roundtrip_cost_pct=?3,quote_buy_impact_pct=?4,
         quote_sell_impact_pct=?5,quote_route=?6,quote_error=?7 WHERE id=?8",
            params![
                probe.succeeded,
                probe.roundtrip_usd,
                probe.roundtrip_cost_pct,
                probe.buy_impact_pct,
                probe.sell_impact_pct,
                probe.route,
                probe.error,
                probe.id
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn drift_psi(connection: &Connection, latest_ms: Option<i64>) -> Result<Option<f64>, String> {
    let Some(latest) = latest_ms else {
        return Ok(None);
    };
    let bins = |start: i64, end: i64| -> Result<[f64; 10], String> {
        let mut counts = [0.0; 10];
        let mut statement=connection.prepare("SELECT model_raw_score FROM observations WHERE observed_at_ms>=?1 AND observed_at_ms<?2").map_err(|error|error.to_string())?;
        let values = statement
            .query_map(params![start, end], |row| row.get::<_, f64>(0))
            .map_err(|error| error.to_string())?;
        let mut total = 0.0;
        for value in values {
            let score = value.map_err(|error| error.to_string())?;
            counts[((score * 10.0).floor() as isize).clamp(0, 9) as usize] += 1.0;
            total += 1.0;
        }
        if total < 100.0 {
            return Err("insufficient".into());
        }
        for count in &mut counts {
            *count /= total;
        }
        Ok(counts)
    };
    let recent = match bins(latest - 6 * 60 * 60 * 1_000, latest + 1) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let reference = match bins(latest - 30 * 60 * 60 * 1_000, latest - 6 * 60 * 60 * 1_000) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    Ok(Some(
        (0..10)
            .map(|index| {
                let a = recent[index].max(0.0001_f64);
                let b = reference[index].max(0.0001_f64);
                (a - b) * (a / b).ln()
            })
            .sum(),
    ))
}

fn median_quote_cost(connection: &Connection, successful: i64) -> Result<Option<f64>, String> {
    if successful == 0 {
        return Ok(None);
    }
    connection.query_row("SELECT quote_roundtrip_cost_pct FROM observations WHERE quote_succeeded=1 ORDER BY quote_roundtrip_cost_pct LIMIT 1 OFFSET ?1",params![(successful-1)/2],|row|row.get(0)).optional().map_err(|error|error.to_string())
}

fn status_from_connection(
    connection: &Connection,
    path: &Path,
) -> Result<CalibrationStatus, String> {
    let(count,labeled,positive,unavailable,invalid_outcomes,bounded_outcomes,first,last,quote_samples,quote_success):(i64,i64,i64,i64,i64,i64,Option<i64>,Option<i64>,i64,i64)=connection.query_row(
        "SELECT COUNT(*),COUNT(outcome_success),
         COALESCE(SUM(CASE WHEN outcome_success=1 AND outcome_net_return_pct BETWEEN -1.0e308 AND 1.0e308 THEN 1 ELSE 0 END),0),
         COALESCE(SUM(CASE WHEN outcome_available=0 THEN 1 ELSE 0 END),0),
         COALESCE(SUM(CASE WHEN outcome_available=1 AND (outcome_net_return_pct IS NULL OR ABS(outcome_net_return_pct)>1.0e308) THEN 1 ELSE 0 END),0),
         COALESCE(SUM(CASE WHEN outcome_available=1 AND outcome_net_return_pct IS NOT NULL AND (outcome_net_return_pct < -100 OR outcome_net_return_pct > 100) THEN 1 ELSE 0 END),0),
         MIN(observed_at_ms),MAX(observed_at_ms),
         COALESCE(SUM(CASE WHEN quote_attempted=1 THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN quote_succeeded=1 THEN 1 ELSE 0 END),0) FROM observations",
        [],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?)),
    ).map_err(|error|error.to_string())?;
    let days = match (first, last) {
        (Some(a), Some(b)) => (b - a).max(0) as f64 / 86_400_000.0,
        _ => 0.0,
    };
    let usable_labeled = labeled - invalid_outcomes;
    let negative = usable_labeled - positive;
    let ready = days >= MIN_RESEARCH_READY_DAYS
        && usable_labeled >= MIN_RESEARCH_READY_LABELS
        && positive >= MIN_RESEARCH_READY_CLASS
        && negative >= MIN_RESEARCH_READY_CLASS;
    let psi = drift_psi(connection, last)?;
    let drift_status = match psi {
        None => "Insufficient history",
        Some(value) if value < 0.1 => "Stable",
        Some(value) if value < 0.25 => "Watch",
        Some(_) => "Drift alert",
    }
    .to_string();
    let research_artifact = load_research_artifact(path);
    let status = if research_artifact.is_some() {
        "Early research artifact imported; promotion remains evidence-gated"
    } else if ready {
        "Ready for early offline research calibration"
    } else if count == 0 {
        "Waiting for the first live snapshot"
    } else {
        "Collecting point-in-time evidence"
    };
    Ok(CalibrationStatus {
        storage_path: path.to_string_lossy().into_owned(),
        observation_count: count,
        labeled_count: labeled,
        pending_count: count - labeled,
        positive_count: positive,
        negative_count: negative,
        unavailable_count: unavailable,
        invalid_outcome_count: invalid_outcomes,
        bounded_outcome_count: bounded_outcomes,
        observation_days: days,
        target_horizon_minutes: TARGET_HORIZON_MS / 60_000,
        quote_sample_count: quote_samples,
        quote_success_count: quote_success,
        quote_failure_count: quote_samples - quote_success,
        real_quote_coverage_pct: if quote_samples > 0 {
            Some(quote_success as f64 / quote_samples as f64 * 100.0)
        } else {
            None
        },
        median_round_trip_cost_pct: median_quote_cost(connection, quote_success)?,
        drift_psi: psi,
        drift_status,
        ready_for_first_calibration: ready,
        promotion_evidence_days: PROMOTION_EVIDENCE_DAYS,
        research_artifact,
        status: status.into(),
    })
}

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn write_csv(connection: &Connection, destination: &Path) -> Result<(), String> {
    let columns="observed_at_ms,mode,provider,mint,symbol,age_seconds,price_usd,change_5m_pct,liquidity_usd,volume_5m_usd,buy_ratio,buys_5m,sells_5m,traders_5m,organic_buyers_5m,organic_score,model_raw_score,risk_level,mint_authority_revoked,freeze_authority_revoked,top_ten_holder_pct,liquidity_locked,entry_price_impact_pct,transfer_tax_pct,verified,source,momentum_1m_pct,momentum_15m_pct,liquidity_change_5m_pct,volume_to_liquidity,flow_imbalance,trades_5m,market_median_change_5m_pct,market_positive_share,quote_attempted,quote_succeeded,quote_input_usd,quote_roundtrip_usd,quote_roundtrip_cost_pct,quote_buy_impact_pct,quote_sell_impact_pct,quote_route,quote_error,outcome_observed_at_ms,outcome_price_usd,outcome_net_return_pct,outcome_success,outcome_available,outcome_reason,outcome_hold_ms,outcome_mfe_pct,outcome_mae_pct";
    let headers="observedAtMs,mode,provider,mint,symbol,ageSeconds,priceUsd,change5mPct,liquidityUsd,volume5mUsd,buyRatio,buys5m,sells5m,traders5m,organicBuyers5m,organicScore,modelRawScore,riskLevel,mintAuthorityRevoked,freezeAuthorityRevoked,topTenHolderPct,liquidityLocked,entryPriceImpactPct,transferTaxPct,verified,source,momentum1mPct,momentum15mPct,liquidityChange5mPct,volumeToLiquidity,flowImbalance,trades5m,marketMedianChange5mPct,marketPositiveShare,quoteAttempted,quoteSucceeded,quoteInputUsd,quoteRoundtripUsd,quoteRoundtripCostPct,quoteBuyImpactPct,quoteSellImpactPct,quoteRoute,quoteError,outcomeObservedAtMs,outcomePriceUsd,outcomeNetReturnPct,outcomeSuccess,outcomeAvailable,outcomeReason,outcomeHoldMs,outcomeMfePct,outcomeMaePct";
    let file = fs::File::create(destination)
        .map_err(|error| format!("Could not create calibration CSV: {error}"))?;
    let mut output = BufWriter::new(file);
    writeln!(output, "{headers}").map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(&format!(
            "SELECT {columns} FROM observations ORDER BY observed_at_ms,mint"
        ))
        .map_err(|error| error.to_string())?;
    let column_count = statement.column_count();
    let rows = statement
        .query_map([], |row| {
            let mut cells = Vec::with_capacity(column_count);
            for index in 0..column_count {
                let value = row.get_ref(index)?;
                cells.push(match value {
                    rusqlite::types::ValueRef::Null => String::new(),
                    rusqlite::types::ValueRef::Integer(v) => v.to_string(),
                    rusqlite::types::ValueRef::Real(v) => v.to_string(),
                    rusqlite::types::ValueRef::Text(v) => csv_cell(&String::from_utf8_lossy(v)),
                    rusqlite::types::ValueRef::Blob(_) => String::new(),
                });
            }
            Ok(cells.join(","))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        writeln!(output, "{}", row.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    }
    output
        .flush()
        .map_err(|error| format!("Could not finish calibration CSV: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SafetyChecks;

    fn token(mint: &str, price: f64) -> MarketToken {
        MarketToken {
            icon_url: None,
            mint: mint.into(),
            symbol: mint.into(),
            name: mint.into(),
            age_seconds: 3600,
            price_usd: price,
            market_cap_usd: None,
            change_5m_pct: 1.0,
            liquidity_usd: 300_000.0,
            volume_5m_usd: 150_000.0,
            buy_ratio: 0.65,
            buys_5m: 30,
            sells_5m: 15,
            traders_5m: 100,
            organic_buyers_5m: 12,
            organic_score: Some(50.0),
            risk_level: "Medium".into(),
            model_score: 0.75,
            safety: SafetyChecks {
                mint_authority_revoked: true,
                freeze_authority_revoked: true,
                top_ten_holder_pct: 20.0,
                liquidity_locked: Some(true),
                price_impact_pct: 0.2,
                transfer_tax_pct: 0.0,
                transfer_tax_unknown: false,
                verified: true,
            },
            source: "test".into(),
            updated_at: String::new(),
        }
    }
    fn snapshot(at_ms: i64, tokens: Vec<MarketToken>) -> MarketSnapshot {
        MarketSnapshot {
            mode: "live".into(),
            provider: "test".into(),
            latency_ms: 1,
            updated_at: DateTime::<Utc>::from_timestamp_millis(at_ms)
                .unwrap()
                .to_rfc3339(),
            tokens,
            warning: None,
        }
    }
    fn test_database(name: &str) -> (PathBuf, Connection) {
        let path = std::env::temp_dir().join(format!(
            "pulseforge-{name}-{}.sqlite3",
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let connection = open(&path).unwrap();
        (path, connection)
    }

    #[test]
    fn samples_once_per_minute_and_labels_take_profit() {
        let (path, mut connection) = test_database("calibration-profit");
        let start = 1_750_000_000_000;
        record_snapshot(&mut connection, &snapshot(start, vec![token("A", 1.0)])).unwrap();
        record_snapshot(
            &mut connection,
            &snapshot(start + 5_000, vec![token("A", 1.1)]),
        )
        .unwrap();
        record_snapshot(
            &mut connection,
            &snapshot(start + 60_000, vec![token("A", 1.11)]),
        )
        .unwrap();
        let result:(String,f64)=connection.query_row("SELECT outcome_reason,outcome_net_return_pct FROM observations WHERE mint='A' AND outcome_success=1",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(result.0, "take_profit");
        assert!(result.1 > 8.0);
        drop(connection);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn records_exact_policy_flow_exit_and_regime() {
        let (path, mut connection) = test_database("calibration-flow");
        let start = 1_750_000_000_000;
        record_snapshot(&mut connection, &snapshot(start, vec![token("A", 1.0)])).unwrap();
        let mut falling = token("A", 0.99);
        falling.buy_ratio = 0.40;
        record_snapshot(&mut connection, &snapshot(start + 60_000, vec![falling])).unwrap();
        let result:(String,Option<f64>,f64)=connection.query_row("SELECT outcome_reason,momentum_1m_pct,market_positive_share FROM observations WHERE mint='A' ORDER BY observed_at_ms LIMIT 1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(result.0, "buy_ratio_deterioration");
        assert!(result.1.is_none());
        assert_eq!(result.2, 1.0);
        drop(connection);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn retains_disappeared_tokens_as_negative_unavailable_outcomes() {
        let (path, mut connection) = test_database("calibration-missing");
        let start = 1_750_000_000_000;
        record_snapshot(&mut connection, &snapshot(start, vec![token("A", 1.0)])).unwrap();
        record_snapshot(
            &mut connection,
            &snapshot(
                start + TARGET_HORIZON_MS + OUTCOME_GRACE_MS,
                vec![token("B", 1.0)],
            ),
        )
        .unwrap();
        let status = status_from_connection(&connection, &path).unwrap();
        assert_eq!(status.negative_count, 1);
        assert_eq!(status.unavailable_count, 1);
        drop(connection);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn bounds_gap_returns_before_storing_training_labels() {
        let outcome = calculate_policy_outcome(
            1_750_000_000_000,
            1.0,
            300_000.0,
            0.2,
            1_750_000_060_000,
            &[PathPoint {
                observed_at_ms: 1_750_000_060_000,
                price_usd: 1_000.0,
                liquidity_usd: 300_000.0,
                buy_ratio: 0.65,
                exit_impact_pct: 0.2,
            }],
        )
        .unwrap();
        assert_eq!(outcome.reason, "take_profit");
        assert_eq!(outcome.net_return_pct, Some(MAX_OUTCOME_RETURN_PCT));
        assert_eq!(outcome.mfe_pct, Some(MAX_OUTCOME_RETURN_PCT));
    }

    #[test]
    fn validates_research_report_without_activating_a_model() {
        let value = serde_json::json!({
            "schemaVersion": 3,
            "trainedAt": "2026-08-23T01:00:00+00:00",
            "champion": "histGradientBoosting",
            "datasetAudit": { "rows": 1000, "observationSpanDays": 1.5 },
            "segments": { "test": 200 },
            "untouchedTest": {
                "shippedBaselineRaw": { "roc_auc": 0.55 },
                "calibrated": { "roc_auc": 0.70, "brier": 0.09 },
                "costStressedThresholdPerformance": { "observations": 35, "meanNetReturnPct": -0.96 }
            },
            "dataQuality": {
                "excludedNonFiniteReturns": 1,
                "excludedMissingAvailableReturns": 0,
                "returnsWinsorizedForEvaluation": 12
            },
            "promotionEligible": false
        });
        let artifact = parse_research_artifact(&value.to_string()).unwrap();
        assert_eq!(artifact.champion, "histGradientBoosting");
        assert_eq!(artifact.selected_observations, 35);
        assert!(!artifact.promotion_eligible);
    }
}
