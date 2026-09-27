use std::{
    cmp::Ordering,
    collections::HashSet,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Utc};
use serde_json::Value;
use solana_sdk::pubkey::Pubkey;

use crate::{
    model::{baseline_score, classify_risk, Features},
    types::{MarketSnapshot, MarketToken, SafetyChecks},
};

const CATEGORY_CACHE_TTL: Duration = Duration::from_secs(30);
const CATEGORY_REQUEST_GAP: Duration = Duration::from_millis(350);
const MAX_TOKEN_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const MAX_UNIVERSE_SIZE: usize = 120;
const MATURE_DISCOVERY_SLOTS: usize = 40;
const MATURE_DISCOVERY_MIN_LIQUIDITY_USD: f64 = 20_000.0;
const NEW_LAUNCH_MAX_AGE_SECONDS: u64 = 3_600;
const MAX_LAUNCH_DATA_AGE_SECONDS: i64 = 60;
const LEGACY_SPL_TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
static CATEGORY_CACHE: OnceLock<Mutex<Option<CategoryCache>>> = OnceLock::new();

#[derive(Clone)]
struct CategoryCache {
    fetched_at: Instant,
    tokens: Vec<MarketToken>,
}

pub async fn snapshot() -> MarketSnapshot {
    let started = Instant::now();
    let now = Utc::now().to_rfc3339();

    let api_key = std::env::var("JUPITER_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty());

    if let Some(api_key) = api_key {
        match fetch_jupiter_universe(&api_key).await {
            Ok((tokens, source_warnings)) if !tokens.is_empty() => {
                let mut warning = "Fresh launches are prioritized. Missing fee evidence is checked against mint accounts; unverified or unsupported mint data blocks entry. Scanner prices and paper fills remain estimates.".to_string();
                if !source_warnings.is_empty() {
                    warning.push_str(" Degraded sources: ");
                    warning.push_str(&source_warnings.join("; "));
                }
                return MarketSnapshot {
                    mode: "live".into(),
                    provider: "Jupiter recent + trending + organic + traded".into(),
                    latency_ms: started.elapsed().as_millis() as u64,
                    updated_at: now,
                    tokens,
                    warning: Some(warning),
                };
            }
            Ok(_) => {
                return demo_snapshot(Some(
                    "Jupiter returned no usable candidates; showing demo feed.".into(),
                ))
            }
            Err(error) => {
                return demo_snapshot(Some(format!(
                    "Live discovery unavailable ({error}); showing demo feed."
                )))
            }
        }
    }

    demo_snapshot(Some(
        "Set JUPITER_API_KEY in the Windows user environment to enable blended live discovery."
            .into(),
    ))
}

pub async fn token_by_mint(mint: &str) -> Result<MarketToken, String> {
    tokens_by_mints(&[mint.to_string()], crate::jupiter_requests::Priority::Entry).await?
        .into_iter().next().ok_or_else(|| "Jupiter did not return this token mint".into())
}

pub async fn tokens_by_mints(mints: &[String], priority: crate::jupiter_requests::Priority) -> Result<Vec<MarketToken>, String> {
    if mints.is_empty() { return Ok(Vec::new()); }
    if mints.len() > 100 { return Err("Token refresh is limited to 100 mints".into()); }
    let requested: HashSet<String> = mints.iter().map(|mint| mint.parse::<Pubkey>()
        .map(|key| key.to_string()).map_err(|_| "Token address is not a valid Solana mint".to_string()))
        .collect::<Result<_, _>>()?;
    let mut ordered: Vec<_> = requested.iter().cloned().collect(); ordered.sort();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5))
        .user_agent(concat!("PulseForge/", env!("CARGO_PKG_VERSION"))).build().map_err(|e| e.to_string())?;
    let mut request = client.get("https://api.jup.ag/tokens/v2/search").query(&[("query", ordered.join(","))]);
    if let Ok(key) = std::env::var("JUPITER_API_KEY") { if !key.trim().is_empty() { request = request.header("x-api-key", key); } }
    let response = crate::jupiter_requests::send(request, priority).await?;
    if !response.status().is_success() { return Err(format!("Jupiter token lookup HTTP {}", response.status())); }
    let body = response.bytes().await.map_err(|e| e.to_string())?;
    if body.len() > MAX_TOKEN_RESPONSE_BYTES { return Err("Jupiter token lookup exceeded 5 MiB".into()); }
    let payload: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let rows = payload.as_array().ok_or("Jupiter token lookup was not an array")?;
    let mut tokens = deduplicate(rows.iter().filter_map(parse_jupiter_token)
        .filter(|token| requested.contains(&token.mint) && token.price_usd.is_finite() && token.price_usd > 0.0).collect());
    crate::mint_safety::resolve_unknown_mint_safety(&mut tokens).await;
    for token in &mut tokens { token.risk_level = classify_risk(&token.safety, token.liquidity_usd, token.age_seconds); }
    Ok(tokens)
}

