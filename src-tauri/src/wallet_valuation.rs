//! Optional display valuations. Never used to authorize or size a live order.
use reqwest::{header::HeaderMap, Client, StatusCode};
use serde_json::Value;
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

const PRICE_INTERVAL: Duration = Duration::from_secs(30);
const PORTFOLIO_INTERVAL: Duration = Duration::from_secs(120);
static CACHE: OnceLock<tokio::sync::Mutex<Cache>> = OnceLock::new();

#[derive(Clone, Copy)]
enum Endpoint {
    Price,
    Portfolio,
}

#[derive(Default)]
struct Cache {
    owner: String,
    price: Option<(f64, Instant)>,
    total: Option<(f64, Instant)>,
    price_due: Option<Instant>,
    portfolio_due: Option<Instant>,
    limited_until: Option<Instant>,
    failures: u32,
    warning: Option<String>,
}

pub struct Valuation {
    pub price: Option<f64>,
    pub total: Option<f64>,
    pub warning: Option<String>,
}

impl Cache {
    fn select_owner(&mut self, owner: &str) {
        if self.owner != owner {
            self.owner = owner.into();
            self.total = None;
            // Keep request deadlines and the cooldown across wallet changes.
        }
    }

    fn begin(&mut self, endpoint: Endpoint, now: Instant) -> bool {
        if self.limited_until.is_some_and(|until| until > now) {
            return false;
        }
        let (due, interval) = match endpoint {
            Endpoint::Price => (&mut self.price_due, PRICE_INTERVAL),
            Endpoint::Portfolio => (&mut self.portfolio_due, PORTFOLIO_INTERVAL),
        };
        if due.is_some_and(|until| until > now) {
            return false;
        }
        // Reserve before awaiting, including failed requests.
        *due = Some(now + interval);
        true
    }

    fn rate_limited(&mut self, headers: &HeaderMap, now: Instant, unix_seconds: u64) {
        self.failures = self.failures.saturating_add(1);
        self.limited_until = Some(now + backoff(headers, unix_seconds, self.failures));
        self.warning = Some("Jupiter wallet valuation is rate limited. Optional valuation requests are cooling down; the native SOL balance is still refreshed.".into());
    }

    fn result(&self, now: Instant) -> Valuation {
        Valuation {
            price: self
                .price
                .filter(|(_, until)| *until > now)
                .map(|(value, _)| value),
            total: self
                .total
                .filter(|(_, until)| *until > now)
                .map(|(value, _)| value),
            warning: self.warning.clone(),
        }
    }
}

fn backoff(headers: &HeaderMap, unix_seconds: u64, failures: u32) -> Duration {
    let fallback = (60u64 * (1u64 << failures.saturating_sub(1).min(3))).min(300);
    let retry = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.parse::<u64>().ok().or_else(|| {
                chrono::DateTime::parse_from_rfc2822(v)
                    .ok()
                    .and_then(|date| u64::try_from(date.timestamp()).ok())
                    .map(|date| date.saturating_sub(unix_seconds))
            })
        })
        .unwrap_or(0);
    let reset = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
        .saturating_sub(unix_seconds);
    Duration::from_secs(fallback.max(retry).max(reset).min(86_400))
}

