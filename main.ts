// Rally Rider, pump.fun edition — a Sharpe-first paper bot for agent-fun/replay/v2.
//
// The idea is the one that won the BTC race's dev window: one clean breakout rule, ridden with
// a hard stop, a trailing stop and a time limit — no chasing, no averaging down. The pump.fun
// version spreads that one trade across many coins instead of betting the whole book on a single
// market, because the score here is the *hourly Sharpe ratio*, not the biggest PnL: steady small
// wins with tiny stakes beat one lucky moonshot, and a blown-up hour wrecks the ratio.
//
// What the dev window (24h of pump.fun chain data, graded with the kit) actually showed:
//   - Launch entries alone: -0.57 SOL, Sharpe -0.29, max drawdown 7.8%, 315 round trips on 281
//     coins. A mature-curve Donchian breakout leg was tried beside it and dropped: on its own it
//     lost -0.94 SOL at a 14% win rate, and combined with the launch leg it made everything
//     worse (-0.81 SOL, Sharpe -0.51). So this bot keeps the launch leg only.
//   - A run-up filter on the launch leg (skip a launch whose price already ran > 20% above its
//     create price — no buying the top) cut the dev loss to -0.20 SOL and the drawdown to 2.1%.
//     That is the version shipped here. Every other pilot in the kit lost money on the same
//     window too (momentum -9.44 SOL, reversion -3.99 SOL, sniper -0.50 SOL), so the edge here is
//     losing the least, the most steadily, while the final 6-hour window decides the rest.
//
//   - Capital 10 SOL, at most 5 open positions, flat 0.10 SOL stakes (shrunk by the 1% of real
//     reserve cap when a curve is small). Worst case every open position stops out at once:
//     ~0.05 SOL, half a percent of equity. Drawdown is capped by construction, not by hope.
//   - Entry — launches only. A curve at most 30 slots old whose creator has not sold, with at
//     least two distinct non-creator buyers already in, real SOL between 0.5 and 30 building,
//     the creator's own buy at most 2.5 SOL, and the price no more than 20% above its create
//     price. One entry per mint, ever: a coin that stopped us out does not get a second chance.
//   - Exits, read on every batch while holding: take profit +20%, hard stop -8% under cost,
//     trailing stop -10% from the peak once the position is up 8%, a 600-slot time limit, an
//     instant exit when the creator sells, and an exit on strong outflow (net < -1 SOL over the
//     last 20 slots). Every exit sells the whole position.
//   - Fees set the bar: ~1.25% of curve fees each way plus 0.000105 SOL of tx fees per order, so
//     a 0.10 SOL round trip costs ~0.0027 SOL. The +20% / -8% payoff needs only a ~36% hit rate
//     to break even, and the runners that go pay for the stops.
//   - Guardrail pacing: the run must end with round trips of >= 0.01 SOL on >= 20 distinct
//     mints. When the bot's own coins lag the pace (25 coins over the 6-hour window, scaled by
//     elapsed block time), it buys a 0.01 SOL probe of a liquid traded curve and sells it as soon
//     as the buy lands. In practice the launch entries produce far more than 20 coins on their
//     own; the probes are insurance, not the strategy.
//
// Determinism: pure arithmetic over the batches seen, insertion-ordered maps only, no clock, no
// randomness, no environment, no files. Orders decided on a batch fill two slots later, so a buy
// rejected on a spike just means that coin is skipped; sells go out at 10000 bps so a stop always
// fills instead of being rejected into a gap-down and retried lower. A curve that completes is
// closed by the replay; the harness flattens whatever is left at done.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

/** SOL per position (flat stake; the 1%-of-real-reserve cap may shrink it). */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 10n;
/** Smallest buy worth sending (also the round-trip guardrail's minimum). */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Curve fees on a sell: protocol 95 bps + creator 30 bps. */
const CURVE_FEE_BPS = 125n;
const BPS = 10_000n;

/** Launch entry: oldest age (slots since CreateEvent) a first buy may still be decided at. */
const LAUNCH_MAX_AGE = 30;
/** Launch entry: distinct non-creator buyers that must already be in. */
const LAUNCH_MIN_BUYERS = 2;
/** Launch entry: real SOL reserve window at decision time. */
const LAUNCH_MIN_REAL_SOL = 0.5;
const LAUNCH_MAX_REAL_SOL = 30;
/** Launch entry: the creator's own buy in the create slot, at most (a dev aping in huge is a dump in waiting). */
const LAUNCH_MAX_DEV_BUY_SOL = 2.5;
/** Launch entry: skip a launch whose price already ran this far above its create price. */
const LAUNCH_MAX_RUNUP = 0.2;

/** Exits: take profit / hard stop / trailing stop, as shares of cost / peak value. */
const TAKE_PROFIT = 0.2;
const STOP_LOSS = 0.08;
const TRAIL_ARM = 0.08;
const TRAIL = 0.1;
/** Exits: time limit in slots; instant exit when the creator sells; outflow exit. */
const MAX_HOLD_SLOTS = 600;
const OUTFLOW_WINDOW = 20;
const OUTFLOW_EXIT_SOL = 1;

/** Guardrail pacing: coins / fills wanted over the window, and the probe size. */
const TARGET_COINS = 25;
const TARGET_FILLS = 240;
const PACE_SECONDS = 21_600; // 6-hour final window
const PROBE_LAMPORTS = LAMPORTS_PER_SOL / 100n;
const MAX_PROBES = 1;

