// Create-slot surge scalper.
//
// Plain-English rules, implemented exactly as written in the design brief:
//  1. Watch every new coin from its creation event and track its real SOL reserve.
//  2. Buy only when a coin's real SOL reserve is above 20 SOL at the end of the
//     very slot it was created in. A coin that crosses 20 SOL in any later slot
//     is skipped forever. Never buy the same coin twice.
//  3. Spend the same small fixed stake on every buy (0.05 SOL), never more than
//     the harness per-order size cap, never more open positions than allowed,
//     never buy when cash cannot cover the stake.
//  4. For every open position, every slot: sell everything when its marked value
//     is 10% above what was paid (take profit) or 10% below what was paid
//     (stop loss), whichever comes first. If neither has hit after 100 slots
//     since the buy was decided, sell everything anyway.
//  5. A curve that completes is closed by the harness; treat it as an exit.
//  6. Never average down, never short, never use leverage, never re-enter a
//     coin that has been exited.
//
// Determinism: every decision is a pure function of the batches seen so far.
// No clock, no environment, no randomness.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

/** Fixed stake per buy: 0.05 SOL, in lamports. */
export const STAKE_LAMPORTS = 50_000_000n;
/** Entry trigger: real SOL reserve must be above this in the create slot. */
export const TRIGGER_REAL_SOL_LAMPORTS = 20_000_000_000n;
/** Take profit: marked value at or above 110% of cost. */
const TAKE_PROFIT_NUM = 110n;
const TAKE_PROFIT_DEN = 100n;
/** Stop loss: marked value at or below 90% of cost. */
const STOP_LOSS_NUM = 90n;
const STOP_LOSS_DEN = 100n;
/** Maximum hold, in slots since the buy was decided. */
export const MAX_HOLD_SLOTS = 100;
/** Slippage tolerance on every order, in basis points. */
const MAX_SLIPPAGE_BPS = 500;

interface OpenTrade {
  /** Slot the buy order was decided on. */
  entrySlot: number;
}

/**
 * Build the bot object the wire shim drives: one onBatch call per slot,
 * returning the orders decided on that slot.
 */
export function createBot() {
  // Coins ever bought (decided), so no coin is ever entered twice.
  const everBought = new Set<string>();
  // Coins with a live position (or a buy still pending), with entry slot.
  const open = new Map<string, OpenTrade>();

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // Prune bookkeeping for positions the harness has closed (curve
    // completed, replay flattened, or a sell filled). The coin stays in
    // everBought, so it is never re-entered.
    for (const mint of [...open.keys()]) {
      const stillHeld = state.positions.has(mint);
      const buyPending = [...state.pending.values()].some(
        (p) => p.order.mint === mint && p.order.side === 'buy',
      );
      if (!stillHeld && !buyPending) open.delete(mint);
    }

    // --- Exits first: every open position, checked every slot. ---
    for (const [mint, holding] of state.positions) {
      let trade = open.get(mint);
      // Safety net: a position seen without an entry record (for example a
      // buy whose decision batch was replayed) still gets a hold clock, so
      // the maximum-hold exit can always fire instead of never firing.
      if (trade === undefined) {
        trade = { entrySlot: batch.slot };
        open.set(mint, trade);
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      // Never send a second sell while one is already pending on this mint.
      const sellPending = [...state.pending.values()].some(
        (p) => p.order.mint === mint && p.order.side === 'sell',
      );
      if (sellPending) continue;
      if (holding.token_amount <= 0n || holding.cost_lamports <= 0n) continue;
      if (curve.virtual_token_reserves <= 0n) continue;

      // Marked value of the whole position at the latest virtual reserves.
      const value =
        (holding.token_amount * curve.virtual_quote_reserves) /
        curve.virtual_token_reserves;
      const cost = holding.cost_lamports;
      const takeProfit = value * TAKE_PROFIT_DEN >= cost * TAKE_PROFIT_NUM;
      const stopLoss = value * STOP_LOSS_DEN <= cost * STOP_LOSS_NUM;
      const tooOld = batch.slot - trade.entrySlot >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || tooOld) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    // --- Entries: only coins created in this very slot. ---
    for (const curve of state.curves.values()) {
      if (curve.created_slot === null) continue;
      if (curve.created_slot !== batch.slot) continue;
      if (curve.complete) continue;
      if (curve.real_quote_reserves <= TRIGGER_REAL_SOL_LAMPORTS) continue;
      const mint = curve.mint;
      if (everBought.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      const buyPending = [...state.pending.values()].some(
        (p) => p.order.mint === mint && p.order.side === 'buy',
      );
      if (buyPending) continue;
      // Caps: at most max_open_positions committed, stake within the
      // per-order size cap for this mint, and cash to cover the stake.
      if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) continue;
      if (STAKE_LAMPORTS > state.maxBuyLamports(mint)) continue;
      const txFee = state.txFeeLamports();
      const alreadyCommitted = orders
        .filter((o) => o.side === 'buy')
        .reduce((sum, o) => sum + BigInt(o.quote_lamports), 0n);
      if (state.freeCashLamports() - alreadyCommitted - txFee < STAKE_LAMPORTS) continue;

      orders.push({
        side: 'buy',
        mint,
        quote_lamports: STAKE_LAMPORTS,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      everBought.add(mint);
      open.set(mint, { entrySlot: batch.slot });
    }

    return orders;
  }

  return { onBatch };
}