pub async fn fetch(client: &Client, api_key: &str, owner: &str) -> Valuation {
    // Single flight: polling and manual refresh cannot duplicate provider calls.
    let mut cache = CACHE
        .get_or_init(|| tokio::sync::Mutex::new(Cache::default()))
        .lock()
        .await;
    cache.select_owner(owner);
    for endpoint in [Endpoint::Price, Endpoint::Portfolio] {
        if !cache.begin(endpoint, Instant::now()) {
            continue;
        }
        let url = match endpoint {
            Endpoint::Price => format!(
                "https://api.jup.ag/price/v3?ids={}",
                crate::wallet::SOL_MINT
            ),
            Endpoint::Portfolio => format!("https://api.jup.ag/portfolio/v1/positions/{owner}"),
        };
        match crate::jupiter_requests::send(client.get(url).header("x-api-key", api_key), crate::jupiter_requests::Priority::Background).await {
            Ok(response) if response.status() == StatusCode::TOO_MANY_REQUESTS => {
                let unix_seconds = chrono::Utc::now().timestamp().max(0) as u64;
                cache.rate_limited(response.headers(), Instant::now(), unix_seconds);
                break; // Price and portfolio share the same provider allowance.
            }
            Ok(response) if response.status().is_success() => {
                let parsed = response.json::<Value>().await.ok().and_then(|body| match endpoint {
                    Endpoint::Price => body.pointer(&format!("/{}/usdPrice", crate::wallet::SOL_MINT))
                        .and_then(Value::as_f64).filter(|v| v.is_finite() && *v > 0.0),
                    Endpoint::Portfolio => body.get("elements").and_then(Value::as_array)
                        .map(|_| crate::wallet::portfolio_total(&body)).filter(|v| v.is_finite() && *v >= 0.0),
                });
                if let Some(value) = parsed {
                    match endpoint {
                        Endpoint::Price => cache.price = Some((value, Instant::now() + PRICE_INTERVAL)),
                        Endpoint::Portfolio => {
                            cache.total = Some((value, Instant::now() + PORTFOLIO_INTERVAL));
                            cache.failures = 0;
                            cache.warning = None;
                        }
                    }
                } else {
                    cache.warning = Some("Jupiter wallet valuation returned incomplete data; unavailable estimates are omitted.".into());
                }
            }
            Ok(response) => cache.warning = Some(format!("Jupiter wallet valuation HTTP {}; background refresh will retry later.", response.status())),
            Err(_) => cache.warning = Some("Jupiter wallet valuation is temporarily unavailable; background refresh will retry later.".into()),
        }
    }
    cache.result(Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_refreshes_share_endpoint_deadlines_including_failures() {
        let now = Instant::now();
        let mut cache = Cache::default();
        assert!(cache.begin(Endpoint::Portfolio, now));
        assert!(!cache.begin(Endpoint::Portfolio, now + Duration::from_secs(30)));
        assert!(!cache.begin(Endpoint::Portfolio, now + Duration::from_secs(119)));
        assert!(cache.begin(Endpoint::Portfolio, now + Duration::from_secs(120)));
        assert!(cache.begin(Endpoint::Price, now));
        assert!(!cache.begin(Endpoint::Price, now));
        assert!(cache.begin(Endpoint::Price, now + PRICE_INTERVAL));
    }

    #[test]
    fn either_endpoint_429_pauses_both_and_wallet_changes_do_not_bypass_it() {
        let now = Instant::now();
        let mut cache = Cache::default();
        cache.select_owner("first");
        cache.total = Some((999.0, now + PORTFOLIO_INTERVAL));
        cache.rate_limited(&HeaderMap::new(), now, 1000);
        cache.select_owner("second");
        assert!(cache.result(now).total.is_none());
        assert!(!cache.begin(Endpoint::Price, now + Duration::from_secs(59)));
        assert!(!cache.begin(Endpoint::Portfolio, now + Duration::from_secs(59)));
        assert!(cache.begin(Endpoint::Price, now + Duration::from_secs(60)));
    }

    #[test]
    fn expired_values_are_not_returned_as_current_balances() {
        let now = Instant::now();
        let cache = Cache {
            price: Some((100.0, now + PRICE_INTERVAL)),
            total: Some((500.0, now + PORTFOLIO_INTERVAL)),
            ..Cache::default()
        };
        assert_eq!(cache.result(now).price, Some(100.0));
        assert!(cache.result(now + PRICE_INTERVAL).price.is_none());
        assert!(cache.result(now + PORTFOLIO_INTERVAL).total.is_none());
    }

    #[test]
    fn provider_headers_and_exponential_fallback_are_respected() {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", "180".parse().unwrap());
        headers.insert("x-ratelimit-reset", "1250".parse().unwrap());
        assert_eq!(backoff(&headers, 1000, 1).as_secs(), 250);
        headers.insert("retry-after", "invalid".parse().unwrap());
        headers.insert("x-ratelimit-reset", "999".parse().unwrap());
        assert_eq!(backoff(&headers, 1000, 1).as_secs(), 60);
        assert_eq!(backoff(&headers, 1000, 2).as_secs(), 120);
        assert_eq!(backoff(&headers, 1000, u32::MAX).as_secs(), 300);
        headers.insert(
            "retry-after",
            "Thu, 01 Jan 1970 00:20:00 GMT".parse().unwrap(),
        );
        assert_eq!(backoff(&headers, 1000, 1).as_secs(), 200);
    }
}
