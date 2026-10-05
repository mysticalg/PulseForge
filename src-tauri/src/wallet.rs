use keyring_core::Entry;
use serde_json::{json, Value};
use solana_sdk::signature::{Keypair, Signer};
use zeroize::{Zeroize, Zeroizing};

use crate::types::{WalletPortfolio, WalletStatus};

const SERVICE: &str = "PulseForge";
const USERNAME: &str = "solana-live-hot-wallet-v1";
pub const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
pub const GAS_RESERVE_SOL: f64 = 0.02;
static CREDENTIAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static STORE_READY: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
fn entry() -> Result<Entry, String> {
    STORE_READY
        .get_or_init(|| {
            let store = windows_native_keyring_store::Store::new()
                .map_err(|error| format!("Windows Credential Manager: {error}"))?;
            keyring_core::set_default_store(store);
            Ok(())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    let modifiers = std::collections::HashMap::from([("persistence", "local")]);
    Entry::new_with_modifiers(SERVICE, USERNAME, &modifiers)
        .map_err(|error| format!("Windows Credential Manager: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn entry() -> Result<Entry, String> {
    Err("Wallet import and live signing are unavailable on Linux/macOS in this build; use market research and paper trading.".into())
}

pub fn import_file() -> Result<WalletStatus, String> {
    entry()?; // Reject unsupported vaults before opening or reading a private-key file.
    let path = rfd::FileDialog::new()
        .set_title("Import an isolated Solana hot-wallet keypair")
        .add_filter("Solana keypair", &["json", "txt"])
        .pick_file()
        .ok_or_else(|| "Wallet import cancelled.".to_string())?;
    let secret = Zeroizing::new(
        std::fs::read_to_string(&path)
            .map_err(|error| format!("Could not read the selected keypair file: {error}"))?,
    );
    let keypair = parse_secret(secret.trim())?;
    let address = keypair.pubkey().to_string();
    let mut bytes = keypair.to_bytes();

    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Wallet vault lock is poisoned".to_string())?;
    let result = entry()?
        .set_secret(&bytes)
        .map_err(|error| format!("Could not store the key in Windows Credential Manager: {error}"));
    bytes.zeroize();
    // Keypair intentionally lives only for this command and is dropped here.
    drop(keypair);
    result?;

    Ok(WalletStatus {
        imported: true,
        address: Some(address),
        storage: if cfg!(target_os = "windows") { "Windows Credential Manager" } else { "Unavailable on this platform" }.into(),
        warning: Some(format!(
            "Imported into the local Windows vault. The original file remains at {} and should be protected separately.",
            path.display()
        )),
    })
}

pub fn status() -> Result<WalletStatus, String> {
    match load_keypair() {
        Ok(keypair) => Ok(WalletStatus {
            imported: true,
            address: Some(keypair.pubkey().to_string()),
            storage: if cfg!(target_os = "windows") { "Windows Credential Manager" } else { "Unavailable on this platform" }.into(),
            warning: Some(
                "This app can access the imported hot-wallet key while you are signed in to Windows."
                    .into(),
            ),
        }),
        Err(error) if error.contains("No matching entry") || error.contains("NoEntry") => {
            Ok(WalletStatus {
                imported: false,
                address: None,
                storage: if cfg!(target_os = "windows") { "Windows Credential Manager" } else { "Unavailable on this platform" }.into(),
                warning: None,
            })
        }
        Err(error) => Ok(WalletStatus {
            imported: false,
            address: None,
            storage: if cfg!(target_os = "windows") { "Windows Credential Manager" } else { "Unavailable on this platform" }.into(),
            warning: Some(error),
        }),
    }
}

pub fn forget() -> Result<WalletStatus, String> {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Wallet vault lock is poisoned".to_string())?;
    let credential = entry()?;
    if let Err(error) = credential.delete_credential() {
        let text = error.to_string();
        if !text.contains("No matching entry") && !text.contains("NoEntry") {
            return Err(format!("Could not remove wallet credential: {text}"));
        }
    }
    Ok(WalletStatus {
        imported: false,
        address: None,
        storage: if cfg!(target_os = "windows") { "Windows Credential Manager" } else { "Unavailable on this platform" }.into(),
        warning: Some("The local credential was removed. On-chain funds were not changed.".into()),
    })
}

pub fn load_keypair() -> Result<Keypair, String> {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Wallet vault lock is poisoned".to_string())?;
    let mut bytes = entry()?
        .get_secret()
        .map_err(|error| format!("Could not read wallet credential: {error}"))?;
    let result = Keypair::try_from(bytes.as_slice())
        .map_err(|error| format!("Stored wallet credential is invalid: {error}"));
    bytes.zeroize();
    result
}

fn parse_secret(secret: &str) -> Result<Keypair, String> {
    if secret.starts_with('[') {
        let mut bytes: Vec<u8> = serde_json::from_str(secret)
            .map_err(|_| "The JSON key must be an array of 64 byte values.".to_string())?;
        let result = Keypair::try_from(bytes.as_slice()).map_err(|_| {
            "The JSON keypair is invalid or its public half does not match.".to_string()
        });
        bytes.zeroize();
        return result;
    }

    Keypair::try_from_base58_string(secret).map_err(|_| {
        "Enter a base58 Solana keypair or a 64-byte Solana CLI JSON array.".to_string()
    })
}

pub async fn portfolio() -> Result<WalletPortfolio, String> {
    let keypair = match load_keypair() {
        Ok(value) => value,
        Err(_) => {
            return Ok(WalletPortfolio {
                imported: false,
                address: None,
                sol_balance: None,
                sol_price_usd: None,
                native_value_usd: None,
                estimated_total_value_usd: None,
                available_after_gas_usd: None,
                source: "No wallet imported".into(),
                warning: None,
            })
        }
    };
    let address = keypair.pubkey().to_string();
    drop(keypair);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent(concat!("PulseForge/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let rpc_url = rpc_url();
    let balance_response = client
        .post(&rpc_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBalance",
            "params": [address, { "commitment": "confirmed" }]
        }))
        .send()
        .await
        .map_err(|error| format!("Solana balance request failed: {error}"))?;
    let balance_json: Value = balance_response
        .json()
        .await
        .map_err(|error| format!("Invalid Solana balance response: {error}"))?;
    let lamports = balance_json
        .pointer("/result/value")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            balance_json
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Solana RPC did not return a balance")
                .to_string()
        })?;
    let sol_balance = lamports as f64 / 1_000_000_000.0;

    let api_key = std::env::var("JUPITER_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let mut sol_price_usd = None;
    let mut estimated_total_value_usd = None;
    let mut source = "Solana RPC · native SOL only".to_string();
    let warning;

    if let Some(api_key) = api_key {
        let valuation = crate::wallet_valuation::fetch(&client, &api_key, &address).await;
        sol_price_usd = valuation.price;
        estimated_total_value_usd = valuation.total.filter(|total| *total > 0.0);
        warning = valuation.warning;
        if estimated_total_value_usd.is_some() {
            source = "Solana RPC + Jupiter Portfolio (valuation cached up to 2 minutes)".into();
        }
    } else {
        warning = Some(
            "Set JUPITER_API_KEY to add USD pricing and SPL-token portfolio valuation.".into(),
        );
    }

    let native_value_usd = sol_price_usd.map(|price| price * sol_balance);
    if estimated_total_value_usd.is_none() {
        estimated_total_value_usd = native_value_usd;
    }
    let available_after_gas_usd = match (sol_price_usd, estimated_total_value_usd) {
        (Some(price), Some(total)) => Some((total - price * GAS_RESERVE_SOL).max(0.0)),
        _ => None,
    };

    Ok(WalletPortfolio {
        imported: true,
        address: Some(address),
        sol_balance: Some(sol_balance),
        sol_price_usd,
        native_value_usd,
        estimated_total_value_usd,
        available_after_gas_usd,
        source,
        warning,
    })
}

pub fn rpc_url() -> String {
    if let Ok(url) = std::env::var("SOLANA_RPC_URL") {
        if url.starts_with("https://") {
            return url;
        }
    }
    if let Ok(api_key) = std::env::var("HELIUS_API_KEY") {
        if !api_key.trim().is_empty() {
            return format!("https://mainnet.helius-rpc.com/?api-key={api_key}");
        }
    }
    "https://api.mainnet-beta.solana.com".into()
}

pub(crate) fn portfolio_total(value: &Value) -> f64 {
    value
        .get("elements")
        .and_then(Value::as_array)
        .map(|elements| {
            elements
                .iter()
                .flat_map(|element| {
                    element
                        .pointer("/data/assets")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .filter_map(|asset| asset.get("value").and_then(Value::as_f64))
                .sum()
        })
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unsupported_vault_cannot_import_or_sign() {
        assert!(entry().is_err());
        assert!(import_file().is_err());
        assert!(load_keypair().is_err());
        let state = status().unwrap();
        assert!(!state.imported);
        assert_eq!(state.storage, "Unavailable on this platform");
    }

    #[test]
    fn accepts_base58_and_json_keypairs() {
        let keypair = Keypair::new();
        let base58 = keypair.to_base58_string();
        let json = serde_json::to_string(&keypair.to_bytes().to_vec()).unwrap();
        assert_eq!(parse_secret(&base58).unwrap().pubkey(), keypair.pubkey());
        assert_eq!(parse_secret(&json).unwrap().pubkey(), keypair.pubkey());
    }

    #[test]
    fn sums_only_portfolio_assets() {
        let payload = json!({
            "elements": [
                { "data": { "assets": [{ "value": 12.5 }, { "value": 7.5 }] } },
                { "data": { "assets": [{ "value": 3.0 }] } }
            ]
        });
        assert_eq!(portfolio_total(&payload), 23.0);
    }
}
