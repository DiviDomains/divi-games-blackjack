// Blackjack on Divi Games testnet. Plain ES module, no build step, no requests except to the chain API and the site's own rank line (rank.js).
//
//   /play/blackjack/            your table
//   /play/blackjack/#<hand>     look at any hand (and verify it)
//   ?chain=http://127.0.0.1:7410  use another chain API root (default: <this origin>/chain; only on localhost, or this site's own origin)
//
// Helpers copied from play/tictactoe/app.js (el, say, run, play key): the SDK stays untouched.

import { Chain, Key, NETWORK, formatAmount, parseAmount, bytesToHex, localTime, timeLeft, readableError, setTextWithLinks, faucetFastNote } from '../../sdk/divigames.js';
import { mountWallets } from '../../sdk/connect.js';
import { showRank } from '../rank.js';
import { cardName, total, verifyHand } from './verify.js';
import { handAlert, shouldNotify, notifyPlan } from './alerts.js';
import { bjRules } from '../deadlines.js';

const GAME = 'blackjack';
const KEY_STORE = 'dg.playkey.wif';
// "Tell me when it's my move": '1' once the player has turned browser notifications on, '0' after they turn them off.
const ALERT_STORE = 'dg.bj-alerts';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const chain = Chain.fromPage();

const state = {
  /** @type {Key} */ key: loadKey(),
  /** The address that plays: the connected wallet's, or the guest key's. */
  me: '',
  decimals: 2,
  timeoutBlocks: 150,
  timeoutMs: 5 * 60 * 1000,
  /** Block time from which the refund deadline runs on the clock instead of on block height. */
  clockFrom: Infinity,
  /** Block time from which the second rules hold: a late house pays the hand, an idle player stands. */
  v2From: Infinity,
  idleMsV2: 10 * 60 * 1000,
  /** The idle rules as deadlines.js reads them, for the stand-for-you time in the hand alerts. */
  rules: bjRules(null),
  height: 0,
  /** @type {string|null} */ handId: null,
  /** @type {any} */ hand: null,
  /** @type {any[]} */ history: [],
  /** @type {number|null} */ epoch: null,
  /** This address's GOLD in base units, once read, so Double is offered only when it can be paid. */
  /** @type {bigint|null} */ gold: null,
  /** The deadline the status line counts down to, or null. */
  /** @type {number|null} */ countdownTo: null,
  /**
   * Hand alerts: what the last look at the hand said, the last hand of mine seen live, whether notifications are on, and
   * for which address. `looked`: the address whose hands the page has read, so a hand that shows up after that is news.
   */
  alert: { /** @type {string|undefined} */ kind: undefined, /** @type {string|null} */ liveId: null, notify: false, me: '', looked: '' },
};

// ---------- small helpers ----------

/**
 * Create an element. Text children are set with textContent, so chain data is never parsed as HTML.
 * @param {string} tag @param {Record<string, any>} [props] @param {...(Node|string|null|undefined|false)} children
 */
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== 'string') /** @type {any} */ (n)[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}

const short = (/** @type {string|null|undefined} */ a) => (a ? (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a) : '');
const who = (/** @type {string|null|undefined} */ a) => (a && a === state.me ? 'you' : short(a));
const gold = (/** @type {any} */ base) => {
  try {
    return formatAmount(String(base ?? '0'), state.decimals);
  } catch {
    return String(base);
  }
};

/** Show a message in an inline status element. kind: error | ok | info. Empty text hides it. */
const clearTimers = new WeakMap();

/** Show a status line under a control. Success notes fade after a few seconds; errors stay until replaced. */
function say(/** @type {HTMLElement} */ node, text = '', kind = 'info') {
  clearTimeout(clearTimers.get(node));
  text = readableError(text);
  setTextWithLinks(node, text);
  node.dataset.kind = kind;
  node.hidden = !text;
  if (text && kind === 'ok') {
    clearTimers.set(node, setTimeout(() => { if (node.textContent === text) say(node, ''); }, 5000));
  }
}

const errText = (/** @type {any} */ e) => (e && e.message) || String(e);

// ---------- the play key ----------

