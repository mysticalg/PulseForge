//! Read-only mint-account evidence for fees omitted by token discovery metadata.
//!
//! Layout references (reviewed 2026-09-05):
//! https://github.com/solana-program/token-2022/blob/main/interface/src/state.rs
//! https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs
//! https://github.com/solana-program/token-2022/blob/main/interface/src/extension/transfer_fee/mod.rs
//! https://github.com/solana-program/token-metadata/blob/main/interface/src/state.rs
//! https://solana.com/docs/rpc/http/getmultipleaccounts
//!
//! This deliberately supports a small allowlist. Unknown or transfer-restricting
//! extensions never become a zero-fee result merely because TransferFeeConfig
//! was absent. RPC errors are kept generic so configured URLs/keys cannot leak.

use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    hash::{Hash, Hasher},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use solana_sdk::pubkey::Pubkey;

use crate::types::{MarketToken, SafetyChecks};

const LEGACY_TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINT_LEN: usize = 82;
const EXTENSION_START: usize = 166;
const MAX_MINT_ACCOUNT_BYTES: usize = 64 * 1024;
const MAX_RPC_RESPONSE_BYTES: usize = 6 * 1024 * 1024;
const MAX_MINTS_PER_REFRESH: usize = 120;
const RPC_BATCH_SIZE: usize = 100;
const MAX_CACHE_ENTRIES: usize = 2_048;
const VERIFIED_TTL: Duration = Duration::from_secs(60);
const FAILED_TTL: Duration = Duration::from_secs(10);
const RPC_TIMEOUT: Duration = Duration::from_secs(3);
static MINT_CACHE: OnceLock<Mutex<MintCache>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq)]
struct MintEvidence {
    transfer_tax_pct: f64,
    mint_authority_revoked: bool,
    freeze_authority_revoked: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EvidenceError {
    Unavailable,
    InvalidAccount,
    UnsupportedExtension,
}

type EvidenceResult = Result<MintEvidence, EvidenceError>;

#[derive(Clone)]
struct CacheEntry {
    checked_at: Instant,
    result: EvidenceResult,
}

impl CacheEntry {
    fn is_fresh(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.checked_at)
            < if self.result.is_ok() {
                VERIFIED_TTL
            } else {
                FAILED_TTL
            }
    }
}

#[derive(Default)]
struct MintCache {
    endpoint_fingerprint: u64,
    entries: HashMap<String, CacheEntry>,
}

/// Counts describe missing fee evidence only; other safety gates still apply.
#[derive(Debug, Default)]
pub struct MintSafetyReport {
    pub resolved: usize,
    pub blocked: usize,
    pub rpc_requests: usize,
}

