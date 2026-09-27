# Following the automatic paper trades

Version 0.10.8 adds **Follow paper trades** as a live entry source. It receives new automatic BUY and SELL events from the main paper engine after the owner starts the live session. It does not replay the paper ledger or copy manual, demo or shadow trades.

The paper event selects the token. The live wallet still controls the amount and execution: the current maximum is $5 per buy, with the existing daily caps, position limit, slippage and impact limits. Each real order needs a quote, native token validation, sell-route preflight, transaction simulation and confirmation. Paper prices, quantities and profits are not real fills.

The configured live liquidity minimum remains $20,000 unless the owner chooses otherwise. The paper strategy currently permits $5,000. The effective live minimum is the greater of the paper and live minimums, so a paper BUY below $20,000 will still be skipped.

In this mode, native validation uses the captured paper pool-age, holder and activity criteria, with fresh provider and native receipt timestamps. The separate guarded-discovery requirements for 24-hour pool age and five minutes of liquidity history apply only to **Guarded discovery**. Authority, transfer-fee, approved risk level and wallet execution checks apply in both modes. Following young paper launches therefore removes the extra mature-pool protection; it cannot eliminate rugs or ensure a successful exit.

BUY events retain their original timestamp and expire after 75 seconds. A session nonce and paper-reset epoch prevent old trade IDs from being reused. An event is consumed before execution is requested, so an uncertain response cannot cause a second BUY. Pending orders are reconciled from the native journal.

An automatic paper SELL cancels an unsent matching BUY. If the BUY has already been submitted, its sell signal is retained while confirmation is pending and targets only the corresponding managed live position. Existing live exit checks remain active for live positions, including positions carried into another session; those checks can also exit earlier than paper when actual fill prices differ.

Pausing entries discards queued BUY events and preserves exit management. Changing the captured paper entry criteria pauses new live entries until the session is stopped and restarted. Paper reset does not liquidate live holdings. Stopping or restarting the app ends live signing; the owner must review and start the next session.

Validation covers guarded-mode compatibility, young paper signals, liquidity differences, duplicate and stale events, pending confirmations, exact-position sells, pause/reset/session boundaries and unchanged execution limits. Installation does not arm the wallet or place a trade.