function storageGet(key = KEY_STORE) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(/** @type {string} */ value, key = KEY_STORE) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function loadKey() {
  const wif = storageGet();
  if (wif) {
    try {
      const k = Key.fromWif(wif);
      if (k.network === NETWORK) return k;
    } catch {
      /* unreadable: replace it */
    }
  }
  const k = Key.generate(NETWORK);
  storageSet(k.toWif());
  return k;
}

// ---------- normalising chain responses (cheap defence against small naming differences) ----------

/** Balance of `token` from an account response: `balances` as {SYM: "n"} or [{token|symbol, amount|balance}]. */
function balanceOf(/** @type {any} */ account, token = 'GOLD') {
  const b = account?.balances ?? account?.balance;
  if (Array.isArray(b)) {
    const row = b.find((r) => (r.token ?? r.symbol) === token);
    return String(row?.amount ?? row?.balance ?? '0');
  }
  if (b && typeof b === 'object') return String(b[token] ?? '0');
  return '0';
}

// ---------- sending actions ----------

let queue = Promise.resolve();
/** The error of the last action that failed, so a caller can tell a retryable conflict from the rest. */
let lastError = '';

/**
 * Sign and submit a game op (or any action), wait for its block, and report the outcome inline.
 * Actions from this page run one at a time, so each gets the right nonce.
 * @param {any} action @param {HTMLElement} msg @param {HTMLButtonElement[]} [buttons]
 * @returns {Promise<any|null>} the receipt when ok, else null
 */
function run(action, msg, buttons = []) {
  const job = async () => {
    buttons.forEach((b) => (b.disabled = true));
    try {
      say(msg, 'Signing and sending…');
      const txid = await chain.send(state.key, action);
      say(msg, 'Sent. Waiting for the next block…');
      const receipt = await chain.waitForReceipt(txid);
      if (!receipt.ok) {
        lastError = receipt.error || '';
        say(msg, receipt.error || 'The transaction failed.', 'error');
        return null;
      }
      say(msg, '');
      return receipt;
    } catch (e) {
      lastError = errText(e);
      say(msg, errText(e), 'error');
      return null;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      refreshAccount();
    }
  };
  const p = queue.then(job, job);
  queue = p.then(() => {}, () => {});
  return p;
}

const gameAction = (/** @type {any} */ op) => ({ type: 'game', game: GAME, op });

/**
 * Send an op the house deals to, naming the link it expects to deal it (`expected_pos`). If the house reveals a link
 * first, the chain refuses the op rather than deal it a different card; look again and resend, a few times.
 * @param {any} op @param {HTMLElement} msg @param {HTMLButtonElement[]} buttons
 */
async function runDealt(op, msg, buttons) {
  for (let i = 0; ; i++) {
    const house = await chain.game(GAME, { view: 'house' }).catch(() => null);
    const pos = Number(house?.pos);
    const r = await run(gameAction(Number.isFinite(pos) && house?.anchor ? { ...op, expected_pos: pos + 1 } : op), msg, buttons);
    if (r || i >= 2 || !/revealed a link since you looked|house is busy/.test(lastError)) return r;
    say(msg, 'The house moved on while that was sent; trying again…');
  }
}

// ---------- wallet ----------

async function refreshAccount() {
  try {
    wallets.refresh();
    const acct = await chain.account(state.me);
    $('balance').textContent = gold(balanceOf(acct, 'GOLD'));
    const had = state.gold;
    state.gold = BigInt(balanceOf(acct, 'GOLD'));
    showRank($('rank-line'), GAME, [state.me, state.key.address]);
    if (had !== state.gold && state.hand?.status === 'playing') render();
  } catch (e) {
    $('balance').textContent = '?';
    say($('wallet-msg'), `Could not reach the chain: ${errText(e)}`, 'error');
  }
}

function showKey() {
  $('me').textContent = state.me;
  $('me').title = state.me;
  const wif = $('wif');
  wif.hidden = true;
  wif.textContent = '';
  $('export').textContent = 'Show WIF';
}

$('copy-addr').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.me);
    say($('wallet-msg'), 'Address copied.', 'ok');
  } catch {
    say($('wallet-msg'), `Your address: ${state.me}`, 'info');
  }
});

