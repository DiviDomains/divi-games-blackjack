// The status line of a blackjack hand that has ended. Pure, no DOM, so tests/sdk/bj-end-status.test.mjs can run it.
//
// The banner above says the result; this line says the next step, naming only controls the page shows once a hand is
// over: Deal in the bet form, or the wallet's Get GOLD when the bet in the form is more than the balance (funds.js).
//
// Whether the house stood for an idle player is not kept on the hand: the chain says it only in the `blackjack.action`
// event of the block that stood it (`"idle": true`), which the page sees in its live feed (idleStands below).

import { formatAmount } from '../../sdk/divigames.js';
import { betShort } from './funds.js';

const ENDED = ['finished', 'refunded', 'forfeited'];

/**
 * The status line for ended hand `h` as `me` sees it, or null while there is no hand or it is still being played (the
 * page keeps its own text for those).
 * @param {any} h the hand @param {string} me
 * @param {{gold?: bigint|null, bet?: string|null, decimals?: number, idle?: boolean, idleMs?: number}} [opts]
 *   gold is the balance in base units (null until read); bet the base units Deal would bet now (null if the form's
 *   amount does not read); idle whether the house stood this hand for its idle player, after idleMs
 * @returns {string|null}
 */
export function endStatus(h, me, { gold = null, bet = null, decimals = 2, idle = false, idleMs = 10 * 60 * 1000 } = {}) {
  if (!h || !ENDED.includes(h.status)) return null;
  // Someone else's hand, opened by its link: the banner reads as if to its player, so say whose it is, and offer nothing.
  if (!me || h.player !== me) return "This is another player's hand; the result above is theirs.";
  let next;
  if (bet == null) next = 'Press Deal with a bet of 1 to 100 GOLD for a new hand.';
  else if (betShort(gold, bet, decimals)) {
    next = `You have ${formatAmount(String(gold), decimals)} GOLD, less than the ${formatAmount(bet, decimals)} GOLD bet: press Get GOLD, then Deal.`;
  } else next = `Press Deal to play a new hand at ${formatAmount(bet, decimals)} GOLD.`;
  if (h.status === 'forfeited') return `Your stake stays in the house bankroll. ${next}`;
  if (idle) return `The house stood for you after ${Math.round(idleMs / 60000)} minutes without a move. ${next}`;
  return next;
}

/**
 * The hands a block's `blackjack.action` events say the house stood for their idle players.
 * @param {any} block a block from the live feed @returns {string[]}
 */
export function idleStands(block) {
  const ids = [];
  for (const r of block?.receipts ?? []) {
    for (const ev of r?.events ?? []) {
      const d = ev?.data;
      if (ev?.kind === 'blackjack.action' && d?.kind === 'stand' && d?.idle === true && d?.hand != null) ids.push(String(d.hand));
    }
  }
  return ids;
}
