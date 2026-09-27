//! Native-only observations for automatic BUY eligibility. Guarded discovery
//! requires a new five-minute history after restart. Paper signals require fresh
//! native evidence without the mature-pool history policy.
use crate::types::MarketToken;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, OnceLock},
};

pub const MIN_POOL_AGE_SECONDS: u64 = 86_400;
pub const MIN_LIQUIDITY_USD: f64 = 20_000.0;
const MAX_TOP_TEN_HOLDER_PCT: f64 = 20.0;
const MIN_TRADERS_5M: u64 = 25;
const MIN_SELLS_5M: u64 = 10;
const MAX_AGE_MS: i64 = 75_000;
const WINDOW_MS: i64 = 300_000;
const MIN_SAMPLES: usize = 6;
const MAX_MINTS: usize = 1024;
const MAX_SAMPLES: usize = 512;
const RETENTION_MS: i64 = 600_000;
static CACHE: OnceLock<Mutex<EntrySafetyCache>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntrySafetyStatus {
    pub ready: bool,
    pub blocker: Option<String>,
}

#[derive(Clone)]
struct Sample {
    provider_at: i64,
    received_at: i64,
    liquidity: f64,
}

struct History {
    token: MarketToken,
    samples: VecDeque<Sample>,
    // Preserved across invalid observations and history resets. Replaying or
    // rolling back provider time cannot manufacture a new observation window.
    provider_watermark: i64,
    last_event_at: i64,
    latest_received_at: i64,
    latest_blocker: Option<String>,
    embargo_until: i64,
    blocker: Option<String>,
}

#[derive(Default)]
pub(super) struct EntrySafetyCache {
    histories: HashMap<String, History>,
}

fn provider_time(token: &MarketToken) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(&token.updated_at)
        .map(|value| value.timestamp_millis())
        .map_err(|_| "Entry protection: provider timestamp is missing or invalid".into())
}

fn fresh(timestamp: i64, at: i64) -> bool {
    timestamp > 0 && timestamp <= at && at.saturating_sub(timestamp) <= MAX_AGE_MS
}

pub(super) fn validate_source(token: &MarketToken, at: i64) -> Result<(), String> {
    if token.source != "Jupiter Tokens V2" {
        return Err("Entry protection: live provider evidence is required".into());
    }
    if !fresh(provider_time(token)?, at) {
        return Err("Entry protection: provider observation is stale or future-dated".into());
    }
    Ok(())
}

/// Guarded discovery floors apply regardless of the elevated-risk session flag.
pub(super) fn validate_token(token: &MarketToken, at: i64) -> Result<(), String> {
    validate_source(token, at)?;
    if token.age_seconds < MIN_POOL_AGE_SECONDS {
        return Err("Entry protection: confirmed pool age must be at least 24 hours".into());
    }
    if !token.liquidity_usd.is_finite() || token.liquidity_usd < MIN_LIQUIDITY_USD {
        return Err("Entry protection: liquidity must be at least $20,000".into());
    }
    if !token.safety.top_ten_holder_pct.is_finite()
        || !(0.0..=MAX_TOP_TEN_HOLDER_PCT).contains(&token.safety.top_ten_holder_pct)
    {
        return Err("Entry protection: top ten holder concentration must be known and at most 20%".into());
    }
    if token.traders_5m < MIN_TRADERS_5M || token.sells_5m < MIN_SELLS_5M {
        return Err("Entry protection: at least 25 traders and 10 sells in five minutes are required".into());
    }
    Ok(())
}

impl History {
    fn reset(&mut self, blocker: impl Into<String>) {
        self.samples.clear();
        self.blocker = Some(blocker.into());
    }

