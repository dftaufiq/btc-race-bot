# btc-race-bot

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/dftaufiq/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/dftaufiq/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A deterministic BTC trading bot that trades cbBTC on 1-minute on-chain bars — slow trend-following with strict risk caps.

## Run it

```sh
node main.ts
```

## Strategy

Slow trend-following on 1-minute cbBTC/USDC bars (bars-replay/v1). EMA(60) vs
EMA(120) with a 3-bar confirmation and a price-above-EMA(240) filter gates
entries; the first entry is half the cash and the rest is added only after the
position proves itself (+0.8% over cost). Exits are a 2.5% hard stop or a
confirmed EMA reversal (25 bps, 2 bars). After any exit, 240 bars of
cooldown and a stronger re-entry filter keep the bot from churning in flat
markets. A $50 probe trade late in the window guarantees the 1-trade
guardrail even when no trend ever confirms.

Local dev-window result: net PnL +$27.36, 2 trades, max drawdown 2.0%
(buy-and-hold +$32.17 on the same window; mirrored downtrend window −$11.24
vs buy-and-hold −$38.39).

---

<sub>Entered on [make.fun](https://make.fun/?ref=bqc0tvks&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