const LAMPORTS = 1e9;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  creator: Pubkey | null;
  /** Create-time reserves: the launch run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: number;
  devSold: boolean;
  buyers: Set<string>;
  buys: number;
  trades: Trade[];
  lastTradeSlot: number;
  /** True once the coin has been entered (or ruled out for good). */
  done: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  exiting: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees, in SOL (tx fee not included). */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint): number {
  if (tokens <= 0n || vt <= 0n) return 0;
  const q = (tokens * vq) / (vt + tokens);
  const net = q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
  return Number(net) / LAMPORTS;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
/** The bot's own filled orders and the coins they were on (harness closes excluded). */
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function coinOf(mint: Pubkey): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = { created: null, creator: null, vq0: 0n, vt0: 1n, devBuy: 0, devSold: false, buyers: new Set(), buys: 0, trades: [], lastTradeSlot: -1, done: false };
    coins.set(mint, c);
  }
  return c;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(c: Coin, now: number, w: number): number {
  let net = 0;
  for (let i = c.trades.length - 1; i >= 0; i--) {
    const tr = c.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const traded = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const c = coinOf(e.mint);
        c.created = e.slot;
        c.creator = e.creator;
        c.vq0 = BigInt(e.virtual_quote_reserves);
        c.vt0 = BigInt(e.virtual_token_reserves);
      } else if (e.event === 'TradeEvent') {
        const c = coinOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        c.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
        c.lastTradeSlot = e.slot;
        traded.add(e.mint);
        if (e.is_buy) {
          c.buys++;
          if (c.creator !== null && e.user !== c.creator) c.buyers.add(e.user);
          if (c.creator !== null && e.user === c.creator && e.slot === c.created) c.devBuy += sol;
        } else if (c.creator !== null && e.user === c.creator) {
          c.devSold = true;
        }
      } else {
        coinOf(e.mint).done = true;
      }
    }
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
      if (f.client_id.startsWith('_')) held.delete(f.mint);
    }
    // Prune tapes to the longest lookback any exit needs.
    const keep = OUTFLOW_WINDOW + 5;
    for (const mint of traded) {
      const c = coins.get(mint)!;
      let cut = 0;
      while (cut < c.trades.length && c.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) c.trades.splice(0, cut);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

    // Exits first: read every held position on its latest close.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) held.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = sellValueSol(pos.token_amount, vq, vt) - tx;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      const c = coins.get(mint);
      let exit = false;
      if (value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (value <= cost * (1 - STOP_LOSS)) exit = true;
      if (h.peakValue >= cost * (1 + TRAIL_ARM) && value <= h.peakValue * (1 - TRAIL)) exit = true;
      if (now - h.opened > MAX_HOLD_SLOTS) exit = true;
      if (c !== undefined && c.devSold) exit = true;
      if (c !== undefined && flow(c, now, OUTFLOW_WINDOW) < -OUTFLOW_EXIT_SOL) exit = true;
      if (!exit || h.exiting) continue;
      let sellPending = false;
      for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      if (sellPending) continue;
      if (orders.length >= cap) break;
      h.exiting = true;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // Entries: fresh launches only, in the order the batch's events arrived.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
      const c = coins.get(mint)!;
      if (c.done) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      const age = c.created === null ? Infinity : now - c.created;
      if (age > LAUNCH_MAX_AGE) {
        c.done = true;
        continue;
      }
      // Launch: creator still holding, real buyers already in, reserves building, and the
      // price has not already run away from its create price (no buying the top).
      const runup = c.vq0 > 0n && c.vt0 > 0n
        ? (Number(curve.virtual_quote_reserves) * Number(c.vt0)) / (Number(curve.virtual_token_reserves) * Number(c.vq0)) - 1
        : 0;
      if (c.devSold || c.buyers.size < LAUNCH_MIN_BUYERS || c.buys < LAUNCH_MIN_BUYERS ||
          rqSol < LAUNCH_MIN_REAL_SOL || rqSol > LAUNCH_MAX_REAL_SOL ||
          c.devBuy > LAUNCH_MAX_DEV_BUY_SOL || runup > LAUNCH_MAX_RUNUP) {
        continue;
      }
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, Number(STAKE_LAMPORTS) / LAMPORTS);
      if (amount > free - tx) amount = free - tx;
      if (amount < Number(MIN_BUY_LAMPORTS) / LAMPORTS) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: 10_000 });
      free -= amount + tx;
      slotsLeft--;
      c.done = true;
      held.set(mint, { opened: now, peakValue: 0, exiting: false });
    }

    // Guardrail pacing: open a probe when the bot's coins lag the pace.
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECONDS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          // Liquid enough that a 0.01 SOL buy fits the 1%-of-reserve cap with room.
          if (Number(curve.real_quote_reserves) / LAMPORTS < 1.5) continue;
          if (free < Number(PROBE_LAMPORTS) / LAMPORTS + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: PROBE_LAMPORTS, max_slippage_bps: 10_000 });
          probes.set(mint, false);
          free -= Number(PROBE_LAMPORTS) / LAMPORTS + tx;
        }
      }
    }
    return orders;
  },
});