/// Resolve only explicitly unknown fee evidence. An explicit restrictive audit
/// result, including an explicit 100% fee, is never overwritten.
///
/// At most 120 distinct mints are fetched in two concurrent read-only RPC calls.
/// Positive evidence lasts 60 seconds; failures/in-flight reservations last 10.
/// No stale cache result is used while a refresh fails. Authorities can only be
/// made more restrictive here, preserving negative discovery audit findings.
pub async fn resolve_unknown_mint_safety(tokens: &mut [MarketToken]) -> MintSafetyReport {
    let mut report = MintSafetyReport::default();
    let mut seen = HashSet::new();
    let mints: Vec<String> = tokens
        .iter()
        .filter(|token| token.safety.transfer_tax_unknown)
        .filter(|token| seen.insert(token.mint.clone()))
        .take(MAX_MINTS_PER_REFRESH)
        .map(|token| token.mint.clone())
        .collect();
    if mints.is_empty() {
        return report;
    }

    let endpoint = crate::wallet::rpc_url();
    let mut hasher = DefaultHasher::new();
    endpoint.hash(&mut hasher);
    let fingerprint = hasher.finish();
    let now = Instant::now();
    let mut outcomes = HashMap::<String, EvidenceResult>::new();
    let mut pending = Vec::new();
    {
        let cache_lock = MINT_CACHE.get_or_init(|| Mutex::new(MintCache::default()));
        if let Ok(mut cache) = cache_lock.lock() {
            // Do not mix evidence when the configured RPC cluster changes.
            if cache.endpoint_fingerprint != fingerprint {
                cache.entries.clear();
                cache.endpoint_fingerprint = fingerprint;
            }
            cache.entries.retain(|_, entry| entry.is_fresh(now));
            for mint in &mints {
                if mint.parse::<Pubkey>().is_err() {
                    outcomes.insert(mint.clone(), Err(EvidenceError::InvalidAccount));
                } else if let Some(entry) = cache.entries.get(mint) {
                    outcomes.insert(mint.clone(), entry.result);
                } else {
                    // An overlapping scanner/direct-token lookup must not start
                    // another request storm. It can retry at the next refresh.
                    cache.entries.insert(
                        mint.clone(),
                        CacheEntry {
                            checked_at: now,
                            result: Err(EvidenceError::Unavailable),
                        },
                    );
                    pending.push(mint.clone());
                }
            }
            trim_cache(&mut cache.entries);
        } else {
            // A poisoned cache is a failed safety check, not a network bypass.
            report.blocked = tokens
                .iter()
                .filter(|token| token.safety.transfer_tax_unknown)
                .count();
            return report;
        }
    }

    if !pending.is_empty() {
        let client = reqwest::Client::builder()
            .timeout(RPC_TIMEOUT)
            .connect_timeout(Duration::from_secs(1))
            .user_agent(concat!("PulseForge/", env!("CARGO_PKG_VERSION")))
            .build();
        if let Ok(client) = client {
            let split = pending.len().min(RPC_BATCH_SIZE);
            let (first, second) = pending.split_at(split);
            report.rpc_requests = 1 + usize::from(!second.is_empty());
            let (first_results, second_results) = tokio::join!(
                fetch_batch(&client, &endpoint, first, 1),
                fetch_batch(&client, &endpoint, second, 2),
            );
            outcomes.extend(first_results);
            outcomes.extend(second_results);
        } else {
            for mint in &pending {
                outcomes.insert(mint.clone(), Err(EvidenceError::Unavailable));
            }
        }
        if let Some(cache_lock) = MINT_CACHE.get() {
            if let Ok(mut cache) = cache_lock.lock() {
                if cache.endpoint_fingerprint == fingerprint {
                    let checked_at = Instant::now();
                    for mint in &pending {
                        cache.entries.insert(
                            mint.clone(),
                            CacheEntry {
                                checked_at,
                                result: outcomes
                                    .get(mint)
                                    .copied()
                                    .unwrap_or(Err(EvidenceError::Unavailable)),
                            },
                        );
                    }
                    trim_cache(&mut cache.entries);
                }
            }
        }
    }

    for token in tokens
        .iter_mut()
        .filter(|token| token.safety.transfer_tax_unknown)
    {
        if let Some(Ok(evidence)) = outcomes.get(&token.mint) {
            apply_evidence(&mut token.safety, *evidence);
            report.resolved += 1;
        } else {
            // The 100% value is the established fail-closed unknown sentinel.
            token.safety.transfer_tax_pct = 100.0;
            report.blocked += 1;
        }
    }
    report
}

fn apply_evidence(safety: &mut SafetyChecks, evidence: MintEvidence) {
    if !safety.transfer_tax_unknown {
        return;
    }
    safety.transfer_tax_pct = evidence.transfer_tax_pct;
    safety.transfer_tax_unknown = false;
    safety.mint_authority_revoked &= evidence.mint_authority_revoked;
    safety.freeze_authority_revoked &= evidence.freeze_authority_revoked;
}

fn trim_cache(entries: &mut HashMap<String, CacheEntry>) {
    if entries.len() <= MAX_CACHE_ENTRIES {
        return;
    }
    let mut oldest: Vec<_> = entries
        .iter()
        .map(|(mint, entry)| (mint.clone(), entry.checked_at))
        .collect();
    oldest.sort_unstable_by_key(|(_, checked_at)| *checked_at);
    let excess = entries.len() - MAX_CACHE_ENTRIES;
    for (mint, _) in oldest.into_iter().take(excess) {
        entries.remove(&mint);
    }
}

async fn fetch_batch(
    client: &reqwest::Client,
    endpoint: &str,
    mints: &[String],
    id: u64,
) -> HashMap<String, EvidenceResult> {
    if mints.is_empty() {
        return HashMap::new();
    }
    let result = fetch_accounts(client, endpoint, mints, id).await;
    match result {
        Ok(results) => mints.iter().cloned().zip(results).collect(),
        Err(error) => mints
            .iter()
            .cloned()
            .map(|mint| (mint, Err(error)))
            .collect(),
    }
}