async fn fetch_jupiter_universe(api_key: &str) -> Result<(Vec<MarketToken>, Vec<String>), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent(concat!("PulseForge/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;

    let mut warnings = Vec::new();
    let mut recent =
        match fetch_jupiter_list(&client, api_key, "https://api.jup.ag/tokens/v2/recent").await {
            Ok(tokens) => tokens,
            Err(error) => {
                warnings.push(format!("recent: {error}"));
                Vec::new()
            }
        };

    let cached = category_cache();
    let categories_fresh = cached
        .as_ref()
        .is_some_and(|entry| entry.fetched_at.elapsed() < CATEGORY_CACHE_TTL);
    let categories = if categories_fresh {
        cached.map(|entry| entry.tokens).unwrap_or_default()
    } else {
        let mut refreshed = Vec::new();
        for (name, url) in [
            (
                "trending-5m",
                "https://api.jup.ag/tokens/v2/toptrending/5m?limit=100",
            ),
            (
                "organic-5m",
                "https://api.jup.ag/tokens/v2/toporganicscore/5m?limit=100",
            ),
            (
                "traded-5m",
                "https://api.jup.ag/tokens/v2/toptraded/5m?limit=100",
            ),
        ] {
            tokio::time::sleep(CATEGORY_REQUEST_GAP).await;
            match fetch_jupiter_list(&client, api_key, url).await {
                Ok(mut tokens) => refreshed.append(&mut tokens),
                Err(error) => warnings.push(format!("{name}: {error}")),
            }
        }

        if refreshed.is_empty() {
            if let Some(stale) = cached {
                warnings.push("using stale activity cache".into());
                stale.tokens
            } else {
                Vec::new()
            }
        } else {
            store_category_cache(refreshed.clone());
            refreshed
        }
    };

    recent.extend(categories);
    let mut tokens = select_discovery_universe(recent, Utc::now().timestamp_millis());

    let mint_safety = crate::mint_safety::resolve_unknown_mint_safety(&mut tokens).await;
    for token in &mut tokens {
        token.risk_level = classify_risk(&token.safety, token.liquidity_usd, token.age_seconds);
    }
    if mint_safety.blocked > 0 {
        warnings.push(format!("{} mint fee checks remain unverified or unsupported", mint_safety.blocked));
    }

    if tokens.is_empty() {
        return Err(if warnings.is_empty() {
            "Jupiter returned no valid token rows".into()
        } else {
            warnings.join("; ")
        });
    }

    Ok((tokens, warnings))
}

async fn fetch_jupiter_list(
    client: &reqwest::Client,
    api_key: &str,
    url: &str,
) -> Result<Vec<MarketToken>, String> {
    let response = crate::jupiter_requests::send(client.get(url).header("x-api-key", api_key),
        crate::jupiter_requests::Priority::Background).await?;

    if !response.status().is_success() {
        return Err(format!("Jupiter HTTP {}", response.status()));
    }

    let body = response.bytes().await.map_err(|error| error.to_string())?;
    if body.len() > MAX_TOKEN_RESPONSE_BYTES {
        return Err("Jupiter token response exceeded 5 MiB".into());
    }
    let payload: Value = serde_json::from_slice(&body).map_err(|error| error.to_string())?;
    let rows = payload
        .as_array()
        .ok_or_else(|| "Jupiter response was not an array".to_string())?;

    Ok(rows
        .iter()
        .take(100)
        .filter_map(parse_jupiter_token)
        .collect())
}

fn parse_jupiter_token(value: &Value) -> Option<MarketToken> {
    let mint = string_at(value, &["id", "address", "mint"])?;
    mint.parse::<Pubkey>().ok()?;
    let audit = value.get("audit").unwrap_or(&Value::Null);
    if bool_at(audit, &["isSus"]) == Some(true) {
        return None;
    }
    let symbol = string_at(value, &["symbol"]).unwrap_or_else(|| abbreviated(&mint));
    let name = string_at(value, &["name"]).unwrap_or_else(|| "Unnamed token".into());
    let icon_url = trusted_provider_icon(value);
    let price_usd = nonnegative(number_at(value, &["usdPrice"]));
    let market_cap_usd = number_at(value, &["mcap", "marketCap", "marketCapUsd"])
        .filter(|market_cap| market_cap.is_finite() && *market_cap > 0.0);
    let liquidity_usd = nonnegative(number_at(value, &["liquidity"]));
    let buy_volume = nonnegative(nested_number(value, "stats5m", &["buyVolume"]));
    let sell_volume = nonnegative(nested_number(value, "stats5m", &["sellVolume"]));
    let volume_5m_usd = buy_volume + sell_volume;
    let flow_total = buy_volume + sell_volume;
    let buy_ratio = if flow_total > 0.0 {
        (buy_volume / flow_total).clamp(0.0, 1.0)
    } else {
        0.5
    };
    let change_5m_pct = finite_or_zero(nested_number(value, "stats5m", &["priceChange"]));
    let buys_5m = nested_count(value, "stats5m", "numBuys");
    let sells_5m = nested_count(value, "stats5m", "numSells");
    let traders_5m = nested_count(value, "stats5m", "numTraders");
    let organic_buyers_5m = nested_count(value, "stats5m", "numOrganicBuyers");
    let organic_score = number_at(value, &["organicScore"])
        .filter(|score| score.is_finite() && (0.0..=100.0).contains(score));
    // Zero also represents unconfirmed pool age; launch strategies require a
    // positive minimum age and must never treat this as a confirmed new launch.
    let age_seconds = pool_age(value).unwrap_or(0);

    let mint_authority_present = authority_present(value, "mintAuthority");
    let freeze_authority_present = authority_present(value, "freezeAuthority");
    let safety = SafetyChecks {
        mint_authority_revoked: !mint_authority_present
            && bool_at(audit, &["mintAuthorityDisabled"]).unwrap_or(false),
        freeze_authority_revoked: !freeze_authority_present
            && bool_at(audit, &["freezeAuthorityDisabled"]).unwrap_or(false),
        top_ten_holder_pct: number_at(audit, &["topHoldersPercentage", "top10HoldersPercentage"])
            .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
            .unwrap_or(100.0),
        liquidity_locked: bool_at(audit, &["isLiquidityLocked", "liquidityLocked"]),
        price_impact_pct: if liquidity_usd > 0.0 {
            ((250.0 / liquidity_usd).sqrt() * 20.0).clamp(0.02, 25.0)
        } else {
            25.0
        },
        transfer_tax_pct: transfer_tax_pct(value, audit),
        transfer_tax_unknown: audit.get("transferFeePct").is_none()
            && audit.get("transferTaxPct").is_none()
            && string_at(value, &["tokenProgram"]).as_deref() != Some(LEGACY_SPL_TOKEN_PROGRAM),
        verified: bool_at(value, &["isVerified", "verified"]).unwrap_or(false),
    };

    let features = Features {
        momentum_5m_pct: change_5m_pct,
        liquidity_usd,
        volume_to_liquidity: volume_5m_usd / liquidity_usd.max(1.0),
        buy_ratio,
        age_seconds,
        top_ten_holder_pct: safety.top_ten_holder_pct,
        authorities_revoked: safety.mint_authority_revoked && safety.freeze_authority_revoked,
        verified: safety.verified,
    };
    let risk_level = classify_risk(&safety, liquidity_usd, age_seconds);

    Some(MarketToken {
        mint,
        symbol,
        name,
        icon_url,
        age_seconds,
        price_usd,
        market_cap_usd,
        change_5m_pct,
        liquidity_usd,
        volume_5m_usd,
        buy_ratio,
        buys_5m,
        sells_5m,
        traders_5m,
        organic_buyers_5m,
        organic_score,
        risk_level,
        model_score: baseline_score(features),
        safety,
        source: "Jupiter Tokens V2".into(),
        // Never turn an unknown provider timestamp into a fresh observation.
        updated_at: string_at(value, &["updatedAt"]).unwrap_or_default(),
    })
}

fn category_cache() -> Option<CategoryCache> {
    CATEGORY_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|entry| entry.clone())
        .map(|mut entry| {
            age_cached_tokens(&mut entry.tokens, entry.fetched_at.elapsed().as_secs());
            entry
        })
}

