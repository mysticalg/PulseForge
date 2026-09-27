# PulseForge security notes

## Private keys

PulseForge v0.10.0 accepts only a dedicated Solana hot-wallet keypair selected through a native Rust file picker. The WebView receives only the public address, portfolio summary, sanitized live-route preview and key-free live ledger. There is no command that exports the key or signs an arbitrary WebView-supplied message or transaction.

Validated key bytes are stored in Windows Credential Manager with local persistence and are zeroed from temporary byte buffers where practical. This protects storage at rest; it does not protect against same-user malware, a compromised operating system, memory inspection, or a malicious replacement executable.

Never import a seed phrase, hardware-wallet recovery phrase, main savings wallet, or wallet holding more than you are prepared to lose. Keep the original keypair file protected after import; PulseForge does not delete it.

## Desktop boundary

- Wallet/provider secrets stay in Rust.
- The app ships bundled local content under a restrictive content-security policy.
- Provider-supplied token icons must use public HTTPS URLs without credentials or private/local hosts; image requests send no referrer.
- The main window has no generic filesystem, shell, or HTTP capability.
- Provider requests use HTTPS and bounded timeouts.
- Automatic live signing requires a separate owner-bound session with explicit activation and native limits. The session starts off after restart; paper automation cannot arm it.
- Automatic orders pass native mint checks, supported signed-instruction input/slippage/fee checks and unsigned account-effect simulation. Unknown instructions, extra asset spending and authority changes fail closed.
- The native live journal commits order identity, exact amounts and signature before submission. Ambiguous sends retain reservations and are reconciled on chain without blind resubmission. Only confirmed wallet deltas change managed positions.
- Wallet import/forget and stopping invalidate active automatic sessions. Manual and automatic wallet operations are serialized, and manual canary execution is unavailable while automatic positions or unresolved orders exist.
- Manual live canary signing is implemented only in Rust for a fresh Jupiter Swap V2 order whose mints, exact input, output, impact, slippage, and fee are checked against the short-lived native challenge.
- The full transaction and signed bytes never enter React. Jupiter is nevertheless an external transaction-construction trust boundary; use a dedicated low-value wallet.
- Manual execution starts disarmed after every app launch, consumes each preview once, serializes submissions, enforces native daily/order/cooldown limits, and records a key-free local SQLite journal.

## If a wallet may be exposed

Stop the app, transfer remaining assets to a newly generated wallet from trusted software, then use **Settings → Forget locally** to remove the local credential. Deleting the credential does not revoke a copied key or move on-chain assets.

## Reporting

When reporting a security issue, include the PulseForge version, Windows version, reproducible steps, and redacted logs. Never include a private key, seed phrase, provider key, or signed transaction.
