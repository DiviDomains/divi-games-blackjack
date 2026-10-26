// The blackjack bet pre-check: whether the GOLD the page last read covers a bet, so a player with too little is told
// so (and pointed to Get GOLD) before anything is signed. Pure functions, no DOM.

import { formatAmount } from '../../sdk/divigames.js';

/**
 * What to say when `gold` (base units; null while not read yet) does not cover a bet of `amount` base units, or ''
 * when it does or the balance is not known (then the chain decides, and its refusal reads in GOLD by readableError).
 * @param {bigint|null} gold @param {string} amount @param {number} decimals
 */
export function betShort(gold, amount, decimals) {
  if (gold == null || gold >= BigInt(amount)) return '';
  return `Not enough GOLD: this bet is ${formatAmount(amount, decimals)} GOLD and you have ${formatAmount(String(gold), decimals)} GOLD. Press Get GOLD for free testnet GOLD, then Deal.`;
}