fn age_cached_tokens(tokens: &mut [MarketToken], elapsed_seconds: u64) {
    for token in tokens {
        if token.age_seconds > 0 {
            token.age_seconds = token.age_seconds.saturating_add(elapsed_seconds);
        }
    }
}

fn store_category_cache(tokens: Vec<MarketToken>) {
    if let Ok(mut cache) = CATEGORY_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *cache = Some(CategoryCache {
            fetched_at: Instant::now(),
            tokens,
        });
    }
}

fn deduplicate(tokens: Vec<MarketToken>) -> Vec<MarketToken> {
    let mut seen = HashSet::new();
    let mut unique: Vec<MarketToken> = Vec::new();
    let now = Utc::now();
    let valid_update = |token: &MarketToken| {
        DateTime::parse_from_rfc3339(&token.updated_at)
            .ok()
            .filter(|timestamp| timestamp.timestamp_millis() > 0 && *timestamp <= now)
    };
    for token in tokens {
        if seen.insert(token.mint.clone()) {
            unique.push(token);
            continue;
        }
        // Keep the first mint's position in the universe, but use the freshest
        // complete row across recent and category sources. Unknown or invalid
        // timestamps must never displace usable provider evidence.
        if let Some(previous) = unique.iter_mut().find(|row| row.mint == token.mint) {
            let replace = match (valid_update(&token), valid_update(previous)) {
                (Some(next), Some(current)) => next > current,
                (Some(_), None) => true,
                _ => false,
            };
            if replace {
                *previous = token;
            }
        }
    }
    unique
}

fn paper_eligible_at_25(token: &MarketToken) -> bool {
    token.price_usd > 0.0
        && token.liquidity_usd >= 50_000.0
        && token.safety.mint_authority_revoked
        && token.safety.freeze_authority_revoked
        && token.safety.top_ten_holder_pct <= 35.0
        && token.safety.transfer_tax_pct <= 1.0
        && ((25.0 / token.liquidity_usd).sqrt() * 20.0) <= 0.75
}

fn pump_watch_candidate(token: &MarketToken) -> bool {
    (300..=2_700).contains(&token.age_seconds)
        && (4.0..=35.0).contains(&token.change_5m_pct)
        && token.liquidity_usd >= 150_000.0
        && token.volume_5m_usd >= 75_000.0
        && token.volume_5m_usd / token.liquidity_usd.max(1.0) >= 0.5
        && (0.60..=0.82).contains(&token.buy_ratio)
        && token.traders_5m >= 50
        && token.organic_buyers_5m >= 8
}