async fn fetch_accounts(
    client: &reqwest::Client,
    endpoint: &str,
    mints: &[String],
    id: u64,
) -> Result<Vec<EvidenceResult>, EvidenceError> {
    if mints.is_empty() || mints.len() > RPC_BATCH_SIZE {
        return Err(EvidenceError::InvalidAccount);
    }
    let mut response = client
        .post(endpoint)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "getMultipleAccounts",
            "params": [mints, { "encoding": "base64", "commitment": "confirmed" }]
        }))
        .send()
        .await
        .map_err(|_| EvidenceError::Unavailable)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_RPC_RESPONSE_BYTES as u64)
    {
        return Err(EvidenceError::Unavailable);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| EvidenceError::Unavailable)?
    {
        if chunk.len() > MAX_RPC_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err(EvidenceError::Unavailable);
        }
        bytes.extend_from_slice(&chunk);
    }
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| EvidenceError::Unavailable)?;
    parse_rpc_accounts(mints, &payload, id)
}

fn parse_rpc_accounts(
    mints: &[String],
    payload: &Value,
    id: u64,
) -> Result<Vec<EvidenceResult>, EvidenceError> {
    if payload.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || payload.get("id").and_then(Value::as_u64) != Some(id)
        || payload.get("error").is_some_and(|error| !error.is_null())
        || payload
            .pointer("/result/context/slot")
            .and_then(Value::as_u64)
            .is_none()
    {
        return Err(EvidenceError::Unavailable);
    }
    let accounts = payload
        .pointer("/result/value")
        .and_then(Value::as_array)
        .filter(|accounts| accounts.len() == mints.len())
        .ok_or(EvidenceError::Unavailable)?;
    // getMultipleAccounts guarantees request order; a length mismatch rejects
    // the entire batch instead of accidentally pairing a mint with another row.
    Ok(mints
        .iter()
        .zip(accounts)
        .map(|(mint, account)| parse_rpc_account(mint, account))
        .collect())
}

fn parse_rpc_account(mint: &str, account: &Value) -> EvidenceResult {
    let requested_mint = mint
        .parse::<Pubkey>()
        .map_err(|_| EvidenceError::InvalidAccount)?;
    if account.get("executable").and_then(Value::as_bool) != Some(false)
        || !account
            .get("lamports")
            .and_then(Value::as_u64)
            .is_some_and(|lamports| lamports > 0)
    {
        return Err(EvidenceError::InvalidAccount);
    }
    let owner = account
        .get("owner")
        .and_then(Value::as_str)
        .ok_or(EvidenceError::InvalidAccount)?;
    let data = account
        .get("data")
        .and_then(Value::as_array)
        .ok_or(EvidenceError::InvalidAccount)?;
    if data.len() != 2 || data[1].as_str() != Some("base64") {
        return Err(EvidenceError::InvalidAccount);
    }
    let encoded = data[0].as_str().ok_or(EvidenceError::InvalidAccount)?;
    if encoded.len() > (MAX_MINT_ACCOUNT_BYTES.div_ceil(3) * 4) {
        return Err(EvidenceError::InvalidAccount);
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| EvidenceError::InvalidAccount)?;
    if account
        .get("space")
        .is_some_and(|space| space.as_u64() != Some(bytes.len() as u64))
    {
        return Err(EvidenceError::InvalidAccount);
    }
    parse_mint_data(&requested_mint, owner, &bytes)
}

