//! One process-wide budget for Jupiter's shared GET bucket. Never retries a swap submission.
use reqwest::{header::HeaderMap, RequestBuilder, Response};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    Background,
    Entry,
    HeldMark,
    Exit,
}

impl Priority {
    fn ceiling(self) -> usize {
        match self {
            Self::Background => 24,
            Self::Entry => 36,
            Self::HeldMark => 42,
            Self::Exit => 50,
        }
    }
}

static STATE: OnceLock<Mutex<Budget>> = OnceLock::new();
static EXITS: AtomicUsize = AtomicUsize::new(0);
pub struct ExitGuard;
pub fn prioritize_exit() -> ExitGuard {
    EXITS.fetch_add(1, Ordering::SeqCst);
    ExitGuard
}
impl Drop for ExitGuard {
    fn drop(&mut self) {
        EXITS.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Budget {
    sent: VecDeque<Instant>,
    next_send: Option<Instant>,
    blocked_until: Option<Instant>,
    background_until: Option<Instant>,
    failures: u32,
}

impl Budget {
    fn reserve(
        &mut self,
        now: Instant,
        priority: Priority,
        exit_active: bool,
    ) -> Result<(), Duration> {
        while self
            .sent
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
        {
            self.sent.pop_front();
        }
        if let Some(until) = self.blocked_until.filter(|t| *t > now) {
            return Err(until - now);
        }
        if exit_active && priority != Priority::Exit {
            return Err(Duration::from_secs(2));
        }
        if priority != Priority::Exit && priority != Priority::HeldMark {
            if let Some(until) = self.background_until.filter(|t| *t > now) {
                return Err(until - now);
            }
        }
        if self.sent.len() >= priority.ceiling() {
            // The threshold can require more than one request to age out.
            let at = self.sent.len() - priority.ceiling();
            return Err(self.sent[at] + Duration::from_secs(60) - now);
        }
        if let Some(until) = self.next_send.filter(|t| *t > now) {
            return Err(until - now);
        }
        self.sent.push_back(now);
        self.next_send = Some(now + Duration::from_millis(1050));
        Ok(())
    }

    fn observe(&mut self, status: u16, headers: &HeaderMap, now: Instant, unix: u64) {
        let value = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
        };
        let reset = value("x-ratelimit-reset").map(|n| n.saturating_sub(unix).max(1));
        if status == 429 {
            self.failures = self.failures.saturating_add(1);
            let fallback = (5u64 * (1 << self.failures.saturating_sub(1).min(4))).min(60);
            let retry = headers
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| {
                    v.parse::<u64>().ok().or_else(|| {
                        chrono::DateTime::parse_from_rfc2822(v)
                            .ok()
                            .and_then(|date| u64::try_from(date.timestamp()).ok())
                            .map(|n| n.saturating_sub(unix))
                    })
                });
            let seconds = reset
                .into_iter()
                .chain(retry)
                .max()
                .unwrap_or(fallback)
                .clamp(1, 86_400);
            let until = now + Duration::from_secs(seconds);
            self.blocked_until = Some(self.blocked_until.map_or(until, |old| old.max(until)));
        } else if (200..300).contains(&status) {
            self.failures = 0;
            let remaining = headers
                .get("x-ratelimit-remaining")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<i64>().ok());
            if let Some(remaining) = remaining {
                let until = now + Duration::from_secs(reset.unwrap_or(5).min(86_400));
                // Some responses report a smaller provider/firewall bucket.
                // Reserving eight out of a ten-request allowance starves discovery.
                let current = value("x-ratelimit-current");
                let allowance = current.and_then(|current| {
                    u64::try_from(remaining)
                        .ok()
                        .and_then(|remaining| current.checked_add(remaining))
                });
                let reserve = allowance
                    .map(|limit| (limit / 5).clamp(1, 8) as i64)
                    .unwrap_or(1);
                if remaining <= reserve {
                    self.background_until = Some(until);
                } else {
                    self.background_until = None;
                }
                if remaining <= 0 {
                    self.blocked_until =
                        Some(self.blocked_until.map_or(until, |old| old.max(until)));
                }
            }
        }
    }
}