$('faucet').addEventListener('click', async (ev) => {
  const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
  const r = await run({ type: 'faucet', token: 'GOLD' }, $('wallet-msg'), [btn]);
  if (r) say($('wallet-msg'), 'GOLD received.', 'ok');
});

$('export').addEventListener('click', () => {
  const wif = $('wif');
  if (wif.hidden) {
    wif.textContent = state.key.toWif();
    wif.hidden = false;
    $('export').textContent = 'Hide WIF';
  } else showKey();
});

$('import').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = /** @type {HTMLInputElement} */ ($('import-wif'));
  const text = input.value.trim();
  const msg = $('key-msg');
  try {
    const k = Key.fromWif(text);
    if (k.network !== NETWORK) throw new Error('That is a mainnet key. Import a testnet WIF (it starts with c).');
    if (k.address === state.me) {
      say(msg, 'That key is already in use.', 'info');
      return;
    }
    if (!confirmReplace()) return;
    state.key = k;
    state.me = k.address;
    wallets.setGuestKey(k);
    const saved = storageSet(k.toWif());
    input.value = '';
    showKey();
    say(msg, saved ? 'Key imported.' : 'Key imported for this visit only: this browser would not save it.', saved ? 'ok' : 'info');
    refreshAll();
  } catch (e) {
    say(msg, `Not a valid WIF: ${errText(e)}`, 'error');
  }
});

/** Two-step import: the first click warns inline, a second click within 10 s replaces the key. */
let armedAt = 0;
function confirmReplace() {
  if (Date.now() - armedAt < 10000) {
    armedAt = 0;
    return true;
  }
  armedAt = Date.now();
  say($('key-msg'), 'This replaces the current play key. Export it first if it holds anything you want. Press Import again to continue.', 'info');
  return false;
}

// ---------- the table ----------

const WAITING = (/** @type {any} */ h) => h && h.status === 'waiting';
const isMine = (/** @type {any} */ h) => h && h.player === state.me;

function cardEl(/** @type {number|null} */ c) {
  if (c == null) return el('div', { class: 'bj-card back', 'aria-label': 'face-down card' }, '?');
  return el('div', { class: `bj-card${Math.floor(c / 13) === 1 || Math.floor(c / 13) === 2 ? ' red' : ''}`, 'aria-label': cardName(c) }, cardName(c));
}

async function loadAll() {
  try {
    const me = state.me;
    const p = await chain.game(GAME, { player: me });
    state.history = Array.isArray(p?.hands) ? p.hands : [];
    if (!state.handId) {
      const active = p?.active ? state.history.find((h) => h.id === p.active) : null;
      state.hand = active ?? state.history[state.history.length - 1] ?? null;
      if (me === state.me) state.alert.looked = me;
    }
  } catch (e) {
    say($('msg'), `Could not load your hands: ${errText(e)}`, 'error');
  }
  if (state.handId) await loadHand();
  render();
}

async function loadHand() {
  const id = state.handId;
  if (!id) return;
  try {
    const h = await chain.game(GAME, { hand: id });
    if (state.handId === id) state.hand = h;
  } catch (e) {
    if (state.handId !== id) return;
    state.hand = null;
    say($('msg'), /** @type {any} */ (e).status === 404 ? `There is no hand ${id}.` : `Could not load the hand: ${errText(e)}`, 'error');
  }
}

async function loadHouse() {
  try {
    const h = await chain.game(GAME, { view: 'house' });
    state.epoch = Number.isFinite(Number(h.epoch)) ? Number(h.epoch) : null;
    const free = BigInt(h.free_bankroll ?? '0');
    $('house-line').textContent = h.anchor
      ? `House bankroll free: ${gold(free)} GOLD · chain ${h.pos}/${h.n} links used${h.exhausted ? ' (exhausted)' : ''}`
      : 'The house has not committed a card chain yet. Bets open when it does.';
  } catch {
    $('house-line').textContent = '';
  }
}

