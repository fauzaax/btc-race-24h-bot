// Trend rider for cbBTC 1-minute bars, long only.
//
// Rules (one symbol, one position, whole-position entries and exits):
//   - EMA(30) and EMA(60) over closes, each seeded as the mean of its first
//     span of closes, then moving 2 / (span + 1) of the way to each new close
//     (the baselines' convention). A batch with no bar for the symbol adds
//     nothing. Slope is the slow EMA now versus 10 bars ago, in basis points.
//   - Entry, on a bar's close (filled at the next open): the fast EMA sits
//     more than 10 bps above the slow EMA and the slow EMA rose more than
//     5 bps over the last 10 bars. Buy with all cash. The thresholds are
//     deliberately strict: 1-minute breakouts are mostly noise, and a full
//     round trip costs ~26 bps, so the bot only chases a move that is
//     already strong and still accelerating.
//   - Exit, the whole position: the fast EMA falls back to or below the slow
//     EMA, or the slow EMA falls more than 5 bps over 10 bars. Either means
//     the trend that justified the entry is gone; the bot takes what is left
//     rather than riding the reversal.
//   - Late probe: if no order has filled by 22 hours into the window, buy
//     10% of cash once (retried while unfilled). A quiet window must still
//     leave the entry with a trade on the board; the size keeps the cost of
//     the insurance near nothing. The probe never fires while holding.
//   - Every order caps slippage at 100 bps past the close it was decided on.
//   - No orders during a warm-up (the replay would reject them); the EMAs
//     still read those bars.
//
// Determinism: float64 arithmetic on + - * / only, no randomness, no clock,
// no environment, no files. The same bars give the same orders, run after run.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 30;
const SLOW_BARS = 60;
const SLOPE_BARS = 10;
/** Entry needs the fast EMA this far above the slow one, in bps of the slow EMA. */
const ENTRY_GAP_BPS = 10;
/** Entry needs the slow EMA up this much over SLOPE_BARS bars, in bps; exit on the mirror fall. */
const SLOPE_BPS = 5;
const MAX_SLIPPAGE_BPS = 100;
/** The late probe fires once 22 hours of bars have closed with no fill. */
const PROBE_AFTER_MS = 22 * 60 * 60 * 1000;
/** The probe spends this share of cash, in bps. */
const PROBE_BPS = 1000;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

const fast: Ema = { span: FAST_BARS, warm: [], value: null };
const slow: Ema = { span: SLOW_BARS, warm: [], value: null };
/** The slow EMA's value after each bar that set it, oldest first. */
const slowHistory: number[] = [];
let filledOrders = 0;

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && !fill.client_id.startsWith('_')) filledOrders++;
    }
    const bar = batch.bars.find((b) => b.symbol === 'CBBTC');
    if (bar === undefined) return [];
    const close = Number(bar.c);
    step(fast, close);
    step(slow, close);
    if (slow.value !== null) slowHistory.push(slow.value);
    if (state.warmingUp) return [];

    const held = state.positions.get('CBBTC');
    const orders: (BuyInput | SellInput)[] = [];
    if (fast.value !== null && slow.value !== null && slowHistory.length > SLOPE_BARS) {
      const gapBps = ((fast.value - slow.value) / slow.value) * 10_000;
      const slopeBps = ((slow.value - slowHistory[slowHistory.length - 1 - SLOPE_BARS]!) / slowHistory[slowHistory.length - 1 - SLOPE_BARS]!) * 10_000;
      if (held !== undefined) {
        if (gapBps <= 0 || slopeBps < -SLOPE_BPS) {
          orders.push({ side: 'sell', symbol: 'CBBTC', qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else if (gapBps > ENTRY_GAP_BPS && slopeBps > SLOPE_BPS) {
        const cash = state.cash;
        if (cash >= BigInt(state.hello.fees.min_notional_quote_units)) {
          orders.push({ side: 'buy', symbol: 'CBBTC', notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }

    // Late probe: a quiet window must still leave a trade on the board.
    if (orders.length === 0 && held === undefined && filledOrders === 0 && batch.t - state.hello.first_close_ms >= PROBE_AFTER_MS) {
      const stake = (state.cash * BigInt(PROBE_BPS)) / 10_000n;
      if (stake >= BigInt(state.hello.fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol: 'CBBTC', notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    return orders;
  },
});