fn parse_mint_data(mint: &Pubkey, owner: &str, data: &[u8]) -> EvidenceResult {
    if (owner != LEGACY_TOKEN_PROGRAM && owner != TOKEN_2022_PROGRAM)
        || data.len() < MINT_LEN
        || data.len() > MAX_MINT_ACCOUNT_BYTES
        || data.len() == 355 // SPL multisig, not an extended mint.
        || data[45] != 1
    // Initialized mint is required.
    {
        return Err(EvidenceError::InvalidAccount);
    }
    let evidence = MintEvidence {
        transfer_tax_pct: 0.0,
        mint_authority_revoked: coption_revoked(&data[..36])?,
        freeze_authority_revoked: coption_revoked(&data[46..82])?,
    };
    if owner == LEGACY_TOKEN_PROGRAM {
        return if data.len() == MINT_LEN {
            Ok(evidence)
        } else {
            Err(EvidenceError::InvalidAccount)
        };
    }
    if data.len() == MINT_LEN {
        // The Token-2022 program also supports a plain 82-byte mint.
        return Ok(evidence);
    }
    if data.len() < EXTENSION_START
        || data[MINT_LEN..165].iter().any(|byte| *byte != 0)
        || data[165] != 1
    // AccountType::Mint, not Account or Uninitialized.
    {
        return Err(EvidenceError::InvalidAccount);
    }
    let mut evidence = evidence;
    let mut offset = EXTENSION_START;
    let mut seen_extensions = HashSet::new();
    while offset < data.len() {
        let rest = &data[offset..];
        if rest.iter().all(|byte| *byte == 0) {
            break; // Uninitialized extension storage / realloc padding.
        }
        if rest.len() < 4 {
            return Err(EvidenceError::InvalidAccount);
        }
        let extension_type = u16::from_le_bytes([rest[0], rest[1]]);
        let length = usize::from(u16::from_le_bytes([rest[2], rest[3]]));
        if extension_type == 0 || !seen_extensions.insert(extension_type) || length > rest.len() - 4
        {
            return Err(EvidenceError::InvalidAccount);
        }
        let value = &rest[4..4 + length];
        match extension_type {
            1 => evidence.transfer_tax_pct = parse_transfer_fee(value)?,
            // MintCloseAuthority has no effect when its authority is absent.
            3 if value.len() == 32 && value.iter().all(|byte| *byte == 0) => (),
            // DefaultAccountState::Initialized. Frozen/uninitialized defaults
            // cannot be called transferable even if no transfer fee is present.
            6 if value == [1] => (),
            // Metadata/group pointer extensions contain two 32-byte pubkeys.
            // They do not intercept transfers or grant balance authority.
            18 | 20 | 22 if value.len() == 64 => (),
            19 => validate_token_metadata(mint, value)?,
            21 if value.len() == 80 && &value[32..64] == mint.as_ref() => {
                if read_u64(&value[64..72]) > read_u64(&value[72..80]) {
                    return Err(EvidenceError::InvalidAccount);
                }
            }
            23 if value.len() == 72 && &value[..32] == mint.as_ref() => (),
            // Hooks, delegates, frozen defaults, non-transferability, pausing,
            // confidential transfers, account-only and new extension types all
            // remain blocked until separately supported and audited.
            _ => return Err(EvidenceError::UnsupportedExtension),
        }
        offset += 4 + length;
    }
    Ok(evidence)
}

fn coption_revoked(bytes: &[u8]) -> Result<bool, EvidenceError> {
    match &bytes[..4] {
        [0, 0, 0, 0] => Ok(true),
        [1, 0, 0, 0] => Ok(false),
        _ => Err(EvidenceError::InvalidAccount),
    }
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(
        bytes
            .try_into()
            .expect("caller supplies a checked eight-byte slice"),
    )
}

fn parse_transfer_fee(value: &[u8]) -> Result<f64, EvidenceError> {
    // Two optional 32-byte authorities + 8-byte withheld amount + two packed
    // TransferFee records (epoch:u64, maximum_fee:u64, basis_points:u16).
    if value.len() != 108 {
        return Err(EvidenceError::InvalidAccount);
    }
    let older_epoch = read_u64(&value[72..80]);
    let newer_epoch = read_u64(&value[90..98]);
    let older_bps = u16::from_le_bytes([value[88], value[89]]);
    let newer_bps = u16::from_le_bytes([value[106], value[107]]);
    if older_bps > 10_000 || newer_bps > 10_000 || newer_epoch < older_epoch {
        return Err(EvidenceError::InvalidAccount);
    }
    // Use the more restrictive currently stored schedule, including a pending
    // increase. This needs no extra epoch RPC and deliberately ignores token
    // amount fee caps. It is a conservative rate, not an exact fill fee quote.
    Ok(f64::from(older_bps.max(newer_bps)) / 100.0)
}