    fn observe(&mut self, token: &MarketToken, at: i64) {
        self.token = token.clone();
        if at < self.last_event_at {
            self.latest_blocker = Some("Entry protection: local clock moved backwards; waiting for a fresh native observation".into());
            self.reset("Entry protection: local clock moved backwards; rebuilding observation history");
            return;
        }
        self.last_event_at = at;
        let timestamp = match provider_time(token) {
            Ok(value) if fresh(value, at) => value,
            _ => {
                self.latest_blocker = Some("Entry protection: provider observation is stale, missing or future-dated".into());
                self.reset("Entry protection: provider observation is stale, missing or future-dated");
                return;
            }
        };
        if timestamp < self.provider_watermark {
            self.latest_blocker = Some("Entry protection: provider time moved backwards; waiting for a current native observation".into());
            self.reset("Entry protection: provider time moved backwards; waiting for newer observations");
            return;
        }
        // This independent receipt records genuine native lookups even when a
        // young pool cannot satisfy the guarded discovery history policy.
        self.latest_received_at = at;
        self.latest_blocker = validate_source(token, at).err();

        // Inspect even duplicate-time observations for a loss of liquidity.
        // They may invalidate evidence but can never add history or refresh its
        // receipt timestamp. Invalid samples also cannot erase the embargo.
        let peak = self.samples.iter().map(|sample| sample.liquidity).fold(0.0, f64::max);
        if token.liquidity_usd.is_finite()
            && (token.liquidity_usd < MIN_LIQUIDITY_USD || token.liquidity_usd < peak * 0.9)
        {
            self.embargo_until = self.embargo_until.max(at.saturating_add(WINDOW_MS));
            self.reset("Entry protection: liquidity fell below the floor or dropped more than 10%; rebuilding five-minute history");
        }
        if let Err(error) = validate_token(token, at) {
            self.provider_watermark = self.provider_watermark.max(timestamp);
            self.reset(error);
            return;
        }
        if timestamp == self.provider_watermark {
            // A duplicate cannot warm history, but its higher liquidity remains
            // observed peak evidence for subsequent drawdown checks. Preserve
            // both timestamps and the count; never rebuild an invalid history.
            if let Some(last) = self.samples.back_mut() {
                if last.provider_at == timestamp {
                    last.liquidity = last.liquidity.max(token.liquidity_usd);
                }
            }
            return;
        }
        self.provider_watermark = timestamp;
        if self.samples.back().is_some_and(|last| {
            timestamp.saturating_sub(last.provider_at) > MAX_AGE_MS
                || at.saturating_sub(last.received_at) > MAX_AGE_MS
                || at <= last.received_at
        }) {
            self.reset("Entry protection: observation gap exceeded 75 seconds; rebuilding five-minute history");
        }
        self.samples.push_back(Sample {
            provider_at: timestamp,
            received_at: at,
            liquidity: token.liquidity_usd,
        });
        // Keep one observation at/before the boundary in both time domains.
        // This provides an actual measured span, not an assumed polling span.
        while self.samples.len() > 1 && self.samples.get(1).is_some_and(|second| {
            timestamp.saturating_sub(second.provider_at) >= WINDOW_MS
                && at.saturating_sub(second.received_at) >= WINDOW_MS
        }) {
            self.samples.pop_front();
        }
        if self.samples.len() > MAX_SAMPLES {
            self.reset("Entry protection: observation history exceeded its limit; rebuilding five-minute history");
            return;
        }
        self.blocker = None;
    }

    fn validate_latest(&self, at: i64) -> Result<(), String> {
        validate_source(&self.token, at)?;
        if at < self.last_event_at {
            return Err("Entry protection: local clock moved backwards".into());
        }
        if let Some(blocker) = &self.latest_blocker {
            return Err(blocker.clone());
        }
        if !fresh(self.latest_received_at, at) {
            return Err("Entry protection: native token observation is stale; waiting for a fresh lookup".into());
        }
        Ok(())
    }

    fn validate(&self, at: i64) -> Result<(), String> {
        validate_token(&self.token, at)?;
        if at < self.last_event_at {
            return Err("Entry protection: local clock moved backwards".into());
        }
        if let Some(blocker) = &self.blocker {
            return Err(blocker.clone());
        }
        if at < self.embargo_until {
            return Err("Entry protection: five-minute observation pause after a liquidity drop".into());
        }
        let Some(last) = self.samples.back() else {
            return Err("Entry protection: collecting five minutes of native liquidity observations".into());
        };
        if !fresh(last.provider_at, at) || !fresh(last.received_at, at) {
            return Err("Entry protection: liquidity history is stale; waiting for fresh observations".into());
        }
        let first = self.samples.front().expect("nonempty observation history");
        if self.samples.len() < MIN_SAMPLES
            || last.provider_at.saturating_sub(first.provider_at) < WINDOW_MS
            || last.received_at.saturating_sub(first.received_at) < WINDOW_MS
        {
            return Err("Entry protection: collecting five minutes of native liquidity observations (at least six distinct samples)".into());
        }
        Ok(())
    }
}

