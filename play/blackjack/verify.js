// Recompute a blackjack hand from what the chain published, with no trust in the node.
// Mirrors `draw_card` in crates/dg-games/src/blackjack.rs exactly:
//   digest = sha256(preimage || utf8(seed) || utf8(hand_id) || u32_be(card_index))
//   card   = undealt[u32_be(digest[0..4]) % undealt.len()]   (undealt = ascending cards not yet dealt)
// and checks every preimage hashes `pos` times to the committed anchor.

import { sha256, bytesToHex } from '../../sdk/divigames.js';

const enc = new TextEncoder();

/** @param {string} hex @returns {Uint8Array} */
export function hexToBytes(hex) {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('not hex');
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/** The card dealt at `index`, given the cards already dealt in this hand. */
export function drawCard(/** @type {Uint8Array} */ preimage, /** @type {string} */ seed, /** @type {string} */ handId, /** @type {number} */ index, /** @type {number[]} */ dealt) {
  const s = enc.encode(seed);
  const h = enc.encode(handId);
  const buf = new Uint8Array(preimage.length + s.length + h.length + 4);
  buf.set(preimage, 0);
  buf.set(s, preimage.length);
  buf.set(h, preimage.length + s.length);
  new DataView(buf.buffer).setUint32(preimage.length + s.length + h.length, index, false);
  const d = sha256(buf);
  const r = new DataView(d.buffer, d.byteOffset).getUint32(0, false);
  const undealt = [];
  for (let c = 0; c < 52; c++) if (!dealt.includes(c)) undealt.push(c);
  return undealt.length ? undealt[r % undealt.length] : null;
}

/** Hash `preimage` `times` times and compare with `anchor`. */
export function linksToAnchor(/** @type {string} */ preimageHex, /** @type {number} */ times, /** @type {string} */ anchorHex) {
  let x = hexToBytes(preimageHex);
  for (let i = 0; i < times; i++) x = sha256(x);
  return bytesToHex(x) === anchorHex.toLowerCase();
}

/** Blackjack total with soft aces. */
export function total(/** @type {number[]} */ cards) {
  let sum = 0;
  let aces = 0;
  for (const c of cards) {
    const r = c % 13;
    if (r === 0) { sum += 11; aces++; } else sum += r >= 9 ? 10 : r + 1;
  }
  while (sum > 21 && aces > 0) { sum -= 10; aces--; }
  return sum;
}

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
export const cardName = (/** @type {number} */ c) => RANKS[c % 13] + SUITS[Math.floor(c / 13)];

/**
 * Check a hand view. Returns {ok, checks:[{ok,text}]}; never throws on bad data.
 * @param {any} hand
 */
export function verifyHand(hand) {
  /** @type {{ok:boolean,text:string}[]} */ const checks = [];
  const add = (ok, text) => checks.push({ ok, text });
  const draws = Array.isArray(hand?.draws) ? hand.draws : [];
  if (!draws.length) {
    add(true, 'No cards dealt yet, nothing to check.');
    return { ok: true, checks };
  }
  const dealt = [];
  const byWho = { player: [], dealer: [] };
  let chainOk = true;
  let cardsOk = true;
  let orderOk = true;
  draws.forEach((d, i) => {
    try {
      if (d.index !== i) orderOk = false;
      if (!linksToAnchor(d.preimage, d.pos, hand.anchor)) chainOk = false;
      const want = drawCard(hexToBytes(d.preimage), hand.seed, hand.id, d.index, dealt);
      if (want !== d.card) cardsOk = false;
      dealt.push(d.card);
      (d.who === 'dealer' ? byWho.dealer : byWho.player).push(d.card);
    } catch {
      chainOk = cardsOk = false;
    }
  });
  add(orderOk, 'Cards were dealt in order 0, 1, 2, …');
  add(chainOk, `Every revealed preimage hashes down to the house's committed anchor (${String(hand.anchor).slice(0, 12)}…).`);
  add(cardsOk, 'Every card equals the one computed from the preimage, your seed, the hand id and the card index.');
  add(JSON.stringify(byWho.player) === JSON.stringify(hand.player_cards), `Your hand: ${byWho.player.map(cardName).join(' ')} (${total(byWho.player)}).`);
  add(JSON.stringify(byWho.dealer) === JSON.stringify(hand.dealer_cards), `Dealer hand: ${byWho.dealer.map(cardName).join(' ')} (${total(byWho.dealer)}).`);
  return { ok: checks.every((c) => c.ok), checks };
}
