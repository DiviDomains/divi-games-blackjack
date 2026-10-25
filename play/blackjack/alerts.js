// Hand alerts for blackjack: what the tab title and the alert text say for a hand and a viewer. Every action waits on
// the house, so a player who has switched tabs needs to be told when the hand is back on them. Pure functions, no DOM,
// so tests/sdk/bj-alert.test.mjs can run them. The "Tell me when it's my move" toggle shares notifyPlan with tic-tac-toe.

import { handDeadline } from '../deadlines.js';

export { notifyPlan } from '../notify.js';

export const BASE_TITLE = 'Blackjack · DiviGames';
/** The page calls it urgent when the player has this long (or less) before the house stands the hand for them. */
export const URGENT_MS = 60_000;

const NAME = 'Blackjack';
const t = (/** @type {string} */ lead) => `${lead} · ${NAME}`;

/**
 * @typedef {'none'|'waiting'|'your-move'|'house-late'|'won'|'lost'|'push'|'blackjack'|'refunded'} Kind
 * @typedef {{kind: Kind, title: string, text: string, urgent: boolean, secondsLeft: number|null}} Alert
 */

/**
 * The alert for hand `h` as seen by address `me`.
 * @param {any} h a hand from the chain, or null
 * @param {string} me
 * @param {{now?: number, rules: ReturnType<typeof import('../deadlines.js').bjRules>, sawLive?: boolean, refundDueMs?: number|null, heightLate?: boolean}} o
 *   `rules`: blackjack's idle rules (deadlines.js). `sawLive`: this page saw the hand live, so its end is news (a hand
 *   that was over when the page looked keeps the base title). `refundDueMs`: when the house is late on a waiting hand,
 *   or null while that runs on block height; `heightLate`: the house is late by block height.
 * @returns {Alert}
 */
export function handAlert(h, me, { now = Date.now(), rules, sawLive = false, refundDueMs = null, heightLate = false }) {
  /** @type {(kind: Kind, title: string, text?: string, urgent?: boolean, secondsLeft?: number|null) => Alert} */
  const out = (kind, title, text = '', urgent = false, secondsLeft = null) => ({ kind, title, text, urgent, secondsLeft });
  const none = out('none', BASE_TITLE);
  if (!h || !me || h.player !== me) return none;

  if (h.status === 'waiting') {
    const late = heightLate || (refundDueMs != null && now >= refundDueMs);
    if (!late) return out('waiting', t('Waiting for the house'), 'Waiting for the house to reveal the next link.');
    return now >= rules.v2From
      ? out('house-late', t('⚠ House is late: claim your payout'), 'The house is late: you can claim the best result your hand could have had.')
      : out('house-late', t('⚠ House is late: take your stake back'), 'The house is late: you can take your stake back.');
  }

  if (h.status === 'playing') {
    const d = handDeadline(h, rules);
    const left = d.ms == null ? null : d.ms - now;
    const then = d.stands ? 'the house stands for you' : 'your stake goes to the house';
    if (left != null && left <= URGENT_MS) {
      if (left <= 0) return out('your-move', t('⚠ Your move, time is up'), `Your time is up: ${d.stands ? 'the house can stand for you now' : 'your stake can go to the house now'}.`, true, 0);
      const secs = Math.ceil(left / 1000);
      return out('your-move', t(`⚠ Your move, ${secs}s left`), `Your move: ${secs} second${secs === 1 ? '' : 's'} left before ${then}.`, true, secs);
    }
    return out('your-move', t('● Your move'), 'It is your move: hit, stand or double.');
  }

  // Over: news only to a page that watched it end.
  if (!sawLive) return none;
  if (h.status === 'refunded') return out('refunded', t('↩ Refunded'), 'Your stake was refunded.');
  if (h.status === 'forfeited') return out('lost', t('✗ You lost'), 'The hand was abandoned; the stake went to the house.');
  switch (h.result) {
    case 'blackjack': return out('blackjack', t('★ Blackjack!'), 'Blackjack! Your hand was paid 3:2.');
    case 'win': return out('won', t('✓ You won'), 'You won the hand.');
    case 'house_timeout': return out('won', t('✓ You won'), 'The house missed its turn, so your hand was paid its best result.');
    case 'lose': return out('lost', t('✗ You lost'), 'The dealer won the hand.');
    case 'bust': return out('lost', t('✗ Bust'), 'You lost the hand: bust.');
    case 'push': return out('push', t('= Push'), 'Push: your stake was returned.');
    default: return none;
  }
}

const NEWS = new Set(['your-move', 'house-late', 'won', 'lost', 'push', 'blackjack', 'refunded']);

/**
 * Whether going from `prevKind` to `kind` is worth a notification: the hand came back to the player, the house is
 * late, or the hand ended. `prevKind` is undefined on the first look, which is never news; every block re-renders the
 * hand, so staying in a state is not news either.
 * @param {Kind|undefined} prevKind @param {Kind} kind
 */
export function shouldNotify(prevKind, kind) {
  if (prevKind === undefined || prevKind === kind) return false;
  return NEWS.has(kind);
}