function render() {
  const h = state.hand;
  const mine = isMine(h);
  const playing = h && h.status === 'playing';
  const pc = h?.player_cards ?? [];
  const dc = h?.dealer_cards ?? [];
  $('p-cards').replaceChildren(...pc.map(cardEl));
  const hole = h && (h.status === 'playing' || h.status === 'waiting') && dc.length === 1;
  $('d-cards').replaceChildren(...dc.map(cardEl), ...(hole ? [cardEl(null)] : []));
  $('p-tot').textContent = pc.length ? `(${total(pc)})` : '';
  $('d-tot').textContent = dc.length && !hole ? `(${total(dc)})` : '';

  // Status line
  let status = 'Place a bet to start.';
  state.countdownTo = null;
  if (h) {
    if (h.status === 'playing') {
      const stands = mine ? idleStandMs(h) : null;
      state.countdownTo = stands;
      status = !mine ? 'Hand in play.'
        : stands != null ? `Your move: hit, stand or double. If you have not moved by ${localTime(stands)}, the house stands for you.`
        : 'Your move: hit, stand or double.';
    }
    else if (h.status === 'waiting') {
      const due = refundDueMs(h);
      if (due != null && mine && Date.now() < due) state.countdownTo = due;
      status = due != null && mine && Date.now() < due
        ? `Waiting for the house to reveal the next link… If it has not by ${localTime(due)}, you can ${due >= state.v2From ? 'claim the best result your hand could have had' : 'take your stake back'}.`
        : 'Waiting for the house to reveal the next link…';
    }
    else status = '';
  }
  $('status').textContent = status;
  tickCountdown();

  // Banner
  const b = $('banner');
  const done = h && ['finished', 'refunded', 'forfeited'].includes(h.status);
  if (done) {
    const payout = gold(h.payout ?? '0');
    // A hand the house failed to deal is paid as its best result from the second rules on; before, it was refunded.
    const key = h.status === 'refunded' ? 'refunded' : h.result;
    const text = {
      blackjack: `Blackjack! Paid ${payout} GOLD.`,
      win: `You win. Paid ${payout} GOLD.`,
      lose: 'Dealer wins.',
      bust: 'Bust.',
      push: `Push. Stake returned (${payout} GOLD).`,
      refunded: `Refunded (${payout} GOLD).`,
      forfeited: 'Hand abandoned; the stake went to the house.',
      house_timeout: `The house missed its turn, so the hand is paid as its best result: ${payout} GOLD.`,
    }[/** @type {string} */ (key)] ?? 'Hand over.';
    b.textContent = text;
    b.dataset.kind = ['blackjack', 'win', 'house_timeout'].includes(key) ? 'win' : ['lose', 'bust', 'forfeited'].includes(key) ? 'loss' : 'info';
    b.hidden = false;
  } else b.hidden = true;

  // Controls: betting only when there is no live hand of mine
  const live = mine && (playing || WAITING(h));
  $('bet-form').hidden = Boolean(live);
  $('actions').hidden = !live;
  const act = Boolean(mine && playing);
  // At 21 the only sensible move is to stand, and the chain refuses a hit; Double needs the bet again in GOLD.
  const at21 = total(pc) >= 21;
  /** @type {HTMLButtonElement} */ ($('stand')).hidden = !act;
  /** @type {HTMLButtonElement} */ ($('hit')).hidden = !act || at21;
  const canPay = state.gold == null || (h != null && state.gold >= BigInt(h.bet ?? 0));
  /** @type {HTMLButtonElement} */ ($('double')).hidden = !(act && pc.length === 2 && !at21 && canPay);
  // A waiting hand can be refunded once the house is late (or its chain was replaced).
  const late = WAITING(h) && houseLate(h);
  $('refund').textContent = late && Date.now() >= state.v2From ? 'Claim payout' : 'Refund';
  $('refund').hidden = !(live && (late || (h.epoch != null && state.epoch != null && h.epoch !== state.epoch)));
  clearTimeout(lateTimer);
  const due = WAITING(h) && !late ? refundDueMs(h) : null;
  const next = due ?? (act ? idleStandMs(h) : null);
  if (live && next != null) lateTimer = setTimeout(render, Math.max(0, next - Date.now()) + 500);

  renderHistory();
  renderVerify();
  refreshAlert();
}

