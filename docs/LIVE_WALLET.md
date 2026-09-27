# Live wallet sessions

PulseForge keeps automatic paper trading and real-wallet execution in separate ledgers. A wallet import does not activate automatic trading. The Windows app starts with live signing disarmed.

## Starting a session

1. Open **Settings** and check the imported wallet's public address and native SOL balance. The existing Windows Credential Manager import is reused; no private key needs to be entered again.
2. Review the entry and exit rules in **Settings**. **Launch runner** uses the existing pattern, momentum, volume, holder and mint-authority checks. Those strategy rules are captured when a live session starts. Later paper-rule edits apply to the next live session.
3. Open **Live wallet** and review its separate real-money limits. Initial defaults are $5 maximum swap input per buy, $25 daily buy cap, two open positions, $10 daily realized-loss limit, 100 basis points maximum slippage, 2% maximum impact and $20,000 minimum liquidity. You can raise the liquidity minimum; stronger saved strategy liquidity and impact thresholds also apply. The live elevated-risk classification opt-in is separate from the paper opt-in and starts unchecked; it cannot bypass the mandatory buy protection below.
4. Read the displayed wallet address, limits and authorization phrase. Enter the phrase and select **Start live automation** yourself. A live feed and an imported wallet are required. The paper automation switch does not authorize this action.

Buys spend native SOL. Estimated portfolio value or tokens already held in the wallet cannot fund a SOL-input order. The daily buy input cap covers swap principal. Each transaction can additionally spend up to 0.02 SOL on fees and account rent, while leaving a minimum 0.02 SOL in the wallet. These amounts are displayed before activation. A rule-ready signal may still be rejected because of an unavailable route, fees, slippage, insufficient SOL or unsupported transaction instructions.

## Managing positions

Only confirmed positions opened by this automatic live executor are managed. A buy into a mint the wallet already holds is rejected, and a sell is limited to the bot's recorded quantity and the spendable on-chain balance. Existing unrelated tokens are not adopted or automatically sold.

- **Pause entries** stops new buys while automatic exits continue.
- **Stop live session** disarms new live submissions, including automatic exits. It does not liquidate existing holdings. An order already submitted can still confirm.
- **Close 100%** requests a real sale of the selected managed position while the session is armed. It is complete only when the journal shows confirmation.
- The top-bar **Kill switch** stops live submissions and flattens simulated paper positions. Resetting it does not rearm live signing.
- Closing or restarting the app, sleeping the PC, or reloading the app view stops active strategy evaluation. After a restart or view reload, explicitly start a live session again to manage remaining positions.

Spending limits and a daily loss stop block new entries; they do not block a managed exit. Route and transaction validation still applies to sales, so an exit signal is not a guarantee that a sale will execute.

## Confirmation and recovery

The key-free native journal is `%APPDATA%\com.pulseforge.trader\live-trading-v1.sqlite3`. It stores owner-bound order identities, pending signatures, actual confirmed quantities, costs and managed positions. Paper local storage is not converted into live holdings and remains unchanged.

An intent is recorded before submission. A timeout is unresolved, not proof of failure; the app looks up the saved signature instead of blindly sending a replacement order. Only verified transaction metadata creates or closes a managed position. Unknown orders remain visible and reserve capacity until reconciliation establishes their outcome. Restarting does not erase those reservations.

Position marks and estimated P&L are indicative. Cost basis and realized P&L use the confirmed wallet SOL movement, valued at the SOL/USD observation captured during execution. Network fees and account rent can make them differ from the quoted swap input; later unrelated rent refunds are not attributed automatically. This is an execution ledger, not a tax report.

From v0.10.2, the position table omits estimated value and P&L if the native provider mark is missing or over 75 seconds old, and shows the last mark time. A stale price is not a current liquidation value. The display clock continues aging marks even while a provider request is delayed. Jupiter HTTP errors include the bounded provider rejection message when available. “Failed to get quotes” means no quote was produced for that request; it does not close the position or prove funds were recovered. Loss of liquidity can make a token unsellable even if entry checks passed earlier.

## Supported execution boundary

This release uses Jupiter Swap V2 orders with the imported wallet as the sole fee payer and signer. It accepts supported Jupiter swap instructions, validates their input and slippage fields, resolves address lookup accounts, and simulates account effects before signing. Co-signed/gasless routes, arbitrary transfer instructions and unsupported layouts fail closed. Trading through other wallets or modifying holdings externally can require manual reconciliation.

Keys remain in the native Windows vault path. Neither private keys nor complete signed transactions enter React or the paper-storage schema. Jupiter and the configured RPC remain external dependencies.

## Portfolio rate limiting (v0.10.1)

The wallet's optional Jupiter portfolio valuation is cached for up to two minutes, and its display SOL price for up to 30 seconds. Concurrent refreshes share these requests. Native SOL balances continue to be fetched from RPC; live order execution performs its own fresh checks and never uses this display cache to authorize a trade.