impl EntrySafetyCache {
    fn prune(&mut self, at: i64) {
        self.histories.retain(|_, history| {
            at.saturating_sub(history.last_event_at) <= RETENTION_MS
        });
    }

    pub(super) fn observe(&mut self, tokens: &[MarketToken], at: i64) {
        self.prune(at);
        for token in tokens {
            if !self.histories.contains_key(&token.mint) && self.histories.len() >= MAX_MINTS {
                if let Some(oldest) = self.histories.iter()
                    .min_by_key(|(_, history)| history.last_event_at)
                    .map(|(mint, _)| mint.clone())
                {
                    self.histories.remove(&oldest);
                }
            }
            let history = self.histories.entry(token.mint.clone()).or_insert_with(|| History {
                token: token.clone(),
                samples: VecDeque::new(),
                provider_watermark: 0,
                last_event_at: at,
                latest_received_at: 0,
                latest_blocker: None,
                embargo_until: 0,
                blocker: None,
            });
            history.observe(token, at);
        }
    }

    pub(super) fn validate(
        &self,
        mint: &str,
        at: i64,
        check_source: impl Fn(&MarketToken) -> Result<(), String>,
    ) -> Result<(), String> {
        let history = self.histories.get(mint)
            .ok_or("Entry protection: collecting five minutes of native liquidity observations")?;
        check_source(&history.token)?;
        history.validate(at)
    }

    pub(super) fn validate_latest(
        &self,
        mint: &str,
        at: i64,
        check_source: impl Fn(&MarketToken) -> Result<(), String>,
    ) -> Result<(), String> {
        let history = self.histories.get(mint)
            .ok_or("Entry protection: waiting for a fresh native token observation")?;
        check_source(&history.token)?;
        history.validate_latest(at)
    }

    fn statuses(
        &mut self,
        at: i64,
        check_source: impl Fn(&MarketToken) -> Result<(), String>,
    ) -> HashMap<String, EntrySafetyStatus> {
        self.prune(at);
        self.histories.iter().map(|(mint, history)| {
            let result = check_source(&history.token).and_then(|_| history.validate(at));
            (mint.clone(), EntrySafetyStatus { ready: result.is_ok(), blocker: result.err() })
        }).collect()
    }

    fn latest_statuses(
        &mut self,
        at: i64,
        check_source: impl Fn(&MarketToken) -> Result<(), String>,
    ) -> HashMap<String, EntrySafetyStatus> {
        self.prune(at);
        self.histories.iter().map(|(mint, history)| {
            let result = check_source(&history.token).and_then(|_| history.validate_latest(at));
            (mint.clone(), EntrySafetyStatus { ready: result.is_ok(), blocker: result.err() })
        }).collect()
    }
}

fn cache() -> &'static Mutex<EntrySafetyCache> {
    CACHE.get_or_init(|| Mutex::new(EntrySafetyCache::default()))
}

pub(super) fn record(tokens: &[MarketToken], at: i64) -> Result<(), String> {
    cache().lock().map_err(|_| "Entry protection: observation cache unavailable")?
        .observe(tokens, at);
    Ok(())
}

pub(super) fn validate_cached(
    mint: &str,
    at: i64,
    check_source: impl Fn(&MarketToken) -> Result<(), String>,
) -> Result<(), String> {
    cache().lock().map_err(|_| "Entry protection: observation cache unavailable")?
        .validate(mint, at, check_source)
}

pub(super) fn statuses(
    at: i64,
    check_source: impl Fn(&MarketToken) -> Result<(), String>,
) -> HashMap<String, EntrySafetyStatus> {
    // Unavailable diagnostics remain an empty map; a BUY fails closed on lock
    // failure. Wallet status and SELL reconciliation must remain accessible.
    cache().lock().map(|mut cache| cache.statuses(at, check_source)).unwrap_or_default()
}

pub(super) fn validate_latest_cached(
    mint: &str,
    at: i64,
    check_source: impl Fn(&MarketToken) -> Result<(), String>,
) -> Result<(), String> {
    cache().lock().map_err(|_| "Entry protection: observation cache unavailable")?
        .validate_latest(mint, at, check_source)
}