let lateTimer = 0;

/** "4:12 left" beside the status line while it names a deadline. */
function tickCountdown() {
  const to = state.countdownTo;
  $('status-left').textContent = to != null && Date.now() < to ? `${timeLeft(to)} left` : '';
}
setInterval(tickCountdown, 1000);

/**
 * The block time from which a waiting hand can be refunded, or null while that still runs on block height.
 * A hand last touched under the clock rules gives the house five minutes; an older one, five minutes from the switch.
 * @param {any} h
 */
function refundDueMs(h) {
  if (h.updated_ms != null) return Number(h.updated_ms) + state.timeoutMs;
  return Date.now() >= state.clockFrom ? state.clockFrom + state.timeoutMs : null;
}

/** When the house may stand a playing hand whose player has gone quiet, or null before the second rules. */
function idleStandMs(/** @type {any} */ h) {
  if (h.updated_ms == null) return null;
  const at = Number(h.updated_ms) + state.idleMsV2;
  return at >= state.v2From ? at : null;
}

/** Whether the house is late revealing for a waiting hand, so the player can take the stake back. */
function houseLate(/** @type {any} */ h) {
  const due = refundDueMs(h);
  if (due != null && Date.now() >= due) return true;
  return lateByHeight(h);
}

/** Whether a hand from before the clock rules has waited on the house for its refund blocks. */
function lateByHeight(/** @type {any} */ h) {
  return h.updated_ms == null && state.height >= Number(h.updated_height ?? h.created_height ?? 0) + state.timeoutBlocks;
}

// ---------- hand alerts ----------
//
// Every action waits on the house, so a player who has switched tabs is told by the tab title when the hand is back on
// them, the house is late, or the hand ended. A browser notification is a local `new Notification(...)` they must ask
// for, and it fires only while the tab is hidden. Nothing here makes a request: it reads the hand the page already has.

/** Set the tab title and the urgent line from the current hand; notify when something worth leaving the tab for happened. */
function refreshAlert() {
  const h = state.hand;
  if (state.alert.me !== state.me) Object.assign(state.alert, { me: state.me, kind: undefined, liveId: null }); // another key: start afresh
  if (isMine(h) && (h.status === 'playing' || WAITING(h))) state.alert.liveId = h.id;
  const a = handAlert(h, state.me, {
    rules: state.rules,
    sawLive: Boolean(h && h.id === state.alert.liveId),
    refundDueMs: WAITING(h) ? refundDueMs(h) : null,
    heightLate: Boolean(WAITING(h) && lateByHeight(h)),
  });
  if (document.title !== a.title) document.title = a.title;
  const urgent = $('urgent');
  urgent.hidden = !a.urgent;
  if (urgent.textContent !== (a.urgent ? a.text : '')) urgent.textContent = a.urgent ? a.text : '';
  if (!h) {
    // The page has read this address's hands and it has none: a hand that shows up now is one dealt while the page
    // watched, so it is news even if the first look at it is already on the player's move (the house dealt between two
    // looks, as it often does on a busy host). Before that read nothing is known, and the first look is never news.
    if (!state.handId && state.alert.looked === state.me && state.alert.kind === undefined) state.alert.kind = 'none';
    return;
  }
  if (shouldNotify(/** @type {any} */ (state.alert.kind), a.kind) && state.alert.notify && document.hidden) notifyNow(a.text, h.id);
  state.alert.kind = a.kind;
}

function notifyNow(/** @type {string} */ text, /** @type {string} */ id) {
  try {
    new Notification('DiviGames · blackjack', { body: text, tag: `dg-bj-${id}` });
  } catch {
    /* the browser refused; the title still shows it */
  }
}

/** What this browser can do with notifications right now. */
function notifySupport() {
  const N = /** @type {any} */ (window).Notification;
  return { supported: typeof N === 'function', permission: typeof N === 'function' ? String(N.permission) : 'denied' };
}