fn validate_token_metadata(mint: &Pubkey, value: &[u8]) -> Result<(), EvidenceError> {
    if value.len() < 80 || &value[32..64] != mint.as_ref() {
        return Err(EvidenceError::InvalidAccount);
    }
    let mut offset = 64;
    for _ in 0..3 {
        read_borsh_string(value, &mut offset)?;
    }
    let count = read_borsh_u32(value, &mut offset)? as usize;
    if count > value.len().saturating_sub(offset) / 8 {
        return Err(EvidenceError::InvalidAccount);
    }
    let mut keys = HashSet::new();
    for _ in 0..count {
        let key = read_borsh_string(value, &mut offset)?;
        if !keys.insert(key) {
            return Err(EvidenceError::InvalidAccount);
        }
        read_borsh_string(value, &mut offset)?;
    }
    // SPL's variable-length unpacker permits allocated trailing bytes; the
    // interpreted strings and map must nevertheless be complete and valid.
    Ok(())
}

fn read_borsh_u32(value: &[u8], offset: &mut usize) -> Result<u32, EvidenceError> {
    let bytes = value
        .get(*offset..offset.saturating_add(4))
        .ok_or(EvidenceError::InvalidAccount)?;
    *offset += 4;
    Ok(u32::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| EvidenceError::InvalidAccount)?,
    ))
}

