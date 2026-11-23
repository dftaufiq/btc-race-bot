// btc-race-bot: a slow trend bot for the make.fun cbBTC 24h race (bars-replay/v1).
//
// Idea: the race window is one unseen day of BTC. A bot that chases every 1-minute
// wiggle dies on fees (a full-size round trip costs ~26-34 bps; the kit's own
// EMA(8/21) baseline lost $114.83 on the dev window with 76 trades). A bot that
// just buys and holds wins the dev window (+$32.17) but loses just as much when
// the window falls (mirrored dev window: -$38.39). So this bot trades rarely and
// only on a confirmed multi-hour trend:
//
//   - Two EMAs over 1-minute closes, EMA(60) vs EMA(120), seeded as the mean of
//     their first span of closes. A buy needs the fast EMA above the slow one by
//     more than 10 bps of the price, three bars in a row, with the price above a
//     slow EMA(240) (warm-started at the first close, so it is usable from bar 0).
//   - First entry is half the cash. The rest is added only once the position is
//     up 0.8% over its cost and the fast EMA is still above the slow one: the
//     trend has to prove itself before the bot is fully invested. That halves the
//     cost of a false start in a flat or falling market.
//   - Exit the whole position when the fast EMA falls more than 25 bps under the
//     slow one for two bars in a row, or when the position is worth 2.5% under
//     its cost (hard stop). No trailing stop: on the dev window it only added
//     whipsaw exits. After any exit, 240 bars of cooldown.
//   - Re-entry after a trade needs a stronger signal (gap over 20 bps, price
//     0.5% above the slow EMA(240)), again at half size, so a choppy market
//     cannot churn the bot.
//   - Guardrail probe: if no order has ever filled by bar 1200, buy $50 once,
//     so the entry still meets the "at least 1 trade" bar on a window where the
//     trend never confirms (e.g. a steady decline). A $50 probe can lose at
//     most a couple of dollars at the final flatten.
//
// Everything is deterministic: float64 arithmetic on closes only (+ - * /),
// no clock, no randomness, no environment, no network. Two runs on the same
// bars give the same orders byte for byte. Amounts are bigints; every order
// caps its slippage at 100 bps past the latest close.
//
// Local dev-window result (kit grade-local, --driver process): net PnL
// +$27.36, 2 trades, max drawdown 2.0% (buy-and-hold +$32.17 / momentum
// +$34.94 on the same window; the bot gives up a little upside to buy
// downside protection: mirrored dev window -$11.24 vs buy-and-hold -$38.39).

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 60;
const SLOW_SPAN = 120;
const LONG_SPAN = 240;
const CONFIRM_BARS = 3;
const ENTRY_GAP_BPS = 10;
const REENTRY_GAP_BPS = 20;
const REENTRY_MARGIN_BPS = 50;
const EXIT_GAP_BPS = 25;
const EXIT_CONFIRM_BARS = 2;
const STOP_BPS = 250;
const ADD_TRIGGER_BPS = 80;
const COOLDOWN_BARS = 240;
const PROBE_BAR = 1200;
const PROBE_NOTIONAL = 50_000_000n; // $50 in quote units (1e6 per USDC)
const MAX_SLIPPAGE_BPS = 100;

/** An EMA seeded as the mean of its first span of closes; null until seeded. */
class SeededEma {
  private readonly span: number;
  private readonly k: number;
  private warm: number[] = [];
  private value: number | null = null;

  constructor(span: number) {
    this.span = span;
    this.k = 2 / (span + 1);
  }

  push(close: number): number | null {
    if (this.value !== null) {
      this.value += this.k * (close - this.value);
      return this.value;
    }
    this.warm.push(close);
    if (this.warm.length === this.span) {
      let sum = 0;
      for (const x of this.warm) sum += x;
      this.value = sum / this.span;
    }
    return this.value;
  }
}

/** An EMA seeded at the first close it sees, so it is usable from bar 0. */
class WarmStartEma {
  private readonly k: number;
  private value: number | null = null;

  constructor(span: number) {
    this.k = 2 / (span + 1);
  }

  push(close: number): number {
    if (this.value === null) {
      this.value = close;
      return this.value;
    }
    this.value += this.k * (close - this.value);
    return this.value;
  }
}

const fast = new SeededEma(FAST_SPAN);
const slow = new SeededEma(SLOW_SPAN);
const long = new WarmStartEma(LONG_SPAN);

let upStreak = 0;
let downStreak = 0;
let coolLeft = 0;
let added = false;
let filledTrades = 0;

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && !fill.client_id.startsWith('_')) filledTrades += 1;
    }
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];

    const close = Number(bar.c);
    const fastValue = fast.push(close);
    const slowValue = slow.push(close);
    const longValue = long.push(close);
    if (fastValue === null || slowValue === null) return [];
    if (coolLeft > 0) coolLeft -= 1;

    const gap = fastValue - slowValue;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      // Hard stop: the position is worth 2.5% under what it cost.
      if (value * 10000n <= held.cost * BigInt(10000 - STOP_BPS)) {
        coolLeft = COOLDOWN_BARS;
        added = false;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Trend reversal: fast EMA under the slow one by 25 bps, two bars running.
      if (gap < (-close * EXIT_GAP_BPS) / 10000) downStreak += 1;
      else downStreak = 0;
      if (downStreak >= EXIT_CONFIRM_BARS) {
        coolLeft = COOLDOWN_BARS;
        downStreak = 0;
        added = false;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Pyramid: the trend proved itself, invest the rest of the cash.
      if (!added && value * 10000n >= held.cost * BigInt(10000 + ADD_TRIGGER_BPS) && gap > 0) {
        const room = state.weightRoom(SYMBOL);
        const add = state.cash < room ? state.cash : room;
        if (add >= minNotional) {
          added = true;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: add, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
        }
      }
      return [];
    }

    // Flat: enter only on a confirmed multi-hour uptrend.
    const needGap = filledTrades > 0 ? REENTRY_GAP_BPS : ENTRY_GAP_BPS;
    const needMargin = filledTrades > 0 ? REENTRY_MARGIN_BPS : 0;
    const trendingUp =
      gap > (close * needGap) / 10000 && close * 10000 > Math.trunc(longValue) * (10000 + needMargin);
    upStreak = trendingUp ? upStreak + 1 : 0;
    if (coolLeft === 0 && upStreak >= CONFIRM_BARS) {
      const room = state.weightRoom(SYMBOL);
      const half = state.cash / 2n;
      const notional = half < room ? half : room;
      if (notional >= minNotional) {
        added = false;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
      }
    }
    // Guardrail probe: never traded and the window is nearly over.
    if (state.seq >= PROBE_BAR && filledTrades === 0) {
      const notional = PROBE_NOTIONAL < state.cash ? PROBE_NOTIONAL : state.cash;
      if (notional >= minNotional) {
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
      }
    }
    return [];
  },
});