/** Show the outcome of a toggle plan: the box, the note, and whether notifications are on. */
function applyNotifyPlan(/** @type {ReturnType<typeof notifyPlan>} */ plan) {
  state.alert.notify = plan.on;
  /** @type {HTMLInputElement} */ ($('alert-toggle')).checked = plan.on;
  $('alert-note').textContent = plan.note;
  $('alert-note').hidden = !plan.note;
}

$('alert-toggle').addEventListener('change', async (ev) => {
  const box = /** @type {HTMLInputElement} */ (ev.currentTarget);
  const wanted = box.checked;
  let plan = notifyPlan({ ...notifySupport(), wanted });
  if (plan.ask) {
    box.disabled = true;
    let permission = 'default';
    try {
      permission = String(await /** @type {any} */ (window).Notification.requestPermission());
    } catch {
      /* treated as not granted */
    }
    box.disabled = false;
    plan = notifyPlan({ supported: true, permission, wanted });
    if (!plan.on && !plan.note) plan.note = 'Notifications were not allowed, so none will be shown. The tab title still shows when it is your move.';
  }
  applyNotifyPlan(plan);
  storageSet(plan.on ? '1' : '0', ALERT_STORE);
});

// Offer the toggle only where the browser has notifications, and restore the saved choice without asking for permission.
{
  $('alert-opt').hidden = !notifySupport().supported;
  const plan = notifyPlan({ ...notifySupport(), wanted: storageGet(ALERT_STORE) === '1' });
  applyNotifyPlan(plan.ask ? { ask: false, on: false, note: '' } : plan);
}
setInterval(refreshAlert, 1000); // the seconds left before the house stands for you count down

function renderHistory() {
  const rows = [...state.history].reverse();
  $('history').replaceChildren(
    ...(rows.length
      ? rows.map((h) =>
          el('li', {},
            el('div', { class: 'info' },
              el('a', { href: `#${encodeURIComponent(h.id)}` }, `Hand ${String(h.id).slice(0, 8)}`),
              el('span', { class: 'pill' }, h.result ?? h.status),
              el('div', { class: 'sub' }, `bet ${gold(h.bet)} GOLD · you ${total(h.player_cards ?? [])} · dealer ${total(h.dealer_cards ?? [])}`)))
        )
      : [el('li', { class: 'muted' }, 'No hands yet.')]),
  );
}

// ---------- verify ----------

function renderVerify() {
  const h = state.hand;
  const t = /** @type {HTMLTableElement} */ ($('draws'));
  if (!h || !Array.isArray(h.draws) || !h.draws.length) {
    t.replaceChildren();
    $('checks').replaceChildren();
    return;
  }
  t.replaceChildren(
    el('tr', {}, ...['#', 'Who', 'Card', 'Link', 'Preimage'].map((x) => el('th', {}, x))),
    ...h.draws.map((/** @type {any} */ d) =>
      el('tr', {}, el('td', {}, String(d.index)), el('td', {}, d.who), el('td', {}, cardName(d.card)), el('td', {}, String(d.pos)), el('td', {}, el('code', {}, d.preimage)))),
  );
}

$('verify-run').addEventListener('click', () => {
  const r = verifyHand(state.hand);
  $('checks').replaceChildren(...r.checks.map((c) => el('li', { class: c.ok ? '' : 'bad' }, c.text)));
});

// ---------- actions ----------

const act = (/** @type {string} */ kind, /** @type {HTMLButtonElement} */ btn) => async () => {
  if (!state.hand) return;
  const op = { kind, hand: state.hand.id };
  await (kind === 'refund' ? run(gameAction(op), $('msg'), [btn]) : runDealt(op, $('msg'), [btn]));
  await loadAll();
};
for (const k of ['hit', 'stand', 'double', 'refund']) {
  const b = /** @type {HTMLButtonElement} */ ($(k));
  b.addEventListener('click', act(k, b));
}

const randomSeed = () => bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
const seedInput = () => /** @type {HTMLInputElement} */ (/** @type {HTMLFormElement} */ ($('bet-form')).elements.namedItem('seed'));
seedInput().value = randomSeed();