pub async fn send(request: RequestBuilder, priority: Priority) -> Result<Response, String> {
    let started = Instant::now();
    loop {
        let delay = STATE
            .get_or_init(|| Mutex::new(Budget::default()))
            .lock()
            .map_err(|_| "Jupiter request budget lock unavailable")?
            .reserve(Instant::now(), priority, EXITS.load(Ordering::SeqCst) > 0);
        match delay {
            Ok(()) => break,
            Err(delay) if delay <= Duration::from_millis(1100) && started.elapsed() < Duration::from_secs(4) => {
                tokio::time::sleep(delay).await;
            }
            Err(delay) => return Err(format!("Jupiter shared request budget is cooling down; retry in {}s. Live exits have reserved capacity.", delay.as_secs().saturating_add(1))),
        }
    }
    // One send only. A caller must obtain a new fresh quote for any later attempt.
    let response = request
        .send()
        .await
        .map_err(|_| "Jupiter request unavailable".to_string())?;
    STATE
        .get()
        .expect("initialized budget")
        .lock()
        .map_err(|_| "Jupiter request budget lock unavailable")?
        .observe(
            response.status().as_u16(),
            response.headers(),
            Instant::now(),
            chrono::Utc::now().timestamp().max(0) as u64,
        );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn small_provider_buckets_do_not_starve_background_requests() {
        let now = Instant::now();
        let mut budget = Budget::default();
        let mut headers = HeaderMap::new();
        headers.insert("x-ratelimit-current", "4".parse().unwrap());
        headers.insert("x-ratelimit-remaining", "6".parse().unwrap());
        headers.insert("x-ratelimit-reset", "1005".parse().unwrap());
        budget.observe(200, &headers, now, 1000);
        assert!(budget.reserve(now, Priority::Background, false).is_ok());
        headers.insert("x-ratelimit-current", "8".parse().unwrap());
        headers.insert("x-ratelimit-remaining", "2".parse().unwrap());
        budget.observe(200, &headers, now, 1000);
        assert!(budget
            .reserve(now + Duration::from_secs(2), Priority::Background, false)
            .is_err());
        headers.insert("x-ratelimit-current", "3".parse().unwrap());
        headers.insert("x-ratelimit-remaining", "7".parse().unwrap());
        budget.observe(200, &headers, now + Duration::from_secs(2), 1002);
        assert!(budget
            .reserve(now + Duration::from_secs(2), Priority::Background, false)
            .is_ok());
    }
    #[test]
    fn background_cannot_consume_held_mark_or_exit_reserves() {
        let now = Instant::now();
        let mut budget = Budget::default();
        for n in 0..24 {
            assert!(budget
                .reserve(
                    now + Duration::from_millis(n * 1100),
                    Priority::Background,
                    false
                )
                .is_ok());
        }
        let at = now + Duration::from_secs(30);
        assert!(budget.reserve(at, Priority::Background, false).is_err());
        assert!(budget.reserve(at, Priority::HeldMark, false).is_ok());
        for n in 1..18 {
            assert!(budget
                .reserve(
                    at + Duration::from_millis(n * 1100),
                    Priority::HeldMark,
                    false
                )
                .is_ok());
        }
        assert!(budget
            .reserve(at + Duration::from_secs(20), Priority::HeldMark, false)
            .is_err());
        assert!(budget
            .reserve(at + Duration::from_secs(20), Priority::Exit, true)
            .is_ok());
    }
    #[test]
    fn a_429_in_any_reader_blocks_all_readers_until_provider_reset() {
        let now = Instant::now();
        let mut budget = Budget::default();
        let mut headers = HeaderMap::new();
        headers.insert("x-ratelimit-reset", "1030".parse().unwrap());
        budget.observe(429, &headers, now, 1000);
        for p in [
            Priority::Background,
            Priority::Entry,
            Priority::HeldMark,
            Priority::Exit,
        ] {
            assert!(budget
                .reserve(now + Duration::from_secs(29), p, false)
                .is_err());
        }
        assert!(budget
            .reserve(now + Duration::from_secs(30), Priority::Exit, false)
            .is_ok());
    }
    #[test]
    fn exit_work_suppresses_other_reads_and_still_obeys_pacing() {
        let now = Instant::now();
        let mut budget = Budget::default();
        for priority in [Priority::Background, Priority::Entry, Priority::HeldMark] {
            assert!(budget.reserve(now, priority, true).is_err());
        }
        assert!(budget.reserve(now, Priority::Exit, true).is_ok());
        assert!(budget.reserve(now, Priority::Exit, true).is_err());
        assert!(budget
            .reserve(now + Duration::from_millis(1050), Priority::Exit, true)
            .is_ok());
    }
    #[test]
    fn rolling_window_and_provider_headroom_are_both_enforced() {
        let now = Instant::now();
        let mut budget = Budget::default();
        budget.sent.extend((0..50).map(|_| now));
        assert!(budget
            .reserve(now + Duration::from_secs(59), Priority::Exit, false)
            .is_err());
        assert!(budget
            .reserve(now + Duration::from_secs(60), Priority::Exit, false)
            .is_ok());
        let mut headers = HeaderMap::new();
        headers.insert("x-ratelimit-remaining", "2".parse().unwrap());
        headers.insert("x-ratelimit-current", "58".parse().unwrap());
        headers.insert("x-ratelimit-reset", "1005".parse().unwrap());
        budget.observe(200, &headers, now, 1000);
        assert!(budget.background_until.is_some());
        headers.insert("x-ratelimit-remaining", "-1".parse().unwrap());
        budget.observe(200, &headers, now, 1000);
        assert!(budget.blocked_until.is_some());
    }
}
