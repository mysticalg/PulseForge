# PulseForge

[Project page](https://mysticalg.github.io/PulseForge/) · [Download for Windows](https://github.com/mysticalg/PulseForge/releases/latest) · [Live wallet guide](docs/LIVE_WALLET.md)

Download the Windows x64 installer from Releases. Node.js and Rust are only required to build from source. Releases are unsigned. Live wallet sessions require separate activation.

PulseForge is a Windows-first Solana altcoin scanner and paper-trading workstation. It blends recent-pool, five-minute trending, organic-activity, and top-traded discovery with a compact tree-ensemble baseline, deterministic safety vetoes, paper positions, an emergency stop, and a native hot-wallet vault.

## Linux and macOS

Choose Linux x64 `.deb`/`.AppImage`, macOS Intel (`x64`) `.dmg`, or Apple Silicon (`aarch64`) `.dmg` from [Releases](https://github.com/mysticalg/PulseForge/releases/latest). Linux builds target Ubuntu 22.04 or newer with WebKitGTK 4.1. Install the Debian package with `sudo apt install ./PulseForge_*.deb`; for AppImage, run `chmod +x PulseForge_*.AppImage` then execute it (FUSE may be required; `--appimage-extract-and-run` is an alternative). On Mac open the DMG and drag PulseForge to Applications. These builds are unsigned and not notarized; macOS may require explicit approval in System Settings → Privacy & Security.

**Linux/macOS builds support market research and paper trading. Wallet import, wallet valuation and live signing are unavailable because the existing vault uses Windows Credential Manager.** They do not fall back to plaintext key storage. Windows retains its existing wallet support.

To build from source, install Node.js 24 LTS and stable Rust. On Mac install Xcode Command Line Tools (`xcode-select --install`). On Ubuntu install `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev patchelf`. Then run `npm ci` and `npm run tauri build -- --ci`. Platform configuration selects DMG on macOS and DEB/AppImage on Linux. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Native builds and tests run in the **Build Linux and macOS downloads** GitHub Actions workflow before release upload. A passing build verifies compilation and automated tests; desktop interaction on physical Linux/Mac machines has not yet been verified.


## Capability status

| Capability | v0.10.8 |
| --- | --- |
| Demo scanner and deterministic paper fills | Ready |
| Blended recent, 5m trending, organic-activity, and top-traded discovery through Jupiter Tokens V2 | Ready with `JUPITER_API_KEY` |
| Automatic paper entries and deterministic exits | Ready while the app is open and the PC is awake |
| Editable portfolio-wide maximum of 1–25 simultaneous paper positions | Ready; presets default to 5 Conservative / 4 Pump scalp / 4 High-risk launch scout / 4 Launch runner |
| Explicit Med-High/High-risk paper-entry opt-in | Ready; enabled by Pump scalp, High-risk launch scout, and Launch runner; contract/execution/capital gates still apply |
| New-pool pump watch with local ~30-second continuation measurement | Ready as the **Pump scalp** paper preset |
| Young-pool price and volume acceleration with guarded high-buy-flow ranking | Ready as the **High-risk launch scout** paper preset |
| Observed breakout or pullback-reclaim entries without a fixed profit target | Ready as the **Launch runner** paper preset; transparent, untrained heuristics |
| Configurable momentum/volume exits and per-mint re-entry cooldown | Ready; measured short windows and fresh provider marks required |
| Launch workflow showing candidates, safety blockers, entry readiness, and open positions | Ready in **Market**; rules are editable in **Settings** |
| Sortable provider-reported market-cap scanner column | Ready; unavailable values display as `—` |
| Manual paper closes at 25%, 50%, or 100% | Ready; held mints are refreshed directly and remain closable at a labelled last-mark fallback if the provider is unavailable |
| Click-to-sort table columns with per-table reset-to-default controls | Ready |
| Arrow-key navigation for market, signal, position, exit, and strategy lists | Ready; typing and button controls retain their normal keys |
| Pre-click manual-entry blocker list using the configured impact/liquidity limits | Ready |
| Jupiter token icons from public HTTPS metadata, token names, and recorded position-entry reasons | Ready with safe initials fallback |
| Persistent paper positions, settings, fees, impact, and realized P&L | Ready in versioned local storage |
| Point-in-time model evidence recorder and 45-minute outcome labels | Ready in native SQLite while the live feed runs |
| Unsigned Jupiter round-trip quote probes for eligible candidates | Ready with `JUPITER_API_KEY`; no transaction is built |
| Persistent five-policy shadow comparison and exit attribution | Ready while the live feed runs |
| Four-stage chronological gradient-boosting/random-forest training and sigmoid calibration | Ready from CSV or the native SQLite ledger |
| Validated research-report import and model-comparison registry | Ready; imported reports cannot activate execution |
| Model-score drift monitoring and cost-stressed promotion checks | Ready as research evidence |
| Real SOL/SPL portfolio valuation | Ready after wallet import and provider setup |
| Native Solana keypair-file import | Ready in the desktop app |
| Secret storage in Windows Credential Manager | Ready |
| Manually approved live canary swaps | Ready with an isolated wallet, Jupiter key, session arm, fresh preview, and per-swap phrase confirmation |
| Automatic live wallet sessions | Separate user activation, native limits, transaction simulation and confirmed-fill journal; see [Live wallet](docs/LIVE_WALLET.md) |
| Follow automatic paper trades | New paper BUY/SELL events can drive a separately armed live session; native checks and live spending limits still apply |
| Mature-pool live buy protection | Guarded discovery mode requires 24-hour age, adjustable liquidity minimum from $20,000, concentration/activity checks and five minutes of native liquidity observations |

**Live wallet** uses the existing imported Solana wallet and the entry/exit rules captured when you start its session. It has its own real-money controls and managed positions; paper history remains separate. Live signing starts off after an app restart or view reload. Review the wallet, elevated-risk opt-in, input limits, additional fee/rent ceiling and stop behavior before activating a session. [Live wallet guide](docs/LIVE_WALLET.md).

The model in this build is a hand-authored, uncalibrated tree-ensemble baseline. It does **not** update itself when a trade wins or loses. Leaving the app running grows the evidence and shadow ledgers, but it does not automatically turn a losing model into a profitable one. A candidate must be retrained offline, tested on later untouched data, and deliberately promoted in a future reviewed build. No result is a promise of future profit.

## Model evidence and calibration

The desktop app records every candidate from each live snapshot once per minute in `%APPDATA%\com.pulseforge.trader\calibration-v1.sqlite3`. This includes candidates that are rejected by the strategy. Each observation is labelled by replaying a fixed conservative evidence policy in timestamp order: stop loss, trailing stop, take profit, liquidity drawdown, flow deterioration, then the 45-minute maximum hold. If the route disappears before a usable exit and remains absent through the 15-minute grace window, the outcome is retained as negative and unavailable. Minute-gap returns are bounded to −100%/+100% before becoming new labels; the offline trainer separately quarantines non-finite historical outcomes and records every exclusion or bounded row in its report.

The recorder also captures short/medium momentum, liquidity change, flow imbalance, participation, and market-regime features. Up to three eligible candidates per minute receive an unsigned $20 USDC → token → USDC Jupiter quote probe. The probe records route availability and estimated round-trip cost, but it does not request swap instructions, construct a transaction, access the wallet, sign, or submit anything. Jupiter describes `outAmount` as the quoted output after AMM and platform fees but before slippage, so the app keeps quote evidence separate from actual-fill claims.

Open **Models** to see observation, label, data-quality, and imported research-artifact status. The early research gate opens after one day with at least 10,000 usable labels and 1,000 examples of each class; this does not replace the 30-day promotion requirement. Use **Export CSV** when you want a portable dataset, or train directly from the native database:

```powershell
py -m venv .calibration-venv
.\.calibration-venv\Scripts\python -m pip install -r requirements-calibration.txt
.\.calibration-venv\Scripts\python tools\train_calibrate.py "$env:APPDATA\com.pulseforge.trader\calibration-v1.sqlite3"
```

The trainer uses four distinct chronological segments: fitting, model selection, sigmoid calibration/threshold selection, and the newest untouched test. A one-hour purge separates the segments. Repeated observations are down-weighted per mint, quote-result fields are excluded from the model, and threshold evaluation applies the conservative hard safety gates. The report includes an extra 1% cost stress, daily-block bootstrap confidence bound, data-span and missingness audits, the shipped raw-score benchmark, and explicit promotion checks. It emits a joblib research artifact and JSON report under `calibration-artifacts/`. Import the JSON report from **Models** to review its metrics; neither the report nor the joblib file is loaded into paper execution.

Historical backfill is intentionally not treated as equivalent evidence. A conventional OHLC backfill cannot faithfully reconstruct then-available liquidity, holder concentration, authorities, organic participation, route availability, or failed exits. It can be useful for pipeline testing, but it must not satisfy the live evidence or promotion gates.

## Run the app

Requirements:

- Windows 10/11 with the WebView2 Runtime
- Node.js 22 or newer
- Rust 1.77.2 or newer with the MSVC Windows target

Install and test:

```powershell
npm install
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Run the desktop development build:

```powershell
npm run tauri dev
```

Create the NSIS installer and standalone executable:

```powershell
npm run tauri build -- --bundles nsis
```

Artifacts are written under `src-tauri/target/release/` and `src-tauri/target/release/bundle/nsis/`.

## Provider setup

PulseForge reads provider keys only in Rust. Do not prefix them with `VITE_`, paste them into the UI, or store a populated `.env` beside the executable.

Set Windows user environment variables and restart PulseForge:

```powershell
[Environment]::SetEnvironmentVariable("JUPITER_API_KEY", "your-key", "User")
[Environment]::SetEnvironmentVariable("HELIUS_API_KEY", "your-key", "User")
[Environment]::SetEnvironmentVariable("HELIUS_LASERSTREAM_ENDPOINT", "your-endpoint", "User")
[Environment]::SetEnvironmentVariable("SOLANA_RPC_URL", "https://your-rpc-endpoint", "User")
```

`JUPITER_API_KEY` is consumed by discovery, quote evidence, wallet valuation, and the separately armed manual live canary. `SOLANA_RPC_URL` or `HELIUS_API_KEY` supplies wallet balances. LaserStream is still a readiness check for a future colocated streaming worker.

The live scanner blends Jupiter's recent-token list with the 5-minute top-trending, top-organic, and top-traded categories. Activity categories are cached for 30 seconds and results are deduplicated by mint. Up to 40 of the 120 candidate slots retain mature, liquid tokens meeting the coarse live-entry age, concentration and activity requirements. Remaining capacity retains launch, paper-eligible and pump-watch ranking. Every live buy must still pass the native checks described in the live wallet guide. The default manual paper size is $25; automatic size follows the selected portfolio and allocation settings.

Held mints that disappear from discovery, or whose discovery row is older than 15 seconds, receive a direct token refresh during each market cycle. These requests run in batches of up to three. Missing, invalid, future-dated, or overly old provider responses never become fresh execution marks. A failed refresh is reported; automatic exits wait for usable data. The manual close flow can use an explicitly labelled last-recorded paper mark when a fresh provider mark is unavailable.

## Automatic paper trading

1. Open **Settings** and choose **Conservative**, **Pump scalp**, **High-risk launch scout**, or **Launch runner**, then review the portfolio budget, allocation, exits, entry gates, and daily-loss limit. Applying any preset pauses automation.
2. Use **Reset paper account** if the configured budget differs from the current paper account capital.
3. Turn on **Enable paper automation**. The engine evaluates immediately, then on completed market refreshes scheduled every five seconds; provider requests can make a cycle take longer. In **Market**, the launch workflow shows candidate counts, safety blockers, rule-ready entries, and open positions. Use **Configure rules** to return to **Settings**.
4. Keep PulseForge open and keep Windows awake. Closing the app or allowing the PC to sleep stops evaluation; the ledger resumes from versioned storage when reopened.
5. Open **Positions** to close 25%, 50%, or 100% manually. Automatic exits use the configured momentum, volume, profit, stop, maximum-hold, flow-deterioration, liquidity-drawdown, daily-loss, and kill-switch rules. Pausing automation pauses its entries and exits.

The v10 settings migration preserves supported paper ledgers and existing customised settings, adds the previous strategy's momentum-exit thresholds, and pauses automation. Review the migrated settings before enabling it again. Selecting a preset applies that preset's current defaults and also pauses automation.

The v0.9.2 **Conservative** preset reflects the observed Solana universe instead of the sparse v0.8 thresholds: $100,000 minimum liquidity, $10,000 five-minute volume, 10 traders, one organic buyer, a 0.62 raw-score floor, and a 55–85% buy share. It still admits only Low/Medium classifications and keeps every contract/audit gate. On portfolios below $100, it scales allocation only enough to reach the engine's $5 minimum order, capped at 25% per token.

The **Pump scalp** paper preset considers pools 2–60 minutes old with a 2–25% five-minute gain, then waits for roughly 30 seconds of continued movement between 0.3% and 6%. Defaults are a 58–88% buy share, $25,000 liquidity, $10,000 five-minute volume, 15 traders, one organic buyer, turnover of 0.2, and trade-sized impact no greater than 1%. It allows four positions, targets 6%, stops at 3.5%, trails by 2.5%, and exits after five minutes. The current preset also exits at or below −0.2% short price momentum and applies a 15-minute momentum-break cooldown; its short-volume exit is disabled by default.

The default **High-risk launch scout** requires a confirmed pool age of at least 90 seconds, then watches pools up to 45 minutes old for 1.5–40% five-minute momentum and 0.2–10% locally measured 30-second continuation. Pool age does not establish persistent route availability. It requires a 58–92% buy share, at least one provider-reported sell, five trades, eight traders, $5,000 liquidity, $1,500 five-minute volume, turnover of 0.2, and trade-sized impact no greater than 1.5%. Early organic fields are ranking/diagnostic evidence rather than hard vetoes because Jupiter warns that they are volatile for fresh pools. Contract authorities, holder concentration, transfer tax, stale data, and capital limits remain hard gates. The preset allows High/Med-High **paper** classifications, targets 4.5%, stops at 3%, trails by 2%, and exits after two minutes. Its short exits trigger at or below −0.2% price momentum or −5% volume growth, followed by a 15-minute momentum-break cooldown.

The **Launch runner** preset uses the launch scout's age, safety, activity, and capital gates, then requires an observed **breakout** or **pullback reclaim** with at least 5% short-window volume growth. The pattern rules look for repeated price advances or a shallow retreat followed by a recovery, supported by sustained buy pressure, volume, and liquidity. They require at least four distinct provider samples spanning 30 seconds within the latest 75 seconds, with no gap above 20 seconds. These are transparent, untrained heuristics; they have not been validated as a prediction model or a way to identify future large winners.

| Launch runner exit setting | Default |
| --- | --- |
| Take profit | `0`: fixed profit target disabled |
| Stop loss | 5% |
| Trailing stop | 8% from the highest observed paper price |
| Maximum hold | 45 minutes |
| Short price momentum exit | At or below −2% |
| Short volume-growth exit | At or below −15% |
| Momentum-break re-entry cooldown | 15 minutes for the exited mint |

Runner positions can continue through gains above the scout's fixed target while their exit conditions remain untriggered. The runner also disables the scout's small-gain profit lock. Buy-ratio deterioration, liquidity loss, the daily-loss limit, and the kill switch still apply. In the launch-flow strategy, setting **Take profit** to `0` selects runner pattern gating as well as disabling the fixed target; the **Launch runner** card applies the complete preset above.

Short momentum uses distinct provider timestamps. Repeated polls of a cached row do not add samples, and rows older than already-observed data are excluded from actionable observations. Both the provider timestamp and local receipt must be fresh; execution accepts marks up to 75 seconds old. Price and volume thresholds each require a usable measured window of 25–75 seconds. Short volume growth measures the change in the provider's rolling five-minute traded notional over that local window. Missing short-window evidence keeps required entries warming and cannot trigger a momentum exit, while other exit rules still apply to fresh usable marks.

When Jupiter omits transfer-fee evidence, the native app verifies the mint account using bounded, cached RPC batches. Supported Token-2022 mints with no transfer-fee extension can establish a zero fee; the absence of a Jupiter field alone cannot. Invalid accounts, unsupported extensions, unknown fees, unconfirmed authority revocation, missing holder concentration, and invalid timestamps still block eligibility. Explicit restrictive provider fees are preserved. Unknown pool age cannot qualify as a confirmed launch. These checks do not establish that a token is safe or sellable.

Automatic allocation is a maximum. The engine reduces a proposed paper order to fit the configured impact limit and available allocation; it rejects sizes below the minimum order. For example, with the current impact model, a $200 cap, $4,000 liquidity and 2% maximum impact permit approximately $40 before other capital limits. Manual order amounts remain explicit. **No entry yet** in the launch pipeline expands to show current blockers and pattern evidence.

In **Exit rules**, **Exit below short momentum** and **Exit below short volume growth** trigger at or below their configured thresholds. A value of `−100` disables that individual short exit. **Momentum-break cooldown** applies after either exit and uses the longer of that delay and the ordinary token cooldown.

In **Exit rules**, `Exit below buy ratio` controls the flow-deterioration exit and a value of zero disables that exit. `Buy-ratio exit cooldown` independently controls how long that mint stays blocked after this exit; it takes the longer of this special delay and the ordinary cooldown. The launch preset exits below 0.43 and waits 15 minutes before re-entry.

`Exit after liquidity loss` compares current observed pool liquidity with the liquidity recorded at entry; for example, `15` exits after a 15% decline and `0` disables this exit. `Liquidity-exit cooldown` blocks the same mint after that exit, using whichever is longer: this dedicated delay or the ordinary cooldown. Presets use 15% / 15 minutes for launch flow, 20% / 15 minutes for pump scalp, and 30% / 30 minutes for Conservative.

An exact 100% buy reading is not assumed to be a winner. It often means the sample is tiny, has no observed exits, or is synthetic. High-risk launch scout therefore requires two-sided activity and defaults to a 92% maximum buy share. Market cap is read directly from Jupiter token metadata and shown as unavailable when the provider does not report it.

Configured profit targets specify exit conditions and do not forecast returns. A common outcome may be a stop, a small gain, or no trade at all. Discovery polls bounded Jupiter lists; it does not cover every launch or guarantee detection in its first seconds. Five-second desktop polling and Jupiter aggregate token data cannot reproduce the lower-latency feeds, private routing, transaction landing, or real fill priority seen in specialist terminals. All automatic orders remain simulated. Paper results can materially overstate execution quality on new meme tokens; real positions may be impossible to exit at the displayed price.

Open **Strategy Lab** to compare five persistent policies on the same live observations: Conservative v1, Liquidity-first, Pump scalp, High-risk launch scout, and the prior v0.3 baseline control. These shadow ledgers do not touch the user's paper account. The lab reports net P&L, expectancy, drawdown, fee/impact drag, exit-reason attribution, quote coverage, and model-score distribution drift. See [the high-risk parameter audit](docs/HIGH_RISK_PAPER_STRATEGY.md) for local distributions, sources, and limitations.

## Wallet import

Open **Settings → Import isolated wallet** in the Windows desktop app and choose either:

- a Solana CLI JSON keypair containing exactly 64 byte values; or
- a text file containing one base58-encoded 64-byte Solana keypair.

The native Rust file picker reads the file. The private key never enters React, WebView storage, a URL, a command line, or app logs. The validated keypair is stored as a local Windows generic credential. The original key file is not deleted.

Use a dedicated, low-value hot wallet only. Windows Credential Manager protects the key at rest, but other software running as the same Windows user can potentially access generic credentials. See [SECURITY.md](SECURITY.md).

## Manual live canary

Automatic sessions are managed in **Live wallet**. To use the separate manual canary when no automatic live positions or unresolved orders exist:

1. Import a dedicated low-value hot wallet and configure `JUPITER_API_KEY`.
2. Open **Settings → Manual live canary** and type the displayed acknowledgement exactly. Arming resets whenever the app restarts.
3. Select a token in **Market**. Preview a $1–$10 live buy, or a 25%/50%/100% sale of that token already held by the imported wallet.
4. Review the fresh Jupiter route, input, expected output, impact, slippage, fee, and expiry. Type that preview's token-specific phrase, then click **Submit real swap**.

The native path enforces a $10 buy maximum, $25 UTC daily buy cap, 60-second successful-trade cooldown, 1% impact cap, 100 bps slippage cap, 50 bps Jupiter-fee cap, 0.02 SOL reserve, single-flight execution, and a persistent local audit journal. React never receives the private key or transaction bytes. Buys retain a stricter Low/Medium contract-quality boundary; sells are not trapped by entry-risk classification. No live transaction is submitted by automated tests.

## Risk and model policy

The v0.9.2 decision path uses hard vetoes for authorities, holder concentration, transfer tax, trade-sized impact, capital, and the configured open-position ceiling. High-risk paper presets relax classification, liquidity, participation, and early-organic thresholds without weakening those contract/account controls. Automatic paper entries require two-sided flow and reject a 100% buy ratio. Momentum profiles rank qualifying continuation without treating the uncalibrated baseline model score as a probability or override. The engine has no leverage, martingale, or averaging-down behavior.

Before a future data-trained model replaces the shipped strategy heuristic, promotion review should require:

- at least 30 calendar days, 300 labelled point-in-time observations, both outcome classes, and 300 completed shadow round trips before serious promotion review;
- positive net expectancy after fees, failed transactions, slippage, and stressed exit liquidity;
- a lower 95% block-bootstrap expectancy bound above zero;
- purged walk-forward validation with an untouched chronological test period;
- stable model-score distribution drift and adequate real quote coverage;
- zero stale-data, duplicate-order, reconciliation, safety-veto, or kill-switch violations;
- a tiny, capped live canary after paper acceptance.

No strategy, random forest, gradient-boosted model, or app can guarantee a profit. A $40 or $400 allocation is capital at risk, not a profit target, and a fresh meme-token position can become unsellable.

## Architecture

- `src/` — React/TypeScript workstation UI and deterministic paper account.
- `src-tauri/src/market.rs` — live Jupiter discovery with explicit demo fallback.
- `src-tauri/src/model.rs` — compact baseline and hard paper-order gates.
- `src-tauri/src/wallet.rs` — native import, Windows vault access, and read-only live portfolio valuation.
- `src-tauri/src/lib.rs` — narrow Tauri command surface; no arbitrary sign/export command exists.

For production latency, the desktop app should remain the control plane while a supervised worker runs near London/Frankfurt RPC and routing infrastructure. A home Windows connection cannot be the fastest market participant.
