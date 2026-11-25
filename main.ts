import { LAMPORTS_PER_SOL, runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, Curve, Holding, OrderInput } from './vendor/makefun-bot.ts';

// Rally Rider, pump.fun edition: a deliberately plain launch bot. It only
// buys young curves, always with the same small stake, and lets fixed exit
// rules do the work. The aim is a smooth equity curve, not a moonshot.

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 10n; // 0.10 SOL, every entry
const TAKE_PROFIT_BPS = 12_000; // sell when estimated value reaches 120% of cost
const HARD_STOP_BPS = 9_200; // sell when estimated value falls to 92% of cost
const TRAIL_ARM_BPS = 10_200; // trailing stop arms once price is 2% above entry
const TRAIL_DROP_BPS = 9_000; // then sell after a 10% fall from the peak value
const MAX_HOLD_SLOTS = 600;
const MAX_LAUNCH_AGE_SLOTS = 600;
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 5_000;
const PRICE_SCALE = 1_000_000_000_000n;

const firstPrice = new Map<string, bigint>();
const peakPriceSeen = new Map<string, bigint>();
const entryPrice = new Map<string, bigint>();
const entrySlot = new Map<string, number>();
const peakValueBps = new Map<string, number>();
const tradedMints = new Set<string>();

function scaledPrice(curve: Curve): bigint {
  if (curve.virtual_token_reserves <= 0n) return 0n;
  return (curve.virtual_quote_reserves * PRICE_SCALE) / curve.virtual_token_reserves;
}

function priceRatioBps(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  const entry = entryPrice.get(mint);
  if (curve === undefined || entry === undefined || entry <= 0n) return 0;
  return Number((scaledPrice(curve) * 10_000n) / entry);
}

function hasPending(state: BotState, mint: string, side: 'buy' | 'sell'): boolean {
  for (const pending of state.pending.values()) {
    if (pending.order.mint === mint && pending.order.side === side) return true;
  }
  return false;
}

function rememberFills(state: BotState, batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.status !== 'filled') continue;
    if (fill.side === 'buy') {
      const tokens = BigInt(fill.token_amount);
      const curvePaid = BigInt(fill.quote_lamports) - BigInt(fill.fee_lamports) - BigInt(fill.tx_fee_lamports);
      if (tokens > 0n && curvePaid > 0n) entryPrice.set(fill.mint, (curvePaid * PRICE_SCALE) / tokens);
      entrySlot.set(fill.mint, fill.slot);
      peakValueBps.set(fill.mint, 10_000);
      tradedMints.add(fill.mint);
    } else {
      entryPrice.delete(fill.mint);
      entrySlot.delete(fill.mint);
      peakValueBps.delete(fill.mint);
    }
  }
}

function observePrices(state: BotState): void {
  for (const curve of state.curves.values()) {
    if (curve.created_slot === null) continue;
    const price = scaledPrice(curve);
    if (price <= 0n) continue;
    if (!firstPrice.has(curve.mint)) firstPrice.set(curve.mint, price);
    const peak = peakPriceSeen.get(curve.mint);
    if (peak === undefined || price > peak) peakPriceSeen.set(curve.mint, price);
  }
}

function planExits(state: BotState, orders: OrderInput[]): void {
  for (const [mint, holding] of state.positions) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) return;
    if (hasPending(state, mint, 'sell')) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const valueBps = priceRatioBps(state, mint);
    const peak = Math.max(peakValueBps.get(mint) ?? 10_000, valueBps);
    peakValueBps.set(mint, peak);
    const heldSlots = state.slot - (entrySlot.get(mint) ?? state.slot);
    const trailingHit = peak >= TRAIL_ARM_BPS && valueBps * 10_000 <= peak * TRAIL_DROP_BPS;
    if (valueBps >= TAKE_PROFIT_BPS || valueBps <= HARD_STOP_BPS || trailingHit || heldSlots >= MAX_HOLD_SLOTS) {
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }
  }
}

function launchCandidate(state: BotState, curve: Curve): boolean {
  if (curve.complete || curve.created_slot === null) return false;
  const age = state.slot - curve.created_slot;
  if (age < 80 || age > MAX_LAUNCH_AGE_SLOTS) return false;
  if (curve.trades < 25) return false;
  if (tradedMints.has(curve.mint)) return false;
  if (state.positions.has(curve.mint) || hasPending(state, curve.mint, 'buy')) return false;
  if (state.maxBuyLamports(curve.mint) < STAKE_LAMPORTS) return false;
  const price = scaledPrice(curve);
  const launch = firstPrice.get(curve.mint);
  const peak = peakPriceSeen.get(curve.mint);
  if (price <= 0n || launch === undefined || peak === undefined) return false;
  if (price * 10n < launch * 14n) return false; // demand has not confirmed the launch yet
  if (price > launch * 3n) return false; // the launch move is mostly over
  if (price * 100n < peak * 98n) return false; // buy strength, not a dip off the peak
  return true;
}

function planEntries(state: BotState, orders: OrderInput[]): void {
  const orderCap = state.hello.caps.max_orders_per_batch;
  const positionCap = state.hello.caps.max_open_positions;
  let plannedBuys = 0;
  for (const curve of state.curves.values()) {
    if (orders.length >= orderCap) return;
    if (state.committedPositionCount() + plannedBuys >= positionCap) return;
    if (state.freeCashLamports() - (STAKE_LAMPORTS + state.txFeeLamports()) * BigInt(plannedBuys) < STAKE_LAMPORTS + state.txFeeLamports()) return;
    if (!launchCandidate(state, curve)) continue;
    orders.push({ side: 'buy', mint: curve.mint, quote_lamports: STAKE_LAMPORTS, max_slippage_bps: BUY_SLIPPAGE_BPS });
    plannedBuys += 1;
  }
}

await runBot({
  onBatch(state, batch) {
    rememberFills(state, batch);
    observePrices(state);
    const orders: OrderInput[] = [];
    planExits(state, orders);
    planEntries(state, orders);
    return orders;
  },
});