fn read_borsh_string<'a>(value: &'a [u8], offset: &mut usize) -> Result<&'a str, EvidenceError> {
    let length = read_borsh_u32(value, offset)? as usize;
    let bytes = value
        .get(*offset..offset.saturating_add(length))
        .ok_or(EvidenceError::InvalidAccount)?;
    *offset += length;
    std::str::from_utf8(bytes).map_err(|_| EvidenceError::InvalidAccount)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_mint() -> Vec<u8> {
        let mut data = vec![0; MINT_LEN];
        data[36..44].copy_from_slice(&1_000_000u64.to_le_bytes());
        data[44] = 6;
        data[45] = 1;
        data
    }

    fn extended_mint(extensions: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut data = plain_mint();
        data.resize(EXTENSION_START, 0);
        data[165] = 1;
        for (extension_type, value) in extensions {
            data.extend_from_slice(&extension_type.to_le_bytes());
            data.extend_from_slice(&(value.len() as u16).to_le_bytes());
            data.extend_from_slice(value);
        }
        data
    }

    fn fees(older: u16, newer: u16) -> Vec<u8> {
        let mut value = vec![0; 108];
        value[72..80].copy_from_slice(&10u64.to_le_bytes());
        value[80..88].copy_from_slice(&u64::MAX.to_le_bytes());
        value[88..90].copy_from_slice(&older.to_le_bytes());
        value[90..98].copy_from_slice(&11u64.to_le_bytes());
        value[98..106].copy_from_slice(&u64::MAX.to_le_bytes());
        value[106..108].copy_from_slice(&newer.to_le_bytes());
        value
    }

    fn metadata(mint: &Pubkey) -> Vec<u8> {
        let mut value = vec![0; 32];
        value.extend_from_slice(mint.as_ref());
        for string in ["Token", "TKN", "https://example.com/token.json"] {
            value.extend_from_slice(&(string.len() as u32).to_le_bytes());
            value.extend_from_slice(string.as_bytes());
        }
        value.extend_from_slice(&0u32.to_le_bytes());
        value
    }

    fn rpc_account(owner: &str, bytes: &[u8]) -> Value {
        json!({
            "owner": owner,
            "executable": false,
            "lamports": 1_000_000,
            "data": [STANDARD.encode(bytes), "base64"],
            "space": bytes.len()
        })
    }

    #[test]
    fn legacy_and_plain_token_2022_mints_have_verified_zero_transfer_fee() {
        for owner in [LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM] {
            let result = parse_mint_data(&Pubkey::new_unique(), owner, &plain_mint()).unwrap();
            assert_eq!(result.transfer_tax_pct, 0.0);
            assert!(result.mint_authority_revoked);
            assert!(result.freeze_authority_revoked);
        }
    }

    #[test]
    fn token_2022_metadata_without_transfer_fee_is_allowed() {
        let mint = Pubkey::new_unique();
        let bytes = extended_mint(&[(18, vec![0; 64]), (19, metadata(&mint)), (6, vec![1])]);
        assert_eq!(
            parse_mint_data(&mint, TOKEN_2022_PROGRAM, &bytes)
                .unwrap()
                .transfer_tax_pct,
            0.0
        );
    }

    #[test]
    fn fee_checks_cover_current_and_pending_schedule_without_assuming_zero() {
        let mint = Pubkey::new_unique();
        for (older, newer, expected) in [
            (0, 100, 1.0),
            (250, 50, 2.5),
            (0, 0, 0.0),
            (50, 10_000, 100.0),
        ] {
            let bytes = extended_mint(&[(1, fees(older, newer))]);
            assert_eq!(
                parse_mint_data(&mint, TOKEN_2022_PROGRAM, &bytes)
                    .unwrap()
                    .transfer_tax_pct,
                expected
            );
        }
        let mut invalid_schedule = fees(100, 100);
        invalid_schedule[90..98].copy_from_slice(&9u64.to_le_bytes());
        assert!(parse_transfer_fee(&invalid_schedule).is_err());
        assert!(parse_transfer_fee(&fees(10_001, 0)).is_err());
        assert!(parse_transfer_fee(&fees(0, 10_001)).is_err());
        assert!(parse_transfer_fee(&fees(0, 0)[..107]).is_err());
    }

    #[test]
    fn transfer_restrictions_and_unrecognized_extensions_remain_blocked() {
        for (extension_type, value) in [
            (14, vec![0; 64]), // TransferHook, even with no current program.
            (12, vec![0; 32]), // PermanentDelegate, even if currently absent.
            (6, vec![2]),      // Frozen default accounts.
            (6, vec![0]),
            (9, vec![]),       // NonTransferable.
            (26, vec![0; 33]), // Pausable.
            (2, vec![0; 8]),   // Account-only TransferFeeAmount.
            (65_000, vec![0; 8]),
        ] {
            let bytes = extended_mint(&[(extension_type, value)]);
            assert!(parse_mint_data(&Pubkey::new_unique(), TOKEN_2022_PROGRAM, &bytes).is_err());
        }
    }

    #[test]
    fn invalid_owners_account_types_and_authority_tags_are_rejected() {
        let mint = Pubkey::new_unique();
        assert!(parse_mint_data(&mint, "11111111111111111111111111111111", &plain_mint()).is_err());
        assert!(parse_mint_data(&mint, LEGACY_TOKEN_PROGRAM, &extended_mint(&[])).is_err());
        for wrong_type in [0, 2, 3] {
            let mut bytes = extended_mint(&[]);
            bytes[165] = wrong_type;
            assert!(parse_mint_data(&mint, TOKEN_2022_PROGRAM, &bytes).is_err());
        }
        let mut bytes = plain_mint();
        bytes[0] = 2;
        assert!(parse_mint_data(&mint, LEGACY_TOKEN_PROGRAM, &bytes).is_err());
        bytes[0] = 1;
        bytes[46] = 1;
        let evidence = parse_mint_data(&mint, LEGACY_TOKEN_PROGRAM, &bytes).unwrap();
        assert!(!evidence.mint_authority_revoked);
        assert!(!evidence.freeze_authority_revoked);
    }

    #[test]
    fn truncated_and_duplicate_extensions_are_rejected() {
        let mint = Pubkey::new_unique();
        let data = extended_mint(&[(1, fees(0, 0))]);
        for truncated_len in [0, 81, 83, 164, 165, 168, 169, 200, data.len() - 1] {
            assert!(parse_mint_data(&mint, TOKEN_2022_PROGRAM, &data[..truncated_len]).is_err());
        }
        let duplicated = extended_mint(&[(1, fees(0, 0)), (1, fees(0, 0))]);
        assert!(parse_mint_data(&mint, TOKEN_2022_PROGRAM, &duplicated).is_err());
        let mut hidden_extension = extended_mint(&[]);
        hidden_extension.extend_from_slice(&[0, 0, 0, 0, 14, 0, 0, 0]);
        assert!(parse_mint_data(&mint, TOKEN_2022_PROGRAM, &hidden_extension).is_err());
        let mut bad_padding = extended_mint(&[]);
        bad_padding[82] = 1;
        assert!(parse_mint_data(&mint, TOKEN_2022_PROGRAM, &bad_padding).is_err());
    }

    #[test]
    fn metadata_mint_mismatch_or_malformed_strings_do_not_pass() {
        let mint = Pubkey::new_unique();
        let other_mint = Pubkey::new_unique();
        let bytes = extended_mint(&[(19, metadata(&other_mint))]);
        assert!(parse_mint_data(&mint, TOKEN_2022_PROGRAM, &bytes).is_err());
        let mut invalid = metadata(&mint);
        invalid[64..68].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(validate_token_metadata(&mint, &invalid).is_err());
        let mut invalid_utf8 = metadata(&mint);
        invalid_utf8[68] = 0xff;
        assert!(validate_token_metadata(&mint, &invalid_utf8).is_err());
    }

    #[test]
    fn rpc_response_requires_order_preserving_length_and_matching_id() {
        let mint = Pubkey::new_unique().to_string();
        let account = rpc_account(LEGACY_TOKEN_PROGRAM, &plain_mint());
        let mut response =
            json!({"jsonrpc":"2.0", "id":1, "result":{"context":{"slot":42},"value":[account]}});
        let mints = vec![mint.clone()];
        assert!(parse_rpc_accounts(&mints, &response, 1).unwrap()[0].is_ok());
        assert!(parse_rpc_accounts(&[mint.clone(), mint], &response, 1).is_err());
        assert!(parse_rpc_accounts(&mints, &response, 2).is_err());
        response["result"]["value"][0] = Value::Null;
        assert!(parse_rpc_accounts(&mints, &response, 1).unwrap()[0].is_err());
        response["error"] = json!({"message":"sensitive upstream details are not returned"});
        assert!(parse_rpc_accounts(&mints, &response, 1).is_err());
    }

    #[test]
    fn rpc_rejects_wrong_encoding_account_space_executable_and_invalid_base64() {
        let mint = Pubkey::new_unique().to_string();
        let account = rpc_account(TOKEN_2022_PROGRAM, &plain_mint());
        for (field, value) in [
            ("space", json!(83)),
            ("executable", json!(true)),
            ("lamports", json!(0)),
        ] {
            let mut invalid = account.clone();
            invalid[field] = value;
            assert!(parse_rpc_account(&mint, &invalid).is_err());
        }
        for data in [
            json!(["not base64", "base64"]),
            json!(["", "base58"]),
            json!([]),
        ] {
            let mut invalid = account.clone();
            invalid["data"] = data;
            assert!(parse_rpc_account(&mint, &invalid).is_err());
        }
    }

    #[test]
    fn resolver_preserves_restrictive_audits_and_cannot_upgrade_authorities() {
        let mut safety = SafetyChecks {
            mint_authority_revoked: false,
            freeze_authority_revoked: true,
            top_ten_holder_pct: 95.0,
            liquidity_locked: Some(false),
            price_impact_pct: 8.0,
            transfer_tax_pct: 100.0,
            transfer_tax_unknown: false,
            verified: false,
        };
        let evidence = MintEvidence {
            transfer_tax_pct: 0.0,
            mint_authority_revoked: true,
            freeze_authority_revoked: false,
        };
        // Explicitly reported 100% is not the missing-data sentinel.
        apply_evidence(&mut safety, evidence);
        assert_eq!(safety.transfer_tax_pct, 100.0);
        assert!(safety.freeze_authority_revoked);

        safety.transfer_tax_unknown = true;
        apply_evidence(&mut safety, evidence);
        assert_eq!(safety.transfer_tax_pct, 0.0);
        assert!(!safety.transfer_tax_unknown);
        assert!(!safety.mint_authority_revoked);
        assert!(!safety.freeze_authority_revoked);
        assert_eq!(safety.top_ten_holder_pct, 95.0);
        assert_eq!(safety.liquidity_locked, Some(false));
        assert_eq!(safety.price_impact_pct, 8.0);
        assert!(!safety.verified);
    }

    #[test]
    fn positive_and_failed_evidence_expire_and_cache_size_is_bounded() {
        let now = Instant::now();
        let evidence =
            parse_mint_data(&Pubkey::new_unique(), LEGACY_TOKEN_PROGRAM, &plain_mint()).unwrap();
        let good = CacheEntry {
            checked_at: now,
            result: Ok(evidence),
        };
        let failed = CacheEntry {
            checked_at: now,
            result: Err(EvidenceError::Unavailable),
        };
        assert!(good.is_fresh(now + Duration::from_secs(59)));
        assert!(!good.is_fresh(now + VERIFIED_TTL));
        assert!(failed.is_fresh(now + Duration::from_secs(9)));
        assert!(!failed.is_fresh(now + FAILED_TTL));
        let mut entries = HashMap::new();
        entries.insert("oldest".into(), good.clone());
        for index in 0..MAX_CACHE_ENTRIES {
            entries.insert(
                index.to_string(),
                CacheEntry {
                    checked_at: now + Duration::from_secs(1),
                    result: Ok(evidence),
                },
            );
        }
        trim_cache(&mut entries);
        assert_eq!(entries.len(), MAX_CACHE_ENTRIES);
        assert!(!entries.contains_key("oldest"));
    }

    #[tokio::test]
    #[ignore = "Read-only network check against six public 2026-09-05 launch mints"]
    async fn live_rpc_resolves_affected_launch_mints() {
        // These mints were independently inspected through jsonParsed RPC in
        // analysis/rpc-mint-diagnostic-2026-09-05.json. All six had revoked base
        // authorities, metadata-only Token-2022 extensions, and missing Jupiter
        // fee fields. Exercise the separate base64 parser and application path.
        let mints = [
            "3hLfxCKWwtsHogi54ZbCBL2Vw8yHVjKdZ9mPokknpump",
            "89nKopjqgjZVJx9JmRZBW7CU6uweaMMdjscv5GMMpump",
            "DAT7g5LJ7SNnShRYG2PotgyR39w8U3TbTnHKfVQZpump",
            "CpjqZj51RpW9hvi6NTAcPK3faczdUC1AXfFxWmVBpump",
            "PUGv7p4xBDRk8yubJdCU878gQ8dYBkYNfW4NwDLpump",
            "6t8M2YzHo3ovArHNrEpe9i24LsPhZ767bFt7AU6Fpump",
        ];
        let mut tokens: Vec<MarketToken> = mints
            .iter()
            .map(|mint| MarketToken {
                mint: (*mint).into(),
                symbol: "RPC-CHECK".into(),
                name: "Read-only mint safety check".into(),
                icon_url: None,
                age_seconds: 120,
                price_usd: 0.001,
                market_cap_usd: None,
                change_5m_pct: 0.0,
                liquidity_usd: 0.0,
                volume_5m_usd: 0.0,
                buy_ratio: 0.0,
                buys_5m: 0,
                sells_5m: 0,
                traders_5m: 0,
                organic_buyers_5m: 0,
                organic_score: None,
                risk_level: "blocked".into(),
                model_score: 0.0,
                safety: SafetyChecks {
                    mint_authority_revoked: true,
                    freeze_authority_revoked: true,
                    top_ten_holder_pct: 100.0,
                    liquidity_locked: None,
                    price_impact_pct: 25.0,
                    transfer_tax_pct: 100.0,
                    transfer_tax_unknown: true,
                    verified: false,
                },
                source: "read-only RPC test".into(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            })
            .collect();
        let report = resolve_unknown_mint_safety(&mut tokens).await;
        assert_eq!(
            report.resolved,
            mints.len(),
            "RPC mint evidence remained unresolved: {report:?}"
        );
        assert_eq!(report.blocked, 0);
        assert_eq!(report.rpc_requests, 1);
        for token in &tokens {
            assert_eq!(token.safety.transfer_tax_pct, 0.0, "{}", token.mint);
            assert!(!token.safety.transfer_tax_unknown, "{}", token.mint);
            assert!(token.safety.mint_authority_revoked, "{}", token.mint);
            assert!(token.safety.freeze_authority_revoked, "{}", token.mint);
        }
        for token in &mut tokens {
            token.safety.transfer_tax_pct = 100.0;
            token.safety.transfer_tax_unknown = true;
        }
        let cached = resolve_unknown_mint_safety(&mut tokens).await;
        assert_eq!(cached.resolved, mints.len());
        assert_eq!(
            cached.rpc_requests, 0,
            "Repeated scanner reads should use bounded cache"
        );
    }
}