A 429 on either wallet valuation endpoint pauses both optional valuation requests. The cooldown respects Jupiter's reset/retry headers and increases from 60 seconds to five minutes on repeated rate limits (longer provider delays are honored up to one day). Expired values are omitted rather than displayed as current. Changing wallets clears the previous wallet's total without bypassing the cooldown.

All Jupiter read requests now share a process-wide sliding-window budget. Background discovery and valuation stop at 24 total requests in the preceding minute, entry reads at 36, held-position marks at 42, and exit reads at 50. These thresholds reserve room for live exits within the documented 60-request free allowance and leave some headroom for other clients. Requests are spaced by at least 1.05 seconds. During an active exit attempt, other reads yield to its fresh SOL-price and quote requests. A provider 429 pauses every reader according to the provider's reset/retry headers, with increasing fallback delays when headers are absent. Successful responses reporting little remaining allowance also pause background reads. This budget is deliberately conservative even on a paid plan; traffic from other applications and provider-specific rules can still exhaust the organisation's quota.

Held paper and live mints use one batched lookup, deduplicated by mint, instead of an individual request for each token. Failed batches do not fan out into individual retries or invent fresh marks. Recent-launch discovery keeps its five-second schedule; trending, organic and traded lists are cached for 30 seconds.

Jupiter's transaction-submission endpoint has a separate provider bucket. This change does not delay signed submissions through the read queue or automatically retry them. The existing persistent-signature reconciliation still handles ambiguous outcomes. Fresh SOL prices, quote validation, simulation, wallet ownership and signing checks remain mandatory. The portfolio warning alone does not establish whether a trading request succeeded or failed; check Recent live orders for its status.

