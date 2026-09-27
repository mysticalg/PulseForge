# High-risk paper strategy: evidence and defaults

Research date: 2026-08-23

This note explains the `High-risk launch scout` paper preset. It is an experimental opportunity-generation policy, not evidence of profitability and not authorization for automatic live trading.

## What the local recorder showed

The calibration database contained 301,047 unique mint-minute observations covering 14,922 mints and 1.47 days (2026-08-21 15:55 UTC through 2026-08-23 03:08 UTC). The most recent 24-hour window showed:

| Metric | Observed value |
|---|---:|
| Median liquidity | $74,696 |
| 25th-percentile liquidity | $12,444 |
| Median five-minute volume | $1,341 |
| Median distinct five-minute traders | 10 |
| Median organic net buyers | 1 |
| High or Med-High observations | 71.2% |
| Exact 100% buy-share observations | 30,382 |

For positive-momentum pools no older than one hour, median liquidity was only $3,640, median volume was $1,628, and median age was 0.8 minutes. The old conservative defaults ($250k liquidity, $100k five-minute volume, 75 traders) were therefore far outside the market the scanner was actually observing.

Two implementation details amplified the problem:

1. Young pools are classified High or Med-High largely because of age and sub-$100k liquidity, but the old launch preset did not opt into those paper classifications.
2. The token-row impact estimate is anchored to a $250 probe. Applying it unchanged to a $5–$10 paper order falsely rejected otherwise routeable small trades.

The data also argues against indiscriminate sniping. Of first qualifying young-pool observations in a relaxed cohort, many vanished before a complete 45-minute outcome path existed. Waiting about 90 seconds materially improved route persistence. Among usable paths, the return distribution remained strongly right-skewed: a small number of large wins coexisted with a negative median. More trades must not be interpreted as a positive edge.

## Research interpretation

- Jupiter defines `recent` by first liquidity-pool creation, not token mint time, which matches the strategy's tradeable-age clock.
- Jupiter warns that organic score is volatile for fresh tokens. The launch preset therefore uses organic evidence for ranking/diagnostics but not as a hard entry threshold during the first minutes.
- Jupiter's organic metrics distinguish total bot-heavy activity from confirmed organic activity. Mature strategies can require them; a launch strategy should not confuse “not yet measured” with “unsafe.”
- A 100% buy share is not sufficient evidence. It often represents a tiny or one-sided sample, and published cross-chain research finds widespread wash trading and liquidity-pool price inflation among high-return meme coins.
- Competitive Solana bots share an observe/filter/build/submit/monitor pipeline; speed is only one stage. Contract checks, execution cost, position sizing, and deterministic exits remain necessary.

Primary sources:

- [Jupiter Tokens API guide](https://developers.jup.ag/docs/guides/how-to-get-token-information)
- [Jupiter on organic score and fresh-token instability](https://developers.jup.ag/blog/what-is-organic-score)
- [A Midsummer Meme's Dream: market manipulation across 34,988 meme coins](https://arxiv.org/abs/2507.01963)
- [Demystifying Solana Bots: implementation and on-chain study](https://arxiv.org/abs/2607.28424)
- [Axiom market-order execution settings](https://docs.axiom.trade/axiom/swap/market)

## v0.9 experimental launch-scout defaults

| Parameter | Default | Reason |
|---|---:|---|
| Pool age | 1.5–45 min | Avoid the least persistent first seconds while remaining launch-focused |
| Five-minute momentum | 1.5–40% | Require movement; reject extreme late vertical prints |
| 30-second momentum | 0.2–10% | Confirm local continuation after warm-up |
| Buy share | 58–92% | Positive imbalance without accepting one-sided 100% flow |
| Minimum sells | 1 | Prove that a sell path and two-sided activity exist |
| Minimum five-minute trades | 5 | Reject single-print ratios |
| Minimum distinct traders | 8 | Matches observed early-pool scale better than 50–75 |
| Minimum liquidity | $5,000 | High-risk paper floor; not a live-trading recommendation |
| Minimum five-minute volume | $1,500 | Near the observed young-pool median |
| Volume / liquidity | 0.20 | Require turnover relative to pool depth |
| Trade-sized impact | 1.5% max | Calculated at the actual paper allocation |
| Allocation | 2.5% of budget | $10 on the default $400 paper account |
| Open positions | 4 | Caps concurrent tail risk |
| Take profit | 4.5% | Above modeled round-trip cost; more realistic than 20% |
| Stop / trailing stop | 3% / 2% | Fast loss containment and profit protection |
| Maximum hold | 2 min | This is a continuation scalp, not an investment |
| Token cooldown | 5 min | Avoid immediate churn into the same mint |
| Daily paper loss limit | 2% | Stops new entries after a poor session |

The preset allows High and Med-High *paper* classifications, but it still blocks active mint/freeze authority, failed audit eligibility, excessive holder concentration, transfer tax, no sell activity, 100% buy share, invalid/stale prices, trade-sized impact above the cap, capital-limit breaches, and daily-loss locks.

## Validation limits

- The local sample is only 1.47 days and is not sufficient to claim a durable edge.
- Minute snapshots miss intra-minute path ordering and can understate gap losses.
- Disappearing tokens and unavailable routes must be treated as adverse evidence, not silently dropped from performance statistics.
- Defaults should be evaluated in the shadow lab for at least hundreds of completed exits across multiple market regimes before any live automation is considered.