fn rank_universe(tokens: &mut [MarketToken]) {
    let now = Utc::now().timestamp();
    tokens.sort_by(|a, b| {
        // Rank the launch cohort before trimming the blended feed. Established
        // high-score tokens must not crowd launches out before safety checks.
        fresh_launch_candidate(b, now)
            .cmp(&fresh_launch_candidate(a, now))
            .then_with(|| paper_eligible_at_25(b).cmp(&paper_eligible_at_25(a)))
            .then_with(|| pump_watch_candidate(b).cmp(&pump_watch_candidate(a)))
            .then_with(|| {
                b.model_score
                    .partial_cmp(&a.model_score)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| {
                b.liquidity_usd
                    .partial_cmp(&a.liquidity_usd)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| a.age_seconds.cmp(&b.age_seconds))
            .then_with(|| a.mint.cmp(&b.mint))
    });
}

fn select_discovery_universe(tokens: Vec<MarketToken>, at_ms: i64) -> Vec<MarketToken> {
    let mut ranked = deduplicate(tokens);
    rank_universe(&mut ranked);
    // Retain a mature, liquid cohort even when fresh launches fill the feed.
    // The rest retains its original ranking; unused reserved slots stay usable.
    let reserved: HashSet<_> = ranked
        .iter()
        .filter(|token| mature_discovery_candidate(token, at_ms))
        .take(MATURE_DISCOVERY_SLOTS)
        .map(|token| token.mint.clone())
        .collect();
    let mut remaining = MAX_UNIVERSE_SIZE - reserved.len();
    ranked.retain(|token| {
        if reserved.contains(&token.mint) {
            true
        } else if remaining > 0 {
            remaining -= 1;
            true
        } else {
            false
        }
    });
    ranked
}

fn mature_discovery_candidate(token: &MarketToken, at_ms: i64) -> bool {
    // This only reserves discovery capacity. Fee verification follows selection,
    // and the native buy policy independently requires all entry evidence.
    token.age_seconds >= 86_400
        && token.price_usd.is_finite()
        && token.price_usd > 0.0
        && token.liquidity_usd.is_finite()
        && token.liquidity_usd >= MATURE_DISCOVERY_MIN_LIQUIDITY_USD
        && token.safety.top_ten_holder_pct.is_finite()
        && (0.0..=20.0).contains(&token.safety.top_ten_holder_pct)
        && token.traders_5m >= 25
        && token.sells_5m >= 10
        && token.safety.mint_authority_revoked
        && token.safety.freeze_authority_revoked
        && DateTime::parse_from_rfc3339(&token.updated_at)
            .ok()
            .map(|timestamp| timestamp.timestamp_millis())
            .filter(|timestamp| *timestamp > 0 && *timestamp <= at_ms)
            .is_some_and(|timestamp| at_ms - timestamp <= 75_000)
}

fn fresh_launch_candidate(token: &MarketToken, now: i64) -> bool {
    if !(1..=NEW_LAUNCH_MAX_AGE_SECONDS).contains(&token.age_seconds) {
        return false;
    }
    DateTime::parse_from_rfc3339(&token.updated_at)
        .ok()
        .and_then(|timestamp| now.checked_sub(timestamp.timestamp()))
        .is_some_and(|age| (0..=MAX_LAUNCH_DATA_AGE_SECONDS).contains(&age))
}

fn demo_snapshot(warning: Option<String>) -> MarketSnapshot {
    let started = Instant::now();
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let definitions = [
        (
            "BYTEFROG",
            "ByteFrog",
            0.000_096_8,
            138_226.0,
            615_000.0,
            0.81,
            4_740,
            true,
            true,
            18.2,
            false,
        ),
        (
            "NEONWIF",
            "NeonWif Hat",
            0.000_142,
            412_981.0,
            1_240_000.0,
            0.72,
            15_120,
            true,
            true,
            21.5,
            true,
        ),
        (
            "SOLPUNK", "Solpunk", 0.001_873, 287_451.0, 392_000.0, 0.61, 10_020, true, true, 24.4,
            false,
        ),
        (
            "MINTY",
            "Minty Boi",
            0.000_057_1,
            95_431.0,
            402_000.0,
            0.54,
            11_100,
            false,
            true,
            38.7,
            false,
        ),
        (
            "GIGAOWL",
            "Giga Owl",
            0.000_312,
            623_118.0,
            2_030_000.0,
            0.67,
            19_980,
            true,
            true,
            17.4,
            true,
        ),
        (
            "DUSTY",
            "Dusty Cat",
            0.000_021_4,
            42_870.0,
            178_000.0,
            0.49,
            6_240,
            true,
            true,
            43.2,
            false,
        ),
        (
            "ORBZ", "Orbzz", 0.000_184, 201_955.0, 741_000.0, 0.73, 8_280, true, true, 27.1, false,
        ),
        (
            "SLIMEAI",
            "Slime AI",
            0.000_263,
            534_672.0,
            1_110_000.0,
            0.66,
            21_720,
            true,
            true,
            20.3,
            true,
        ),
        (
            "PIXELPUP",
            "Pixel Pup",
            0.000_013_2,
            28_914.0,
            96_000.0,
            0.84,
            2_940,
            true,
            false,
            52.0,
            false,
        ),
        (
            "VOID",
            "Void Token",
            0.000_077_5,
            112_337.0,
            389_000.0,
            0.58,
            25_860,
            true,
            true,
            31.8,
            false,
        ),
        (
            "MOONZIP", "Moon Zip", 0.000_428, 210_000.0, 150_000.0, 0.68, 1_320, true, true, 24.2,
            false,
        ),
        (
            "TIDEBIT",
            "Tide Bit",
            0.002_14,
            880_300.0,
            3_420_000.0,
            0.59,
            44_400,
            true,
            true,
            15.6,
            true,
        ),
    ];

    let tokens = definitions
        .iter()
        .enumerate()
        .map(
            |(
                index,
                (
                    symbol,
                    name,
                    base_price,
                    liquidity,
                    volume,
                    buy_ratio,
                    age,
                    mint,
                    freeze,
                    top_ten,
                    verified,
                ),
            )| {
                let wave = (((now_secs as f64 / 4.0) + index as f64 * 1.71).sin()) * 0.012;
                let momentum = if *symbol == "MOONZIP" {
                    10.0 + wave * 100.0
                } else {
                    wave * 100.0 + ((index as f64 % 3.0) - 1.0) * 0.42
                };
                let price_impact_pct = ((250.0_f64 / *liquidity).sqrt() * 20.0).clamp(0.02, 25.0);
                let safety = SafetyChecks {
                    mint_authority_revoked: *mint,
                    freeze_authority_revoked: *freeze,
                    top_ten_holder_pct: *top_ten,
                    liquidity_locked: Some(index % 4 != 0),
                    price_impact_pct,
                    transfer_tax_pct: if index == 8 { 2.5 } else { 0.0 },
                    transfer_tax_unknown: false,
                    verified: *verified,
                };
                let features = Features {
                    momentum_5m_pct: momentum,
                    liquidity_usd: *liquidity,
                    volume_to_liquidity: *volume / *liquidity,
                    buy_ratio: *buy_ratio,
                    age_seconds: *age,
                    top_ten_holder_pct: *top_ten,
                    authorities_revoked: *mint && *freeze,
                    verified: *verified,
                };
                MarketToken {
                    mint: format!("DemoMint{index:02}111111111111111111111111111111"),
                    symbol: (*symbol).into(),
                    name: (*name).into(),
                    icon_url: None,
                    age_seconds: *age + (now_secs % 900),
                    price_usd: *base_price * (1.0 + wave),
                    market_cap_usd: Some(*liquidity * (3.0 + (index % 5) as f64 * 1.4)),
                    change_5m_pct: momentum,
                    liquidity_usd: *liquidity,
                    volume_5m_usd: *volume,
                    buy_ratio: *buy_ratio,
                    buys_5m: ((*volume / 80.0).round() as u64).max(20),
                    sells_5m: ((*volume / 100.0).round() as u64).max(12),
                    traders_5m: ((*volume / 400.0).round() as u64).max(25),
                    organic_buyers_5m: ((*volume / 8_000.0).round() as u64).max(4),
                    organic_score: Some(if *verified { 82.0 } else { 61.0 }),
                    risk_level: classify_risk(&safety, *liquidity, *age),
                    model_score: baseline_score(features),
                    safety,
                    source: "Deterministic demo".into(),
                    updated_at: Utc::now().to_rfc3339(),
                }
            },
        )
        .collect();

    MarketSnapshot {
        mode: "demo".into(),
        provider: "Deterministic demo feed".into(),
        latency_ms: started.elapsed().as_millis() as u64 + 7,
        updated_at: Utc::now().to_rfc3339(),
        tokens,
        warning,
    }
}

fn pool_age(value: &Value) -> Option<u64> {
    let first_pool = value.get("firstPool")?;
    let raw = first_pool.get("createdAt")?;
    let timestamp = if let Some(number) = raw.as_i64() {
        if number > 10_000_000_000 {
            number / 1000
        } else {
            number
        }
    } else {
        let text = raw.as_str()?;
        DateTime::parse_from_rfc3339(text).ok()?.timestamp()
    };
    let now = Utc::now().timestamp();
    if timestamp <= 0 {
        return None;
    }
    now.checked_sub(timestamp)
        .and_then(|age| u64::try_from(age).ok())
}

fn string_at(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(str::to_owned))
}

fn number_at(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|raw| {
            raw.as_f64()
                .or_else(|| raw.as_str().and_then(|text| text.parse::<f64>().ok()))
        })
    })
}