References: [Jupiter rate limits and buckets](https://developers.jup.ag/docs/portal/rate-limits) and [batched token searches](https://developers.jup.ag/docs/tokens/token-information).

Provider references: [Jupiter Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute) and [Solana transaction simulation](https://solana.com/docs/rpc/http/simulatetransaction). The signed-instruction parser uses the [pinned current on-chain Jupiter IDL](JUPITER_ONCHAIN_IDL_2026-09-06.json), with its finalized slot, owner and SHA-256 recorded in the [source receipt](JUPITER_ONCHAIN_IDL_2026-09-06.source.json).

### 0.10.3: quota recovery and unpriced paper holdings

Background headroom now adapts to the actual bucket reported by Jupiter (`current + remaining`), reserving 20% (one to eight requests). Unknown buckets reserve one request. Previously a fixed eight-request reserve could continually stall a ten-request bucket. Local sliding-window limits and exit priority remain enforced.

Paper holdings without a positive price updated in the past 75 seconds show Unpriced. Equity and unrealized P&L are unavailable while any holding is unpriced. The status explicitly identifies unpriced holdings or a full position limit instead of displaying RUNNING. Missing prices do not imply an executed exit.

A user-approved paper adjustment can be supplied in the native app data directory as `approved-paper-writeoffs.json`: an array of exact `mint`, `openedAtMs`, `quantity`, and `costBasisUsd` snapshots. Only matching paper holdings are removed; zero proceeds and the full cost loss are appended to history with reason `illiquid_writeoff`. Cash, real holdings and real orders are unaffected. Repeated application is idempotent. The normal daily loss stop remains in force. Paper storage schema 11 accepts these explicit zero-proceeds records and migrates schema 10 without resetting the portfolio. Remove the approval file after verifying persistence and retain a receipt with the backup.

### 0.10.4: quarantine unpriced live holdings

Stop the live session and wait for pending orders to settle. An unpriced managed position exposes **Quarantine**, followed by a review of its mint, full cost and consequences. The native command rechecks the imported owner, stopped session, unresolved orders, positive position accounting and a mark older than 75 seconds. It atomically transfers the exact position record into an owner-bound quarantine table. Repeated requests are idempotent.

Quarantined tokens remain in the wallet. No sale, proceeds or realized P&L are fabricated; order history is unchanged. They no longer occupy active slots or block unrelated entries, and their mints cannot be automatically bought again. Automatic exits stop for quarantined holdings. The app keeps their recorded quantities, original position details, quarantine time and full-cost risk loss visible in a separate section.

The quarantine loss is separate from realized P&L but deducted alongside it when enforcing the live daily loss limit, in both the native executor and frontend planner. It applies to the UTC day of quarantine and persists across restarts. Daily buy usage, entry sizing, price/slippage limits and all other checks remain unchanged. Quarantine never starts live automation; the user must start a new session after reviewing limits. The app does not currently offer restoration from quarantine or sales of quarantined holdings.

### 0.10.5: sell-route preflight and exit recovery

Before signing each live buy, the native executor obtains one quote-only sell check for the expected acquired quantity using the same supported Jupiter router, slippage, fee and price-impact limits. It blocks the buy if the quote fails or the returned SOL falls below the allowance derived from both sides' configured impact, slippage and maximum platform fees. This adds one shared-budget Jupiter GET per attempted buy, not per scanned token. No taker is provided, so no sell transaction is assembled. This is a point-in-time route check, not proof that liquidity will remain or that a later sale will succeed. Network fees and token-account rent remain separately bounded.

The native status now exposes the latest exit attempt for each exact managed position from the full journal, independently of the 50-row history display. Failed exits remain due without scanner marks and retry with a new idempotent intent after 15, 30, 60, then 120 seconds. Unknown/pending transactions must reconcile first. Maximum hold is a wall-clock deadline and can request a fresh native sell quote even while discovery is unavailable. Neither condition fabricates a market mark or closes a position without confirmed balance changes. Normal price/flow signals ignore observations older than the confirmed entry or latest native mark.

STONK investigation on 2026-09-06: buy confirmed at 09:13:22 UTC; automatic sell journaled at 09:13:26 UTC failed with Jupiter HTTP 400, Failed to get quotes. A later unsigned query found no USD price, effectively zero liquidity, and no supported sell quote. The update cannot recreate missing liquidity or recover the held tokens' cost.

API reference for quote-only orders without taker: https://developers.jup.ag/docs/swap/order-and-execute

### 0.10.6: mature-pool automatic discovery

Version 0.10.6 introduced a confirmed pool age of at least 24 hours, at least $250,000 reported liquidity, top-ten holder concentration at or below 20%, at least 25 traders and at least 10 sells in the preceding five minutes. Version 0.10.7 lowers the liquidity floor as described below. Stronger saved strategy limits still apply. Live entries replace the paper preset's short maximum-age window so mature tokens can qualify; paper trading and the exit rules captured for existing positions are unchanged.

The native process must observe at least six distinct provider updates spanning five minutes in both provider time and local receipt time. Each update must remain fresh within 75 seconds, with no gap over 75 seconds. A liquidity decline greater than 10% from an observed peak resets history and blocks entry for at least five minutes. Missing, stale, future-dated or backward timestamps cannot warm the history. Restarting the process requires a new observation window.

These checks use native market responses already fetched by the app. They add no per-token network calls. A fresh token lookup and a final check immediately before signing enforce the policy for a BUY even if the frontend is bypassed or older saved limits are lower. The elevated-risk flag cannot bypass the policy. Failed or missing buy history does not block SELL requests, wallet status or pending-order reconciliation.

Discovery reserves up to 40 of 120 slots for mature tokens meeting the coarse age, liquidity, holder and activity requirements, so launches cannot occupy the entire feed. Fee verification and full native entry checks still follow selection. Passing this protection does not replace a strategy entry signal, verify LP lock coverage/duration, or guarantee against a later liquidity collapse.

Sell simulation errors now distinguish an exact-quantity mismatch, nonpositive net SOL proceeds after transaction effects, and output below the required minimum. A rejected simulation leaves the holding open; it does not record a sale.

### 0.10.7: adjustable live liquidity from $20,000

The minimum accepted liquidity setting and new-session default are now $20,000. The native observation cache, BUY executor, frontend planner and mature discovery reservation all use this lower floor. A higher saved session minimum still applies, as does a higher captured strategy minimum. Existing saved values are not silently lowered by the software update.

Pool age, holder concentration, activity, five-minute observation history, drawdown resets, sell-route preflight, slippage and impact checks retain their existing requirements. Passing the liquidity minimum alone does not produce a trade: the selected strategy still needs an entry signal. Under a 20% five-minute volume-to-liquidity requirement, a pool at the $20,000 floor needs at least $4,000 reported five-minute volume.

### 0.10.8: follow automatic paper trades

Choose **Follow paper trades** in Live wallet to receive newly generated automatic paper BUY and SELL events after starting the session. This mode replaces guarded discovery's 24-hour age and five-minute history requirements with the captured paper entry criteria. Native freshness, contract safety, live limits, quote validation, sell-route preflight and simulation remain mandatory. Real amounts use the live maximum per buy, not paper capital.

The effective liquidity minimum is the higher of the live and paper settings. A $20,000 live minimum still skips a paper trade in a $12,500 pool, even when paper accepts $5,000. Existing configurations default to Guarded discovery until explicitly changed.

Only new automatic paper buys are followed; previous history, demo/shadow trades and manual paper trades are not copied. Matching paper exits remain queued through delayed live confirmations. Existing live exit checks continue and may sell earlier because live fill costs differ. Pausing discards queued entries; changing captured paper entry criteria requires a new live session. Starting remains a user action after app restart.

Implementation and operational details: [Paper follow behavior](PAPER_FOLLOW_2026-09-07.md).