pub(super) fn latest_statuses(
    at: i64,
    check_source: impl Fn(&MarketToken) -> Result<(), String>,
) -> HashMap<String, EntrySafetyStatus> {
    cache().lock().map(|mut cache| cache.latest_statuses(at, check_source)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const START: i64 = 1_000_000;

    fn token(timestamp: i64, liquidity: f64) -> MarketToken {
        serde_json::from_value(json!({
            "mint":"test-mint", "symbol":"TEST", "name":"Test", "iconUrl":null,
            "ageSeconds":86_400, "priceUsd":1, "change5mPct":5,
            "liquidityUsd":liquidity, "volume5mUsd":5000, "buyRatio":0.6,
            "buys5m":30, "sells5m":10, "traders5m":25, "organicBuyers5m":20,
            "organicScore":80, "riskLevel":"Low", "modelScore":80,
            "safety":{"mintAuthorityRevoked":true,"freezeAuthorityRevoked":true,
                "topTenHolderPct":20,"liquidityLocked":null,"priceImpactPct":0.1,
                "transferTaxPct":0,"transferTaxUnknown":false,"verified":true},
            "source":"Jupiter Tokens V2",
            "updatedAt":chrono::DateTime::from_timestamp_millis(timestamp).unwrap().to_rfc3339()
        })).unwrap()
    }

    fn warm(cache: &mut EntrySafetyCache) {
        for step in 0..=5 {
            let at = START + step * 60_000;
            cache.observe(&[token(at, 300_000.0)], at);
        }
    }

    fn ready(cache: &EntrySafetyCache, at: i64) -> bool {
        cache.validate("test-mint", at, |token| validate_token(token, at)).is_ok()
    }

    #[test]
    fn strict_source_checks_reject_unknown_young_low_liquidity_concentration_and_thin_flow() {
        let good = token(START, MIN_LIQUIDITY_USD);
        assert!(validate_token(&good, START).is_ok());
        for age in [0, MIN_POOL_AGE_SECONDS - 1] {
            let mut bad = good.clone(); bad.age_seconds = age;
            assert!(validate_token(&bad, START).is_err());
        }
        for liquidity in [0.0, MIN_LIQUIDITY_USD - 1.0, f64::NAN, f64::INFINITY] {
            let mut bad = good.clone(); bad.liquidity_usd = liquidity;
            assert!(validate_token(&bad, START).is_err());
        }
        for concentration in [-1.0, 20.01, 100.0, f64::NAN] {
            let mut bad = good.clone(); bad.safety.top_ten_holder_pct = concentration;
            assert!(validate_token(&bad, START).is_err());
        }
        let mut bad = good.clone(); bad.traders_5m = 24;
        assert!(validate_token(&bad, START).is_err());
        bad = good.clone(); bad.sells_5m = 9;
        assert!(validate_token(&bad, START).is_err());
        bad = good.clone(); bad.source = "Deterministic demo".into();
        assert!(validate_token(&bad, START).is_err());
        bad = good; bad.updated_at.clear();
        assert!(validate_token(&bad, START).is_err());
    }

    #[test]
    fn stable_distinct_native_history_needs_both_five_minute_spans_and_freshness() {
        let mut cache = EntrySafetyCache::default();
        assert!(!ready(&cache, START));
        cache.observe(&[token(START, 300_000.0)], START);
        assert!(!ready(&cache, START));
        warm(&mut cache);
        assert!(ready(&cache, START + WINDOW_MS));
        assert!(ready(&cache, START + WINDOW_MS + MAX_AGE_MS));
        assert!(!ready(&cache, START + WINDOW_MS + MAX_AGE_MS + 1));
        let mut compressed = EntrySafetyCache::default();
        for step in 0..=5 {
            compressed.observe(&[token(START + step, 300_000.0)], START + step * 60_000);
        }
        assert!(!ready(&compressed, START + WINDOW_MS));
        assert!(!ready(&EntrySafetyCache::default(), START + WINDOW_MS));
    }

    #[test]
    fn twenty_thousand_liquidity_can_warm_but_below_floor_cannot() {
        let mut allowed = EntrySafetyCache::default();
        let mut rejected = EntrySafetyCache::default();
        for step in 0..=5 {
            let at = START + step * 60_000;
            allowed.observe(&[token(at, 20_000.0)], at);
            rejected.observe(&[token(at, 19_999.99)], at);
        }
        assert!(ready(&allowed, START + WINDOW_MS));
        assert!(!ready(&rejected, START + WINDOW_MS));
        let blocker = rejected.validate("test-mint", START + WINDOW_MS, |_| Ok(())).unwrap_err();
        assert_eq!(blocker, "Entry protection: liquidity must be at least $20,000");
    }

    #[test]
    fn repeated_provider_timestamps_do_not_refresh_receipts_or_create_history() {
        let mut cache = EntrySafetyCache::default();
        for step in 0..=5 {
            cache.observe(&[token(START, 300_000.0)], START + step * 10_000);
        }
        assert_eq!(cache.histories["test-mint"].samples.len(), 1);
        assert_eq!(cache.histories["test-mint"].samples[0].received_at, START);
        assert!(!ready(&cache, START + 50_000));
        let mut cache = EntrySafetyCache::default();
        warm(&mut cache);
        assert!(ready(&cache, START + WINDOW_MS));
        cache.observe(&[token(START + WINDOW_MS, 300_000.0)], START + WINDOW_MS + MAX_AGE_MS + 1);
        assert!(!ready(&cache, START + WINDOW_MS + MAX_AGE_MS + 1));
    }

    #[test]
    fn duplicate_liquidity_increase_preserves_peak_without_warming_history() {
        let mut cache = EntrySafetyCache::default();
        warm(&mut cache);
        let at = START + WINDOW_MS;
        let count = cache.histories["test-mint"].samples.len();
        let previous = cache.histories["test-mint"].samples.back().unwrap().clone();
        cache.observe(&[token(at, 600_000.0)], at + 1);
        let history = &cache.histories["test-mint"];
        let last = history.samples.back().unwrap();
        assert_eq!(history.samples.len(), count);
        assert_eq!(last.provider_at, previous.provider_at);
        assert_eq!(last.received_at, previous.received_at);
        assert_eq!(last.liquidity, 600_000.0);
        assert!(ready(&cache, at + 1));

        // This is a 33% loss from the observed duplicate-time peak, although it
        // remains above both the original $300k baseline and the $20k floor.
        cache.observe(&[token(at + 60_000, 400_000.0)], at + 60_000);
        assert!(!ready(&cache, at + 60_000));
        assert_eq!(cache.histories["test-mint"].samples.len(), 1);
        assert_eq!(cache.histories["test-mint"].embargo_until, at + 60_000 + WINDOW_MS);
    }

    #[test]
    fn rollback_stale_future_and_long_gaps_destroy_readiness_without_replay() {
        for (provider, received) in [
            (START + WINDOW_MS - 1, START + WINDOW_MS + 1),
            (START + WINDOW_MS + 2, START + WINDOW_MS + 1),
            (START + WINDOW_MS, START + WINDOW_MS + MAX_AGE_MS + 1),
            (START + WINDOW_MS + 1, START + WINDOW_MS - 1),
            (START + WINDOW_MS + MAX_AGE_MS + 1, START + WINDOW_MS + MAX_AGE_MS + 1),
        ] {
            let mut cache = EntrySafetyCache::default(); warm(&mut cache);
            cache.observe(&[token(provider, 300_000.0)], received);
            assert!(!ready(&cache, received));
            cache.observe(&[token(START + WINDOW_MS, 300_000.0)], received.max(START + WINDOW_MS));
            assert!(!ready(&cache, received.max(START + WINDOW_MS)));
        }
    }

    #[test]
    fn drawdown_from_prior_peak_blocks_even_a_duplicate_and_requires_new_full_window() {
        let mut cache = EntrySafetyCache::default(); warm(&mut cache);
        let drop_at = START + WINDOW_MS + 1;
        cache.observe(&[token(START + WINDOW_MS, 269_999.0)], drop_at);
        assert!(!ready(&cache, drop_at));
        for step in 1..=4 {
            let at = drop_at + step * 60_000;
            cache.observe(&[token(at, 300_000.0)], at);
            assert!(!ready(&cache, at));
        }
        for step in 5..=6 {
            let at = drop_at + step * 60_000;
            cache.observe(&[token(at, 300_000.0)], at);
        }
        assert!(ready(&cache, drop_at + 360_000));
    }

    #[test]
    fn exactly_ten_percent_is_allowed_but_floor_breach_resets_history() {
        let mut cache = EntrySafetyCache::default(); warm(&mut cache);
        let at = START + WINDOW_MS + 60_000;
        cache.observe(&[token(at, 270_000.0)], at);
        assert!(ready(&cache, at));
        cache.observe(&[token(at + 1, MIN_LIQUIDITY_USD - 1.0)], at + 1);
        assert!(!ready(&cache, at + 1));
        cache.observe(&[token(at + 2, 300_000.0)], at + 2);
        assert!(!ready(&cache, at + 2));
    }

    #[test]
    fn diagnostics_include_source_checks_and_cache_is_bounded_and_pruned() {
        let mut cache = EntrySafetyCache::default(); warm(&mut cache);
        let at = START + WINDOW_MS;
        assert!(cache.statuses(at, |_| Ok(()))["test-mint"].ready);
        let status = cache.statuses(at, |_| Err("Session disallows token risk".into()));
        assert!(!status["test-mint"].ready);
        assert_eq!(status["test-mint"].blocker.as_deref(), Some("Session disallows token risk"));
        for index in 0..MAX_MINTS + 10 {
            let mut next = token(at, 300_000.0); next.mint = format!("mint-{index}");
            cache.observe(&[next], at);
        }
        assert_eq!(cache.histories.len(), MAX_MINTS);
        assert!(cache.statuses(at + RETENTION_MS + 1, |_| Ok(())).is_empty());
    }

    #[test]
    fn latest_native_evidence_is_ready_for_young_pool_without_guarded_history() {
        let mut cache = EntrySafetyCache::default();
        let mut young = token(START, 12_542.0);
        young.age_seconds = 120;
        young.traders_5m = 8;
        young.sells_5m = 1;
        young.safety.top_ten_holder_pct = 30.0;
        assert!(cache.validate_latest("test-mint", START, |_| Ok(())).is_err());
        cache.observe(&[young], START);
        assert!(cache.validate_latest("test-mint", START, |_| Ok(())).is_ok());
        assert!(!ready(&cache, START));
        assert!(cache.latest_statuses(START, |_| Ok(()))["test-mint"].ready);
        assert!(!cache.statuses(START, |_| Ok(()))["test-mint"].ready);
        let statuses = cache.latest_statuses(START, |_| Err("Captured paper criteria failed".into()));
        assert!(!statuses["test-mint"].ready);
        assert_eq!(statuses["test-mint"].blocker.as_deref(), Some("Captured paper criteria failed"));
    }

    #[test]
    fn latest_native_evidence_requires_provider_and_receipt_freshness_at_final_check() {
        let mut cache = EntrySafetyCache::default();
        cache.observe(&[token(START, 12_542.0)], START);
        assert!(cache.validate_latest("test-mint", START + MAX_AGE_MS, |_| Ok(())).is_ok());
        assert!(cache.validate_latest("test-mint", START + MAX_AGE_MS + 1, |_| Ok(())).is_err());
        // A fresh-looking provider time alone cannot replace a native receipt.
        cache.histories.get_mut("test-mint").unwrap().token.updated_at =
            chrono::DateTime::from_timestamp_millis(START + MAX_AGE_MS + 1).unwrap().to_rfc3339();
        assert!(cache.validate_latest("test-mint", START + MAX_AGE_MS + 1, |_| Ok(())).is_err());
    }

    #[test]
    fn latest_native_evidence_rejects_source_clock_rollback_stale_and_future_observations() {
        for (provider, received) in [
            (START - 1, START + 1),
            (START + 2, START + 1),
            (START, START + MAX_AGE_MS + 1),
            (START - 1, START - 1),
        ] {
            let mut cache = EntrySafetyCache::default();
            cache.observe(&[token(START, 12_542.0)], START);
            cache.observe(&[token(provider, 12_542.0)], received);
            assert!(cache.validate_latest("test-mint", received.max(START), |_| Ok(())).is_err());
        }
        let mut cache = EntrySafetyCache::default();
        let mut bad_source = token(START, 12_542.0);
        bad_source.source = "Deterministic demo".into();
        cache.observe(&[bad_source], START);
        assert!(cache.validate_latest("test-mint", START, |_| Ok(())).is_err());
        cache.observe(&[token(START + 1, 12_542.0)], START + 1);
        assert!(cache.validate_latest("test-mint", START + 1, |_| Ok(())).is_ok());
        assert!(cache.validate_latest("test-mint", START, |_| Ok(())).is_err());
    }
}