fn nested_number(value: &Value, parent: &str, keys: &[&str]) -> Option<f64> {
    value.get(parent).and_then(|nested| number_at(nested, keys))
}

fn nested_count(value: &Value, parent: &str, key: &str) -> u64 {
    value
        .get(parent)
        .and_then(|nested| nested.get(key))
        .and_then(|raw| {
            raw.as_u64().or_else(|| {
                raw.as_f64()
                    .filter(|value| value.is_finite() && *value >= 0.0)
                    .map(|value| value as u64)
            })
        })
        .unwrap_or(0)
}

fn bool_at(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_bool))
}

fn authority_present(value: &Value, key: &str) -> bool {
    match value.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::String(authority)) => !authority.trim().is_empty(),
        // A malformed authority cannot confirm revocation even when an audit
        // flag contradicts it.
        Some(_) => true,
    }
}

fn transfer_tax_pct(value: &Value, audit: &Value) -> f64 {
    let keys = ["transferFeePct", "transferTaxPct"];
    if keys.iter().any(|key| audit.get(*key).is_some()) {
        return keys
            .iter()
            .filter(|key| audit.get(**key).is_some())
            .map(|key| {
                number_at(audit, &[*key])
                    .filter(|fee| fee.is_finite() && (0.0..=100.0).contains(fee))
                    .unwrap_or(100.0)
            })
            .fold(0.0, f64::max);
    }
    // Tokens V2 does not guarantee transfer-fee fields. Only the original SPL
    // program excludes transfer-fee extensions by design. Keep the numeric
    // safety contract while failing closed for Token-2022/unknown programs.
    if string_at(value, &["tokenProgram"]).as_deref() == Some(LEGACY_SPL_TOKEN_PROGRAM) {
        0.0
    } else {
        100.0
    }
}

fn nonnegative(value: Option<f64>) -> f64 {
    value
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0)
}

fn finite_or_zero(value: Option<f64>) -> f64 {
    value.filter(|value| value.is_finite()).unwrap_or(0.0)
}

fn abbreviated(mint: &str) -> String {
    mint.chars().take(7).collect::<String>().to_uppercase()
}