$('bet-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = /** @type {HTMLFormElement} */ (ev.currentTarget);
  const msg = $('msg');
  let amount;
  try {
    amount = parseAmount(/** @type {HTMLInputElement} */ (form.elements.namedItem('amount')).value.trim(), state.decimals);
  } catch {
    return say(msg, 'The bet must be a GOLD amount like 1 or 2.5.', 'error');
  }
  const seed = seedInput().value.trim() || randomSeed();
  const r = await runDealt({ kind: 'bet', amount, seed }, msg, [/** @type {HTMLButtonElement} */ ($('deal'))]);
  if (r) {
    seedInput().value = randomSeed();
    state.handId = null;
    if (location.hash) location.hash = '';
  }
  await loadAll();
});

// ---------- routing and live updates ----------

function route() {
  const id = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
  state.handId = id || null;
  state.hand = null;
  Object.assign(state.alert, { kind: undefined, looked: '' });
  say($('msg'), '');
  loadAll();
}

function refreshAll() {
  refreshAccount();
  loadHouse();
  loadAll();
}

function onBlock(/** @type {any} */ block) {
  const h = Number(block?.header?.height);
  if (Number.isFinite(h)) state.height = h;
  let dirty = false;
  let touchesMe = false;
  for (const r of block?.receipts ?? []) {
    for (const ev of r?.events ?? []) {
      if (!String(ev?.kind ?? '').startsWith(`${GAME}.`)) continue;
      dirty = true;
      const data = JSON.stringify(ev?.data ?? {});
      if (data.includes(state.me) || (state.hand && data.includes(state.hand.id))) touchesMe = true;
    }
  }
  if (touchesMe) refreshAccount();
  // Reveals deal to pending hands without naming the player, so any blackjack event may be ours.
  if (dirty) {
    loadHouse();
    loadAll();
  } else if (state.hand) render();
}

function setConn(/** @type {boolean} */ on) {
  const c = $('conn');
  c.dataset.state = on ? 'on' : 'off';
  c.textContent = on ? 'live' : 'reconnecting…';
  if (on) refreshAll();
}

// ---------- IronDivi wallets ----------

const wallets = mountWallets({
  chain,
  card: /** @type {HTMLElement} */ (document.querySelector('.card.wallet')),
  guestKey: state.key,
  onChange: () => {
    useWallet();
    showKey();
    refreshAll();
  },
});

/** Play with the connected wallet's session key, or with the guest key. */
function useWallet() {
  state.key = wallets.key;
  state.me = wallets.me;
}
useWallet();

async function start() {
  $('chain-url').textContent = chain.baseUrl;
  showKey();
  window.addEventListener('hashchange', route);
  chain.subscribe(onBlock, { onStatus: setConn });
  try {
    const [tokens, info, view] = await Promise.all([chain.tokens().catch(() => null), chain.info().catch(() => null), chain.game(GAME).catch(() => null)]);
    const list = Array.isArray(tokens) ? tokens : Array.isArray(tokens?.tokens) ? tokens.tokens : [];
    const goldTok = list.find((t) => (t?.symbol ?? t?.token) === 'GOLD');
    if (Number.isInteger(goldTok?.decimals)) state.decimals = goldTok.decimals;
    if (Number.isFinite(Number(info?.height))) state.height = Number(info.height);
    {
      const fast = faucetFastNote(info);
      if (fast && $('wallet-msg').hidden) say($('wallet-msg'), fast);
    }
    if (Number.isFinite(Number(view?.timeout_blocks))) state.timeoutBlocks = Number(view.timeout_blocks);
    if (Number.isFinite(Number(view?.timeout_ms))) state.timeoutMs = Number(view.timeout_ms);
    if (Number.isFinite(Number(view?.clock_rules_from_ms))) state.clockFrom = Number(view.clock_rules_from_ms);
    if (Number.isFinite(Number(view?.rules_v2_from_ms))) state.v2From = Number(view.rules_v2_from_ms);
    if (Number.isFinite(Number(view?.idle_ms_v2))) state.idleMsV2 = Number(view.idle_ms_v2);
    state.rules = bjRules(view);
  } catch {
    /* defaults stand */
  }
  route();
  refreshAccount();
  loadHouse();
}

start();