fn trusted_provider_icon(value: &Value) -> Option<String> {
    let raw = string_at(value, &["icon"])?;
    if raw.len() > 2_048 {
        return None;
    }
    let parsed = reqwest::Url::parse(&raw).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let private_name = host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal");
    let direct_ip = host.parse::<std::net::IpAddr>().is_ok();
    let secure_port = parsed.port().is_none() || parsed.port() == Some(443);
    (parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && secure_port
        && !private_name
        && !direct_ip)
        .then_some(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_token() -> Value {
        serde_json::json!({
            "id": "So11111111111111111111111111111111111111112",
            "symbol": "TEST",
            "usdPrice": 0.01,
            "liquidity": 200_000.0,
            "tokenProgram": LEGACY_SPL_TOKEN_PROGRAM,
            "firstPool": { "createdAt": (Utc::now() - chrono::Duration::minutes(10)).to_rfc3339() },
            "updatedAt": Utc::now().to_rfc3339(),
            "audit": {
                "mintAuthorityDisabled": true,
                "freezeAuthorityDisabled": true,
                "topHoldersPercentage": 15.0
            }
        })
    }

    fn discovery_token(mint: String, mature: bool, at_ms: i64) -> MarketToken {
        let mut token = parse_jupiter_token(&provider_token()).unwrap();
        token.mint = mint;
        token.age_seconds = if mature { 86_400 } else { 600 };
        token.liquidity_usd = MATURE_DISCOVERY_MIN_LIQUIDITY_USD;
        token.traders_5m = 25;
        token.sells_5m = 10;
        token.updated_at = DateTime::from_timestamp_millis(at_ms).unwrap().to_rfc3339();
        token
    }

    #[test]
    fn mature_discovery_retains_forty_candidates_during_a_launch_flood() {
        let at_ms = Utc::now().timestamp_millis();
        let mut candidates: Vec<_> = (0..160)
            .map(|index| discovery_token(format!("young-{index:03}"), false, at_ms))
            .collect();
        let mature: Vec<_> = (0..60).map(|index| {
            let mut token = discovery_token(format!("mature-{index:03}"), true, at_ms);
            // Mint fee resolution occurs after discovery selection.
            token.safety.transfer_tax_unknown = true;
            token.safety.transfer_tax_pct = 100.0;
            token
        }).collect();
        candidates.extend(mature);
        let mut original_rank = candidates.clone();
        rank_universe(&mut original_rank);
        let expected_mature: Vec<_> = original_rank.iter()
            .filter(|token| token.age_seconds >= 86_400).take(40)
            .map(|token| token.mint.as_str()).collect();

        let selected = select_discovery_universe(candidates, at_ms);
        assert_eq!(selected.len(), MAX_UNIVERSE_SIZE);
        assert_eq!(selected.iter().filter(|token| token.age_seconds < 86_400).count(), 80);
        let selected_mature: Vec<_> = selected.iter()
            .filter(|token| token.age_seconds >= 86_400)
            .map(|token| token.mint.as_str()).collect();
        assert_eq!(selected_mature, expected_mature);
        assert_eq!(selected.iter().take(80).map(|token| &token.mint).collect::<Vec<_>>(),
            original_rank.iter().take(80).map(|token| &token.mint).collect::<Vec<_>>());
    }

    #[test]
    fn mature_discovery_reuses_unfilled_slots_and_keeps_unique_stable_results() {
        let at_ms = Utc::now().timestamp_millis();
        let mut candidates: Vec<_> = (0..150)
            .map(|index| discovery_token(format!("young-{index:03}"), false, at_ms))
            .collect();
        candidates.extend((0..3)
            .map(|index| discovery_token(format!("mature-{index:03}"), true, at_ms)));
        let expected = select_discovery_universe(candidates.clone(), at_ms);
        candidates.extend(candidates.clone());
        candidates.reverse();
        let selected = select_discovery_universe(candidates, at_ms);
        assert_eq!(selected.len(), MAX_UNIVERSE_SIZE);
        assert_eq!(selected.iter().filter(|token| token.age_seconds >= 86_400).count(), 3);
        assert_eq!(selected.iter().map(|token| &token.mint).collect::<HashSet<_>>().len(), MAX_UNIVERSE_SIZE);
        assert_eq!(selected.iter().map(|token| &token.mint).collect::<Vec<_>>(),
            expected.iter().map(|token| &token.mint).collect::<Vec<_>>());
        let small = select_discovery_universe(selected.into_iter().take(12).collect(), at_ms);
        assert_eq!(small.len(), 12);
    }

    #[test]
    fn mature_discovery_does_not_reserve_slots_for_stale_or_unconfirmed_candidates() {
        let at_ms = Utc::now().timestamp_millis();
        let valid = discovery_token("mature".into(), true, at_ms);
        assert!(mature_discovery_candidate(&valid, at_ms));
        let invalid_changes: [fn(&mut MarketToken); 9] = [
            |token| token.age_seconds = 86_399,
            |token| token.liquidity_usd = MATURE_DISCOVERY_MIN_LIQUIDITY_USD - 1.0,
            |token| token.liquidity_usd = f64::NAN,
            |token| token.price_usd = 0.0,
            |token| token.safety.top_ten_holder_pct = 20.01,
            |token| token.traders_5m = 24,
            |token| token.sells_5m = 9,
            |token| token.safety.mint_authority_revoked = false,
            |token| token.safety.freeze_authority_revoked = false,
        ];
        for change in invalid_changes {
            let mut token = valid.clone();
            change(&mut token);
            assert!(!mature_discovery_candidate(&token, at_ms));
        }
        for timestamp in [at_ms - 75_001, at_ms + 1] {
            let mut token = valid.clone();
            token.updated_at = DateTime::from_timestamp_millis(timestamp).unwrap().to_rfc3339();
            assert!(!mature_discovery_candidate(&token, at_ms));
        }
        let mut invalid_time = valid;
        invalid_time.updated_at = "not-a-date".into();
        assert!(!mature_discovery_candidate(&invalid_time, at_ms));
    }

    #[test]
    fn new_launches_survive_a_full_established_trending_universe() {
        let template = parse_jupiter_token(&provider_token()).unwrap();
        let mut established = Vec::new();
        for index in 0..MAX_UNIVERSE_SIZE + 20 {
            let mut token = template.clone();
            token.mint = format!("established-{index}");
            token.age_seconds = 86_400;
            token.model_score = 0.99;
            established.push(token);
        }
        let mut launch = template.clone();
        launch.mint = "new-launch".into();
        launch.model_score = 0.01;
        // The scanner must retain a launch for its safety verdict even if the
        // token ultimately fails entry policy.
        launch.safety.mint_authority_revoked = false;
        established.push(launch);
        rank_universe(&mut established);
        established.truncate(MAX_UNIVERSE_SIZE);
        assert_eq!(established.len(), MAX_UNIVERSE_SIZE);
        assert!(established.iter().any(|token| token.mint == "new-launch"));
    }

    #[test]
    fn launch_priority_rejects_unknown_age_and_stale_or_invalid_data() {
        let template = parse_jupiter_token(&provider_token()).unwrap();
        let now = Utc::now().timestamp();
        assert!(fresh_launch_candidate(&template, now));
        for age in [0, NEW_LAUNCH_MAX_AGE_SECONDS + 1] {
            let mut token = template.clone();
            token.age_seconds = age;
            assert!(!fresh_launch_candidate(&token, now));
        }
        for updated_at in [
            String::new(),
            "not-a-date".into(),
            (Utc::now() - chrono::Duration::seconds(61)).to_rfc3339(),
            (Utc::now() + chrono::Duration::seconds(5)).to_rfc3339(),
        ] {
            let mut token = template.clone();
            token.updated_at = updated_at;
            assert!(!fresh_launch_candidate(&token, now));
        }
    }

    #[test]
    fn cache_ages_known_pools_without_inventing_an_unknown_pool_age() {
        let mut known = parse_jupiter_token(&provider_token()).unwrap();
        known.age_seconds = NEW_LAUNCH_MAX_AGE_SECONDS - 5;
        let original_update = known.updated_at.clone();
        let mut unknown = known.clone();
        unknown.age_seconds = 0;
        let mut tokens = [known, unknown];
        age_cached_tokens(&mut tokens, 10);
        assert_eq!(tokens[0].age_seconds, NEW_LAUNCH_MAX_AGE_SECONDS + 5);
        assert_eq!(tokens[0].updated_at, original_update);
        assert_eq!(tokens[1].age_seconds, 0);
        assert!(!fresh_launch_candidate(&tokens[0], Utc::now().timestamp()));
    }

    #[test]
    fn missing_timestamps_and_future_pools_remain_unconfirmed() {
        let mut value = provider_token();
        value.as_object_mut().unwrap().remove("updatedAt");
        value["firstPool"]["createdAt"] =
            serde_json::json!((Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
        let token = parse_jupiter_token(&value).unwrap();
        assert_eq!(token.updated_at, "");
        assert_eq!(token.age_seconds, 0);
        value["firstPool"]["createdAt"] = serde_json::json!(0);
        assert_eq!(pool_age(&value), None);
        value["firstPool"]["createdAt"] = serde_json::json!("invalid");
        assert_eq!(pool_age(&value), None);
        value.as_object_mut().unwrap().remove("firstPool");
        assert_eq!(pool_age(&value), None);
    }

    #[test]
    fn parser_fails_closed_on_unconfirmed_or_invalid_transfer_fees() {
        let mut value = provider_token();
        assert_eq!(
            parse_jupiter_token(&value).unwrap().safety.transfer_tax_pct,
            0.0
        );
        for program in [
            Value::Null,
            serde_json::json!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
            serde_json::json!("unknown"),
        ] {
            value["tokenProgram"] = program;
            let token = parse_jupiter_token(&value).unwrap();
            assert_eq!(token.safety.transfer_tax_pct, 100.0);
            assert!(!paper_eligible_at_25(&token));
        }
        for fee in [
            Value::Null,
            serde_json::json!(-1),
            serde_json::json!("NaN"),
            serde_json::json!(101),
        ] {
            value["audit"]["transferFeePct"] = fee;
            assert_eq!(
                parse_jupiter_token(&value).unwrap().safety.transfer_tax_pct,
                100.0
            );
        }
        value["audit"]["transferFeePct"] = serde_json::json!(0.5);
        assert_eq!(
            parse_jupiter_token(&value).unwrap().safety.transfer_tax_pct,
            0.5
        );
        value["audit"]["transferTaxPct"] = serde_json::json!(2.0);
        assert_eq!(
            parse_jupiter_token(&value).unwrap().safety.transfer_tax_pct,
            2.0
        );
    }

    #[test]
    fn malformed_safety_metadata_cannot_confirm_authority_revocation() {
        let mut value = provider_token();
        value["mintAuthority"] = serde_json::json!({ "unexpected": true });
        value["freezeAuthority"] = serde_json::json!(123);
        value["audit"]["topHoldersPercentage"] = serde_json::json!(101);
        let token = parse_jupiter_token(&value).unwrap();
        assert!(!token.safety.mint_authority_revoked);
        assert!(!token.safety.freeze_authority_revoked);
        assert_eq!(token.safety.top_ten_holder_pct, 100.0);
        assert!(!paper_eligible_at_25(&token));
    }

    #[test]
    fn missing_fee_evidence_is_distinct_from_an_explicit_restrictive_fee() {
        let mut value = provider_token();
        value.as_object_mut().unwrap().remove("tokenProgram");
        value["audit"].as_object_mut().unwrap().remove("transferFeePct");
        value["audit"].as_object_mut().unwrap().remove("transferTaxPct");
        let unknown = parse_jupiter_token(&value).unwrap();
        assert_eq!(unknown.safety.transfer_tax_pct, 100.0);
        assert!(unknown.safety.transfer_tax_unknown);

        value["audit"]["transferTaxPct"] = serde_json::json!(100.0);
        let explicit = parse_jupiter_token(&value).unwrap();
        assert_eq!(explicit.safety.transfer_tax_pct, 100.0);
        assert!(!explicit.safety.transfer_tax_unknown);

        value["audit"].as_object_mut().unwrap().remove("transferTaxPct");
        value["tokenProgram"] = serde_json::json!(LEGACY_SPL_TOKEN_PROGRAM);
        let legacy = parse_jupiter_token(&value).unwrap();
        assert_eq!(legacy.safety.transfer_tax_pct, 0.0);
        assert!(!legacy.safety.transfer_tax_unknown);
    }

    #[test]
    fn demo_snapshot_is_nonempty_and_explicitly_demo() {
        let snapshot = demo_snapshot(None);
        assert_eq!(snapshot.mode, "demo");
        assert!(snapshot.tokens.len() >= 10);
        assert!(snapshot
            .tokens
            .iter()
            .all(|token| token.source.contains("demo")));
    }

    #[test]
    fn opportunity_ranking_prefers_a_safe_liquid_candidate() {
        let tokens = demo_snapshot(None).tokens;
        let mut unsafe_token = tokens[8].clone();
        let mut safe_token = tokens[4].clone();
        unsafe_token.age_seconds = 600;
        safe_token.age_seconds = 600;
        let safe_mint = safe_token.mint.clone();
        let mut tokens = vec![unsafe_token, safe_token];
        rank_universe(&mut tokens);
        assert_eq!(
            tokens.first().map(|token| token.mint.as_str()),
            Some(safe_mint.as_str())
        );
        assert!(paper_eligible_at_25(tokens.first().unwrap()));
    }

    #[test]
    fn pump_watch_ranking_prioritises_a_bounded_new_pool_move() {
        let mut tokens = demo_snapshot(None).tokens;
        let mut pump = tokens.remove(0);
        let mut high_model = tokens.remove(0);
        for token in [&mut pump, &mut high_model] {
            token.age_seconds = 600;
            token.liquidity_usd = 200_000.0;
            token.volume_5m_usd = 120_000.0;
            token.buy_ratio = 0.70;
            token.traders_5m = 100;
            token.organic_buyers_5m = 20;
            token.safety.mint_authority_revoked = true;
            token.safety.freeze_authority_revoked = true;
            token.safety.top_ten_holder_pct = 20.0;
            token.safety.transfer_tax_pct = 0.0;
        }
        pump.change_5m_pct = 10.0;
        pump.model_score = 0.1;
        high_model.change_5m_pct = 2.0;
        high_model.model_score = 0.99;
        let pump_mint = pump.mint.clone();
        let mut ranked = vec![high_model, pump];
        rank_universe(&mut ranked);
        assert!(pump_watch_candidate(ranked.first().unwrap()));
        assert_eq!(ranked.first().unwrap().mint, pump_mint);
    }

    #[test]
    fn duplicate_mints_are_emitted_once() {
        let token = demo_snapshot(None).tokens.remove(0);
        let rows = deduplicate(vec![token.clone(), token]);
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn duplicate_mints_use_the_newest_row_without_reordering_the_universe() {
        let mut first = parse_jupiter_token(&provider_token()).unwrap();
        first.updated_at = "2026-01-01T12:00:00Z".into();
        first.price_usd = 1.0;
        let mut other = first.clone();
        other.mint = "other-mint".into();
        let mut freshest = first.clone();
        freshest.updated_at = "2026-01-01T12:00:02Z".into();
        freshest.price_usd = 2.0;
        freshest.volume_5m_usd = 1234.0;
        let mut older = first.clone();
        older.updated_at = "2026-01-01T12:00:01Z".into();
        older.price_usd = 3.0;

        let rows = deduplicate(vec![first.clone(), other.clone(), freshest, older]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].mint, first.mint);
        assert_eq!(rows[1].mint, other.mint);
        assert_eq!(rows[0].price_usd, 2.0);
        assert_eq!(rows[0].volume_5m_usd, 1234.0);
    }

    #[test]
    fn duplicate_mints_keep_valid_evidence_over_unknown_or_invalid_timestamps() {
        let mut valid = parse_jupiter_token(&provider_token()).unwrap();
        valid.updated_at = "2026-01-01T12:00:00Z".into();
        valid.price_usd = 1.0;
        for updated_at in [
            String::new(),
            "not-a-date".into(),
            "1969-12-31T23:59:59Z".into(),
            (Utc::now() + chrono::Duration::minutes(1)).to_rfc3339(),
        ] {
            let mut invalid = valid.clone();
            invalid.updated_at = updated_at;
            invalid.price_usd = 2.0;
            assert_eq!(deduplicate(vec![valid.clone(), invalid.clone()])[0].price_usd, 1.0);
            assert_eq!(deduplicate(vec![invalid, valid.clone()])[0].price_usd, 1.0);
        }
    }

    #[test]
    fn duplicate_mints_keep_first_row_for_equal_or_unusable_timestamps() {
        let mut first = parse_jupiter_token(&provider_token()).unwrap();
        first.updated_at = "2026-01-01T12:00:00Z".into();
        first.price_usd = 1.0;
        let mut equal = first.clone();
        equal.updated_at = "2026-01-01T13:00:00+01:00".into();
        equal.price_usd = 2.0;
        assert_eq!(deduplicate(vec![first.clone(), equal.clone()])[0].price_usd, 1.0);
        first.updated_at = String::new();
        equal.updated_at = "not-a-date".into();
        assert_eq!(deduplicate(vec![first, equal])[0].price_usd, 1.0);
    }

    #[test]
    fn token_icons_accept_public_https_provider_urls() {
        let official = serde_json::json!({ "icon": "https://static.jup.ag/token.png" });
        let official_external = serde_json::json!({
            "icon": "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/token/logo.png"
        });
        let insecure = serde_json::json!({ "icon": "http://static.jup.ag/token.png" });
        let local = serde_json::json!({ "icon": "https://localhost/token.png" });
        let direct_ip = serde_json::json!({ "icon": "https://127.0.0.1/token.png" });
        let credentialed = serde_json::json!({ "icon": "https://user:pass@example.com/token.png" });
        assert_eq!(
            trusted_provider_icon(&official).as_deref(),
            Some("https://static.jup.ag/token.png")
        );
        assert_eq!(
            trusted_provider_icon(&official_external).as_deref(),
            Some("https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/token/logo.png")
        );
        assert_eq!(trusted_provider_icon(&insecure), None);
        assert_eq!(trusted_provider_icon(&local), None);
        assert_eq!(trusted_provider_icon(&direct_ip), None);
        assert_eq!(trusted_provider_icon(&credentialed), None);
    }

    #[test]
    fn parser_uses_real_liquidity_and_complete_five_minute_volume() {
        use solana_sdk::signature::Signer;

        let keypair = solana_sdk::signature::Keypair::new();
        let value = serde_json::json!({
            "id": keypair.pubkey().to_string(),
            "symbol": "TEST",
            "name": "Test Token",
            "usdPrice": 0.01,
            "liquidity": null,
            "mcap": 1_000_000_000.0,
            "audit": {
                "mintAuthorityDisabled": true,
                "freezeAuthorityDisabled": true,
                "topHoldersPercentage": 12.0
            },
            "stats5m": {
                "priceChange": 5.0,
                "buyVolume": 125.0,
                "sellVolume": 75.0
            }
        });
        let token = parse_jupiter_token(&value).unwrap();
        assert_eq!(token.liquidity_usd, 0.0);
        assert_eq!(token.market_cap_usd, Some(1_000_000_000.0));
        assert_eq!(token.volume_5m_usd, 200.0);
        assert_eq!(token.change_5m_pct, 5.0);
        assert_eq!(token.buys_5m, 0);
        assert_eq!(token.traders_5m, 0);
        assert_eq!(token.risk_level, "High");
    }

    #[tokio::test]
    async fn single_token_lookup_rejects_an_invalid_mint_before_network_access() {
        let error = token_by_mint("not-a-solana-mint").await.unwrap_err();
        assert!(error.contains("valid Solana mint"));
    }

    #[tokio::test]
    #[ignore = "requires a live JUPITER_API_KEY"]
    async fn live_blended_universe_contains_paper_eligible_candidates() {
        let api_key = std::env::var("JUPITER_API_KEY").expect("JUPITER_API_KEY is required");
        let (tokens, warnings) = fetch_jupiter_universe(&api_key).await.unwrap();
        let eligible = tokens
            .iter()
            .filter(|token| paper_eligible_at_25(token))
            .count();
        println!(
            "live candidates={} paper_eligible_at_25={} warnings={}",
            tokens.len(),
            eligible,
            warnings.len()
        );
        assert!(tokens.len() > 30);
        assert!(eligible > 0);
    }
}
