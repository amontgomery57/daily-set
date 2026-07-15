import React, { useState, useEffect, useMemo, useRef } from 'react';

// ===== SET game constants =====
const COLORS = { purple: '#6B2D8C', green: '#1B8B3A', red: '#C9252D' };
const COLOR_KEYS = ['purple', 'green', 'red'];
const SHAPES = ['oval', 'diamond', 'squiggle'];
const SHADINGS = ['solid', 'striped', 'open'];
const NUMBERS = [1, 2, 3];
const PUZZLE_VERSION = '1';

// ===== Deck / set logic =====
function generateDeck() {
  const deck = [];
  for (const c of COLOR_KEYS)
    for (const s of SHAPES)
      for (const sh of SHADINGS)
        for (const n of NUMBERS)
          deck.push({ color: c, shape: s, shading: sh, number: n });
  return deck;
}

function isSet(a, b, c) {
  for (const attr of ['color', 'shape', 'shading', 'number']) {
    const vals = new Set([a[attr], b[attr], c[attr]]);
    if (vals.size === 2) return false;
  }
  return true;
}

function findAllSets(cards) {
  const sets = [];
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++)
      for (let k = j + 1; k < cards.length; k++)
        if (isSet(cards[i], cards[j], cards[k])) sets.push([i, j, k]);
  return sets;
}

// ===== Weekly Survivor helpers =====
// Cards as ints 0..80 (base-3 digits = color,shape,shading,number) with a
// precomputed pair-completion table: SURV_THIRD[a][b] = the unique card
// completing a set with a and b. decodeCard maps an int to the card-object
// shape the visual components already use.
const SURV_DIGITS = [];
for (let c = 0; c < 81; c++) {
  let x = c; const d = [];
  for (let i = 0; i < 4; i++) { d.push(x % 3); x = (x / 3) | 0; }
  SURV_DIGITS.push(d);
}
const SURV_THIRD = Array.from({ length: 81 }, () => new Int8Array(81));
for (let a = 0; a < 81; a++) for (let b = 0; b < 81; b++) {
  if (a === b) continue;
  let code = 0, mul = 1;
  for (let i = 0; i < 4; i++) {
    const t = (6 - SURV_DIGITS[a][i] - SURV_DIGITS[b][i]) % 3;
    code += t * mul; mul *= 3;
  }
  SURV_THIRD[a][b] = code;
}
function decodeCard(c) {
  const d = SURV_DIGITS[c];
  return { color: COLOR_KEYS[d[0]], shape: SHAPES[d[1]], shading: SHADINGS[d[2]], number: NUMBERS[d[3]] };
}
function survivorShuffledDeck() {
  const a = Array.from({ length: 81 }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// every card that would complete a set with some pair on the board
function survivorPoisonSet(board) {
  const p = new Set();
  for (let i = 0; i < board.length; i++)
    for (let j = i + 1; j < board.length; j++)
      p.add(SURV_THIRD[board[i]][board[j]]);
  for (const c of board) p.delete(c);
  return p;
}
const SURVIVOR_MAX_PASSES = 10;

// ===== Weekly Puzzle rotation =====
// One puzzle type per ISO week. Add new types here as they ship (e.g.
// 'fourteen', 'magic-plane', 'needle', 'hub') and they enter the cycle.
// NOTE: the (y*53+w) index is fine while the rotation has one entry; when
// it grows, switch to a Monday-epoch week count so the cycle is seamless
// across year boundaries.
const WEEKLY_ROTATION = ['survivor'];
const WEEKLY_TYPE_META = {
  survivor: { title: 'Survivor', unit: 'cards' },
};
function weeklyTypeForKey(weekKey) {
  const [y, w] = weekKey.split('-W').map(Number);
  return WEEKLY_ROTATION[(y * 53 + w) % WEEKLY_ROTATION.length];
}

// 4-char mask of which attributes are all-different in a set, in the order
// color,shape,shading,number ('1' = all-differ, '0' = all-same). E.g. three
// red solid ovals in counts 1/2/3 -> "0001".
function setDiffMask(a, b, c) {
  let m = '';
  for (const attr of ['color', 'shape', 'shading', 'number']) {
    m += new Set([a[attr], b[attr], c[attr]]).size === 3 ? '1' : '0';
  }
  return m;
}

// ===== Puzzle difficulty scoring =====
// Structural metrics, independent of the player:
//   avgVars: average number of varying attributes across the 6 sets (1.0-4.0).
//     A set varying in only 1 attribute (three red solid ovals, just 1/2/3 of
//     them) is a "gimme"; one varying in all 4 looks maximally different and
//     is the hardest to recognize. Empirically the strongest single predictor.
//   decoys: cards that belong to no set at all. They still have to be
//     visually evaluated and dismissed, which costs scan time. Real but weak.
//
// v3 (July 2026): refit against 1,338 solves over 368 multi-player puzzle
// days (7 players with 20+ plays; within-player standardized log solve times;
// puzzle difficulty = mean standardized residual across that day's solvers).
//   raw = 1.0*avgVars + 0.141*decoys
//
// What changed from v2 and why:
//   - v2 used raw = 0.75*avgVars + 1.0*decoys - 0.25*nCompact. Those weights
//     were fit on ~98 puzzle days, and nearly every conclusion from that
//     sample turned out to be noise. With ~4x the data:
//       avgVars   r = +0.374  (v2-era estimate said ~0.02 — "dead". It is not
//                              dead; it is the dominant term.)
//       decoys    r = +0.111  (v2-era estimate said +0.35 — overstated.)
//       nCompact  r = -0.006  (no signal at all; dropped.)
//   - The v2 weights were also miscalibrated in *raw units*: decoys spans 0-6
//     while avgVars spans ~2-4, so weighting decoys at 1.0 let the weakest
//     term dominate the composite. That is why the v2 score only reached
//     r=0.212 against real difficulty despite containing the right variables.
//
// Result: score-vs-difficulty correlation 0.212 -> 0.395, i.e. variance
// explained 4.5% -> 15.6%. Star tiers now separate ~3x more strongly:
//     1-star mean z = -0.416   (v2: -0.113)
//     2-star mean z = -0.025   (v2: -0.026)
//     3-star mean z = +0.325   (v2: +0.158)
// For a player who averages ~83s, that is roughly 69s / 82s / 96s by tier.
//
// The honest limit: 15.6% is a real improvement but still leaves ~84% of the
// variance unexplained by board structure. The same puzzle has produced a
// 181s solve and a 451s solve from two different people. The score is
// directionally useful, not precise. ScoringContent says so plainly.
const RAW_SCORE_MIN = 1.808;  // min raw composite over all real daily puzzles
const RAW_SCORE_MAX = 3.808;  // max raw composite over all real daily puzzles
// Cut points on the 0-10 scale, set at the p20 / p75 of real daily puzzles so
// the mix stays ~18% / 54% / 28% (unchanged from v2's feel — the tiers keep
// their proportions, they just finally track real solve times).
const SCORE_CUT_EASY = 3.46;  // < this -> 1 star
const SCORE_CUT_HARD = 6.67;  // >= this -> 3 stars; between -> 2 stars

function computePuzzleDifficulty(puzzle) {
  if (!puzzle || !puzzle.sets || !puzzle.cards) return null;
  const { cards, sets } = puzzle;
  if (!sets.length) return null;

  // 1. Average varying attributes per set (1.0 - 4.0)
  let totalVars = 0;
  for (const [i, j, k] of sets) {
    const a = cards[i], b = cards[j], c = cards[k];
    let v = 0;
    for (const attr of ['color', 'shape', 'shading', 'number']) {
      if (new Set([a[attr], b[attr], c[attr]]).size === 3) v++;
    }
    totalVars += v;
  }
  const avgVars = totalVars / sets.length;

  // 2. Per-card memberships -> decoys (cards in zero sets)
  const memberships = new Array(cards.length).fill(0);
  for (const [i, j, k] of sets) { memberships[i]++; memberships[j]++; memberships[k]++; }
  const decoys = memberships.filter(m => m === 0).length;

  // Raw composite, then normalize to 0-10 using the real-puzzle bounds.
  // Clamp in case a puzzle lands slightly outside the observed range.
  const rawScore = 1.0 * avgVars + 0.141 * decoys;
  const normalized = ((rawScore - RAW_SCORE_MIN) / (RAW_SCORE_MAX - RAW_SCORE_MIN)) * 10;
  const score = Math.max(0, Math.min(10, normalized));
  const level = score < SCORE_CUT_EASY ? 'easy'
              : score < SCORE_CUT_HARD ? 'medium'
              :                          'hard';

  return { avgVars, decoys, rawScore, score, level };
}

// ===== Seeded RNG =====
function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateDailyPuzzle(dateKey) {
  const deck = generateDeck();
  let best = null;
  let bestDiff = Infinity;
  for (let attempt = 0; attempt < 3000; attempt++) {
    const rand = mulberry32(hashString(`${PUZZLE_VERSION}:${dateKey}:${attempt}`));
    const cards = seededShuffle(deck, rand).slice(0, 12);
    const sets = findAllSets(cards);
    if (sets.length === 6) return { cards, sets, dateKey };
    const diff = Math.abs(sets.length - 6);
    if (diff < bestDiff) { bestDiff = diff; best = { cards, sets, dateKey }; }
  }
  return best;
}

// ===== Date helpers (UTC) =====
function utcDateKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateKeyToUTC(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function msUntilNextUtcMidnight() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  return tomorrow.getTime() - now.getTime();
}

function formatCountdown(ms) {
  if (ms <= 0) return 'now';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatMmSs(s) {
  // Times are stored as seconds with hundredths precision (e.g. 123.45 → "2:03.45").
  // Integer values from older saved data still format cleanly (e.g. 123 → "2:03.00").
  const safe = typeof s === 'number' && isFinite(s) ? s : 0;
  const m = Math.floor(safe / 60);
  const remaining = safe - m * 60;
  return `${m}:${remaining.toFixed(2).padStart(5, '0')}`;
}

// Compact variant for dense tables (e.g. the Players standings), where six
// numeric columns have to fit a 400px phone. One decimal instead of two:
// 123.45 -> "2:03.4". Averages don't need hundredths to be comparable.
function formatMmSs1(s) {
  const safe = typeof s === 'number' && isFinite(s) ? s : 0;
  const m = Math.floor(safe / 60);
  const remaining = safe - m * 60;
  return `${m}:${remaining.toFixed(1).padStart(4, '0')}`;
}

// "3rd", "24th", "1st" — used only for the personal-history callouts below.
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// A player needs at least this many completed puzzles before we show the
// "vs your own history" panel — below this a histogram is too sparse to be
// meaningful and just looks like noise.
const MIN_HISTORY_FOR_PANEL = 5;

// Buckets a player's own times into `binCount` equal-width bins for the
// completion-screen histogram, and locates which bin this puzzle's time
// falls in. Returns null if there isn't enough history (caller checks
// MIN_HISTORY_FOR_PANEL first, but this also guards directly).
function buildPersonalHistogram(times, thisTime, binCount = 7) {
  if (!times.length) return null;
  const min = Math.min(...times), max = Math.max(...times);
  if (max - min < 0.01) {
    // Every game finished in essentially the same time — one flat bin.
    return { bins: [times.length], min, max, thisIdx: 0, thisPct: 50, flat: true };
  }
  const width = (max - min) / binCount;
  const bins = new Array(binCount).fill(0);
  for (const t of times) {
    let idx = Math.floor((t - min) / width);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx]++;
  }
  let thisIdx = Math.floor((thisTime - min) / width);
  if (thisIdx >= binCount) thisIdx = binCount - 1;
  if (thisIdx < 0) thisIdx = 0;
  const thisPct = Math.max(3, Math.min(97, ((thisTime - min) / (max - min)) * 100));
  return { bins, min, max, thisIdx, thisPct, flat: false };
}

// A player needs at least this many split-recorded solves before the
// "where your time goes" pace chart is worth showing — fewer than this and
// per-position medians are too noisy to read as a real pattern. Lower than
// the private analytics dashboard's own n>=10 bar, since this is a smaller,
// friendlier readout rather than a statistical claim.
const MIN_SPLITS_FOR_PACE_CHART = 5;

// A splits array holds cumulative seconds per set, in find order. Convert
// to per-position gaps: how long each individual set took to find, timed
// from the previous find (or from puzzle start, for the first set).
function splitsToGaps(splits) {
  return splits.map((s, i) => (i === 0 ? s.t : s.t - splits[i - 1].t));
}

function computeMedian(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Builds per-set-position median gaps across a set of solves (each with a
// `splits` array). Returns one entry per position (0 = 1st set found) with
// its median gap and sample size. A handful of historical puzzles with
// fewer than 6 sets just contribute nothing to the later positions rather
// than skewing or crashing them.
function buildPaceByPosition(solves, maxPositions = 6) {
  const byPos = Array.from({ length: maxPositions }, () => []);
  for (const row of solves) {
    if (!row.splits || !row.splits.length) continue;
    const gaps = splitsToGaps(row.splits);
    gaps.forEach((g, i) => { if (i < maxPositions) byPos[i].push(g); });
  }
  return byPos.map((gaps) => ({ median: computeMedian(gaps), n: gaps.length }));
}

function formatLongDate(dateKey) {
  return new Date(dateKeyToUTC(dateKey)).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function formatShortDate(dateKey) {
  return new Date(dateKeyToUTC(dateKey)).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function shortWeekday(dateKey, upper = false) {
  const s = new Date(dateKeyToUTC(dateKey)).toLocaleDateString(undefined, {
    weekday: 'short', timeZone: 'UTC',
  });
  return upper ? s.toUpperCase() : s;
}

// ISO-8601 week key in UTC (weeks run Mon 00:00 UTC to Sun 24:00 UTC),
// e.g. '2026-W24'. Used to bucket Weekly Survivor scores.
function utcIsoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;             // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day);  // shift to nearest Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function msUntilNextUtcMonday() {
  const now = new Date();
  const day = now.getUTCDay() || 7;              // Mon=1..Sun=7
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + (8 - day));
  next.setUTCHours(0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

// ===== Storage backend =====
// Supabase project for dailyset.net. The publishable key is designed to be
// public — Row Level Security on the results/puzzles tables controls what
// anyone can do (read + insert only). Safe to commit and to ship to clients.
const SUPABASE_URL = 'https://ncujnlnlgzfxurlyfnzk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xD3sBJnHJ03O7Bv8xt1H9A_SXE8H6oL';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);

const hasStorage = () =>
  typeof window !== 'undefined' && window.storage &&
  typeof window.storage.get === 'function';

const LS_NAME = 'daily-set:player-name';
const LS_SECRET = 'daily-set:player-secret';
const LS_MINE_PREFIX = 'daily-set:mine:';

const lsGetName = () => { try { return localStorage.getItem(LS_NAME); } catch { return null; } };
const lsSetName = (n) => { try { localStorage.setItem(LS_NAME, n); } catch {} };

// --- Ownership secret ---------------------------------------------------
// Each player's name is protected by a long random secret held on their
// device. It's created silently the first time they play (or the first time
// an existing player opens a build that has this code), registered against
// their name server-side, and sent with every result submission. Nobody ever
// has to see or type it in the normal case — but it IS the only proof that
// you're you, so it's surfaced as a copyable "sync code" for moving devices.
const lsGetSecret = () => { try { return localStorage.getItem(LS_SECRET); } catch { return null; } };
const lsSetSecret = (s) => { try { localStorage.setItem(LS_SECRET, s); } catch {} };

function generateSecret() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `${crypto.randomUUID()}-${crypto.randomUUID()}`.replace(/-/g, '').slice(0, 40);
    }
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const a = new Uint8Array(20);
      crypto.getRandomValues(a);
      return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {}
  // Last-resort fallback; only reached on ancient browsers with no crypto.
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 40);
}
const lsGetResult = (d) => {
  try { const v = localStorage.getItem(LS_MINE_PREFIX + d); return v ? JSON.parse(v) : null; }
  catch { return null; }
};
const lsSetResult = (d, r) => {
  try { localStorage.setItem(LS_MINE_PREFIX + d, JSON.stringify(r)); } catch {}
};
const lsListResults = () => {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_MINE_PREFIX)) {
        try { out[k.substring(LS_MINE_PREFIX.length)] = JSON.parse(localStorage.getItem(k)); }
        catch {}
      }
    }
  } catch {}
  return out;
};

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

// PostgREST caps every response at a fixed number of rows server-side (1000
// by default). A large `limit=` in the URL can only make a page SMALLER than
// that cap, never larger — so a single request silently truncates any table
// with more than ~1000 rows. This walks the whole result set in pages using
// the Range header and concatenates them. `path` must already include its
// select/order; do NOT put a limit on it.
async function sbFetchAll(path, pageSize = 1000) {
  const all = [];
  let from = 0;
  // hard stop so a bug can never spin forever (100 pages = 100k rows)
  for (let guard = 0; guard < 100; guard++) {
    const to = from + pageSize - 1;
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Range: `${from}-${to}`,
        'Range-Unit': 'items',
      },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const page = res.status === 204 ? [] : await res.json();
    all.push(...page);
    // Short page (or empty) means we've reached the end.
    if (!page.length || page.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Call a security-definer Postgres function. Writes go through these rather
// than straight table POSTs, so the server can verify the caller actually
// owns the name they're submitting under.
async function sbRpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Supabase rpc ${fn} ${res.status}: ${await res.text()}`);
  return res.json();
}

// Tiny cached-fetch helper for the broad, whole-table-ish queries
// (loadAllHistory, loadFieldSplits). Archives, Stats, and every player
// profile each call these independently on mount with no coordination —
// browsing Archives -> Stats -> two player profiles fires the same
// multi-hundred-row fetch four times in a few seconds with no caching.
// This dedupes concurrent calls and reuses a recent result for `ttlMs`,
// so a normal browsing burst costs one network round trip instead of one
// per component. Each consumer gets its own slot, keyed by name, so they
// don't collide. Not used for anything that intentionally polls for
// freshness (e.g. the completion screen's 15s leaderboard refresh) —
// this is only for the broad historical queries.
const HISTORY_CACHE_TTL_MS = 60_000;
const _cache = {};
function cachedFetch(key, ttlMs, fetchFn) {
  const now = Date.now();
  const slot = _cache[key];
  if (slot?.data !== undefined && now - slot.ts < ttlMs) return Promise.resolve(slot.data);
  if (slot?.inFlight) return slot.inFlight;
  const p = fetchFn().then((data) => {
    _cache[key] = { data, ts: Date.now(), inFlight: null };
    return data;
  }).catch((e) => {
    delete _cache[key]; // don't cache failures
    throw e;
  });
  _cache[key] = { ...(slot || {}), inFlight: p };
  return p;
}
function invalidateCache(key) { delete _cache[key]; }

const Storage = {
  async getName() {
    if (USE_SUPABASE) return lsGetName();
    if (hasStorage()) {
      try { const r = await window.storage.get('player:name', false); return r?.value || null; }
      catch { return null; }
    }
    return lsGetName();
  },
  async setName(name) {
    if (USE_SUPABASE) { lsSetName(name); return; }
    if (hasStorage()) {
      try { await window.storage.set('player:name', name, false); } catch (e) { console.error(e); }
      return;
    }
    lsSetName(name);
  },

  // --- Identity / ownership ---------------------------------------------
  getSecret() { return lsGetSecret(); },
  setSecret(s) { lsSetSecret(s); },

  // Ensure this device has a secret, creating one if needed. Returns it.
  ensureSecret() {
    let s = lsGetSecret();
    if (!s) { s = generateSecret(); lsSetSecret(s); }
    return s;
  },

  // Try to own `name` with `secret`. Server returns one of:
  //   'claimed'      - the name was unowned; it's ours now
  //   'ok'           - already ours (secret matches) — normal returning player
  //   'taken'        - owned by someone else's secret
  //   'invalid'      - malformed name/secret
  //   'unavailable'  - network/server problem (we fail OPEN, see below)
  //
  // We deliberately fail OPEN on network errors: if Supabase is unreachable
  // we let the player keep playing under their existing local name rather
  // than locking them out of a puzzle over a flaky connection. The server is
  // still the thing that enforces writes, so a spoofer gains nothing by
  // forcing this path.
  async claimName(name, secret) {
    if (!USE_SUPABASE) return 'claimed';
    try {
      const r = await sbRpc('claim_name', { p_name: name, p_secret: secret });
      return typeof r === 'string' ? r : 'unavailable';
    } catch (e) {
      console.error('claimName:', e);
      return 'unavailable';
    }
  },
  async getMyResult(dateKey, playerName) {
    if (USE_SUPABASE && playerName) {
      try {
        const rows = await sbFetch(
          `/results?date=eq.${encodeURIComponent(dateKey)}&name=eq.${encodeURIComponent(playerName)}&select=time_seconds,completed_at&limit=1`
        );
        if (rows && rows.length) {
          const r = { time: rows[0].time_seconds, completedAt: rows[0].completed_at };
          lsSetResult(dateKey, r);  // cache locally
          return r;
        }
        return lsGetResult(dateKey);  // nothing in supabase; fall back to local cache
      } catch { return lsGetResult(dateKey); }
    }
    if (USE_SUPABASE) return lsGetResult(dateKey);
    if (hasStorage()) {
      try {
        const r = await window.storage.get(`mine:${dateKey}`, false);
        return r ? JSON.parse(r.value) : null;
      } catch { return null; }
    }
    return lsGetResult(dateKey);
  },
  async loadMyResults(playerName) {
    if (USE_SUPABASE && playerName) {
      try {
        const rows = await sbFetch(
          `/results?name=eq.${encodeURIComponent(playerName)}&select=date,time_seconds,completed_at`
        );
        const out = {};
        for (const row of rows || []) {
          out[row.date] = { time: row.time_seconds, completedAt: row.completed_at };
          lsSetResult(row.date, out[row.date]);  // cache locally
        }
        // Merge in any local-only entries (e.g. saved before name was set)
        const local = lsListResults();
        for (const [d, r] of Object.entries(local)) {
          if (!out[d]) out[d] = r;
        }
        return out;
      } catch { return lsListResults(); }
    }
    if (USE_SUPABASE) return lsListResults();
    if (hasStorage()) {
      try {
        const list = await window.storage.list('mine:', false);
        const keys = list?.keys || [];
        const results = {};
        await Promise.all(keys.map(async (key) => {
          try {
            const r = await window.storage.get(key, false);
            if (r) results[key.substring('mine:'.length)] = JSON.parse(r.value);
          } catch {}
        }));
        return results;
      } catch { return {}; }
    }
    return lsListResults();
  },
  async saveResult(dateKey, name, time, splits) {
    // A fresh solve changes the shared history query's answer — invalidate
    // so the player sees their own result immediately instead of waiting out
    // the cache TTL. (fieldSplits is left to expire on its own; one solve
    // barely moves a field-wide median, and it's an expensive query to
    // refetch on every single save across every player.)
    invalidateCache('allHistory');
    const payload = { time, completedAt: Date.now() };
    if (splits && splits.length) payload.splits = splits;
    if (USE_SUPABASE) {
      lsSetResult(dateKey, payload);
      try {
        // Verified write: the server checks name+secret before inserting.
        // The result is always kept locally first (above), so even if this
        // fails the player still sees their time and syncLocalToCloud will
        // retry the push on next load.
        const r = await sbRpc('submit_result', {
          p_name: name,
          p_secret: Storage.ensureSecret(),
          p_date: dateKey,
          p_time_seconds: time,
          p_completed_at: payload.completedAt,
          p_splits: payload.splits || null,
        });
        if (r !== 'ok') console.error('saveResult rejected:', r);
      } catch (e) { console.error('saveResult:', e); }
      return;
    }
    if (hasStorage()) {
      const json = JSON.stringify(payload);
      try {
        await window.storage.set(`mine:${dateKey}`, json, false);
        await window.storage.set(`result:${dateKey}:${name}`, json, true);
      } catch (e) { console.error(e); }
      return;
    }
    lsSetResult(dateKey, payload);
  },
  // Save the puzzle cards for a given date. Idempotent — same date always
  // generates the same cards, so we silently skip duplicates. Called once
  // per puzzle load so we end up with a row for every puzzle anyone touches.
  async savePuzzle(dateKey, cards) {
    if (!cards || !cards.length) return;
    if (USE_SUPABASE) {
      try {
        await sbFetch('/puzzles', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({
            date: dateKey,
            cards,
            created_at: Date.now(),
          }),
        });
      } catch (e) { console.error('savePuzzle:', e); }
      return;
    }
    if (hasStorage()) {
      try { await window.storage.set(`puzzle:${dateKey}`, JSON.stringify(cards), true); }
      catch (e) { console.error(e); }
      return;
    }
    // local-only mode: skip (deterministic from date anyway)
  },
  // Push any local results that the cloud doesn't have yet. This fixes the
  // case where a save attempt failed silently (transient network, schema
  // mismatch, etc.) — the result lives in localStorage so the user sees it
  // in their own view, but it never reached the global leaderboard / daily
  // log. Called on app load after the name is known. ignore-duplicates means
  // it's safe to re-run; rows already in cloud are silently skipped.
  async syncLocalToCloud(playerName) {
    if (!USE_SUPABASE || !playerName) return { pushed: 0 };
    try {
      const rows = await sbFetch(
        `/results?name=eq.${encodeURIComponent(playerName)}&select=date`
      );
      const cloudDates = new Set((rows || []).map((r) => r.date));
      const local = lsListResults();
      const missing = Object.entries(local).filter(([d]) => !cloudDates.has(d));
      if (missing.length === 0) return { pushed: 0 };
      let pushed = 0;
      const secret = Storage.ensureSecret();
      for (const [date, payload] of missing) {
        if (!payload || typeof payload.time !== 'number') continue;
        try {
          const r = await sbRpc('submit_result', {
            p_name: playerName,
            p_secret: secret,
            p_date: date,
            p_time_seconds: payload.time,
            p_completed_at: payload.completedAt || Date.now(),
            p_splits: payload.splits || null,
          });
          if (r === 'ok') pushed++;
          else console.error(`syncLocalToCloud: rejected for ${date}:`, r);
        } catch (e) {
          console.error(`syncLocalToCloud: failed for ${date}:`, e);
        }
      }
      if (pushed > 0) console.log(`syncLocalToCloud: pushed ${pushed} result(s) to cloud`);
      return { pushed };
    } catch (e) {
      console.error('syncLocalToCloud:', e);
      return { pushed: 0 };
    }
  },
  // --- Weekly Survivor ---
  async saveSurvivorResult(week, name, score, passesUsed, board) {
    if (!USE_SUPABASE) return;
    try {
      const r = await sbRpc('submit_survivor', {
        p_name: name,
        p_secret: Storage.ensureSecret(),
        p_week: week,
        p_score: score,
        p_passes_used: passesUsed,
        p_board: board || null,
      });
      if (r !== 'ok') console.error('saveSurvivorResult rejected:', r);
    } catch (e) { console.error('saveSurvivorResult:', e); }
  },
  // Best score per player for one week, with attempt counts.
  async loadSurvivorWeek(week) {
    if (!USE_SUPABASE) return [];
    try {
      const rows = await sbFetch(
        `/survivor_results?week=eq.${encodeURIComponent(week)}&select=name,score,passes_used,completed_at`
      );
      const byName = {};
      for (const r of rows || []) {
        const cur = byName[r.name];
        if (!cur) byName[r.name] = { name: r.name, best: r.score, attempts: 1, bestAt: r.completed_at };
        else {
          cur.attempts++;
          if (r.score > cur.best || (r.score === cur.best && r.completed_at < cur.bestAt)) {
            cur.best = r.score; cur.bestAt = r.completed_at;
          }
        }
      }
      // rank: score desc, earlier best wins ties
      return Object.values(byName).sort((a, b) => b.best - a.best || a.bestAt - b.bestAt);
    } catch { return []; }
  },
  // Past champions: winner per week (excluding the given current week).
  async loadSurvivorChampions(excludeWeek) {
    if (!USE_SUPABASE) return [];
    try {
      const rows = await sbFetchAll(
        '/survivor_results?select=week,name,score,completed_at&order=week.desc'
      );
      const byWeek = {};
      for (const r of rows || []) {
        if (r.week === excludeWeek) continue;
        const cur = byWeek[r.week];
        if (!cur || r.score > cur.score || (r.score === cur.score && r.completed_at < cur.completed_at)) {
          byWeek[r.week] = r;
        }
      }
      return Object.values(byWeek).sort((a, b) => b.week.localeCompare(a.week));
    } catch { return []; }
  },
  async loadLeaderboard(dateKey) {
    if (USE_SUPABASE) {
      try {
        const rows = await sbFetch(
          `/results?date=eq.${encodeURIComponent(dateKey)}&select=name,time_seconds,completed_at`
        );
        const out = {};
        for (const row of rows || []) {
          out[row.name] = { time: row.time_seconds, completedAt: row.completed_at };
        }
        return out;
      } catch { return {}; }
    }
    if (hasStorage()) {
      const prefix = `result:${dateKey}:`;
      try {
        const list = await window.storage.list(prefix, true);
        const keys = list?.keys || [];
        const results = {};
        await Promise.all(keys.map(async (key) => {
          try {
            const r = await window.storage.get(key, true);
            if (r) results[key.substring(prefix.length)] = JSON.parse(r.value);
          } catch {}
        }));
        return results;
      } catch { return {}; }
    }
    return {};
  },
  async loadAllHistory() {
    if (USE_SUPABASE) {
      return cachedFetch('allHistory', HISTORY_CACHE_TTL_MS, async () => {
        try {
          // Paginated: PostgREST caps single responses ~1000 rows, which was
          // silently truncating history to only the most recent dates.
          const rows = await sbFetchAll(
            '/results?select=date,name,time_seconds,completed_at&order=date.desc'
          );
          const history = {};
          for (const row of rows || []) {
            if (!history[row.date]) history[row.date] = {};
            history[row.date][row.name] = { time: row.time_seconds, completedAt: row.completed_at };
          }
          return history;
        } catch { return {}; }
      });
    }
    if (hasStorage()) {
      try {
        const list = await window.storage.list('result:', true);
        const keys = list?.keys || [];
        const history = {};
        await Promise.all(keys.map(async (key) => {
          try {
            const r = await window.storage.get(key, true);
            if (!r) return;
            const rest = key.substring('result:'.length);
            const colon = rest.indexOf(':');
            if (colon === -1) return;
            const date = rest.substring(0, colon);
            const n = rest.substring(colon + 1);
            if (!history[date]) history[date] = {};
            history[date][n] = JSON.parse(r.value);
          } catch {}
        }));
        return history;
      } catch { return {}; }
    }
    return {};
  },
  // Fetch one player's own split-recorded solves — scoped by name, so most
  // profile views (players below the pace-chart threshold) never trigger
  // the heavier field-wide query below.
  async loadPlayerSplits(playerName) {
    if (USE_SUPABASE && playerName) {
      try {
        const rows = await sbFetch(
          `/results?name=eq.${encodeURIComponent(playerName)}&splits=not.is.null&select=date,splits&order=date.desc&limit=2000`
        );
        return rows || [];
      } catch { return []; }
    }
    return [];
  },
  // Fetch every split-recorded solve across all players, to compute the
  // field's median pace per set position. Only called once a profile has
  // already cleared MIN_SPLITS_FOR_PACE_CHART on its own scoped query above.
  async loadFieldSplits() {
    if (USE_SUPABASE) {
      return cachedFetch('fieldSplits', HISTORY_CACHE_TTL_MS, async () => {
        try {
          const rows = await sbFetchAll('/results?splits=not.is.null&select=splits');
          return rows || [];
        } catch { return []; }
      });
    }
    return [];
  },
};

// ===== Visual: SET shapes =====
function ShapeSvg({ shape, color, shading }) {
  const hex = COLORS[color];
  let fill;
  if (shading === 'solid') fill = hex;
  else if (shading === 'open') fill = 'white';
  else fill = `url(#stripes-${color})`;
  const stroke = hex;
  const sw = 3;
  return (
    <svg viewBox="0 0 50 100" preserveAspectRatio="xMidYMid meet"
         style={{ display: 'block', width: '100%', height: '100%' }}>
      {shape === 'oval' && (
        <rect x="4" y="8" width="42" height="84" rx="21" ry="21"
          fill={fill} stroke={stroke} strokeWidth={sw} />
      )}
      {shape === 'diamond' && (
        <polygon points="25,5 47,50 25,95 3,50"
          fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
      )}
      {shape === 'squiggle' && (
        <path
          d="M 10 12 C 22 4, 36 8, 42 18 C 47 28, 32 36, 28 46
             C 24 56, 42 60, 44 72 C 46 86, 32 96, 18 92
             C 6 88, 4 76, 10 66 C 16 56, 24 50, 22 40
             C 20 30, 6 28, 8 18 C 8 14, 9 13, 10 12 Z"
          fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

const CARD_ASPECT = '4 / 3';
const SHAPE_HEIGHT = '70%';
const SHAPE_ASPECT = '1 / 2';

function CardBody({ card }) {
  const items = Array(card.number).fill(0);
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ gap: '4%' }}>
      {items.map((_, i) => (
        <div key={i} className="flex-shrink-0"
             style={{ height: SHAPE_HEIGHT, aspectRatio: SHAPE_ASPECT }}>
          <ShapeSvg shape={card.shape} color={card.color} shading={card.shading} />
        </div>
      ))}
    </div>
  );
}

function GameCard({ card, selected, flashing, onClick, disabled }) {
  const border = flashing === 'bad' ? 'border-red-500 ring-2 ring-red-300 bg-red-50/40'
                : flashing === 'dup' ? 'border-amber-500 ring-2 ring-amber-300 bg-amber-50/40'
                : selected ? 'border-blue-500 ring-2 ring-blue-300 bg-blue-50/50'
                : 'border-gray-200 bg-white';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ aspectRatio: CARD_ASPECT, touchAction: 'manipulation' }}
      className={`relative w-full rounded-lg border-2 ${border}
        overflow-hidden transition-colors duration-100 shadow-sm select-none
        ${disabled ? '' : 'hover:border-gray-400 hover:shadow active:scale-[0.98]'}`}
    >
      <CardBody card={card} />
    </button>
  );
}

function MiniCard({ card }) {
  if (!card) {
    return (
      <div className="w-full border border-gray-200 rounded bg-gray-50/40"
           style={{ aspectRatio: CARD_ASPECT }} />
    );
  }
  return (
    <div style={{ aspectRatio: CARD_ASPECT }}
         className="relative w-full border border-gray-300 rounded bg-white overflow-hidden shadow-sm">
      <CardBody card={card} />
    </div>
  );
}

function SharedSvgDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        {COLOR_KEYS.map((c) => (
          <pattern key={c} id={`stripes-${c}`}
                   patternUnits="userSpaceOnUse" width="5" height="5">
            <rect width="5" height="5" fill="white" />
            <line x1="0" y1="0" x2="0" y2="5" stroke={COLORS[c]} strokeWidth="1.8" />
          </pattern>
        ))}
      </defs>
    </svg>
  );
}

function PreviewModeBanner() {
  if (USE_SUPABASE) return null;
  if (hasStorage()) return null;
  return (
    <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-xs px-3 py-1.5 text-center">
      <strong>Local mode</strong> — results save to this browser only. Set
      SUPABASE_URL and SUPABASE_KEY at the top of App.jsx to enable the
      shared leaderboard.
    </div>
  );
}

// ===== Header (brand bar) =====
function Header({ dateKey }) {
  return (
    <header className="bg-red-700 text-white py-2.5 px-4 shadow-md">
      <div className="max-w-6xl mx-auto text-center">
        <h1 className="text-base sm:text-lg font-semibold tracking-wide leading-tight"
            style={{ fontFamily: '"Georgia", serif' }}>
          The Daily <span className="italic">SET</span> Puzzle
        </h1>
        {dateKey && (
          <p className="text-[11px] text-red-100 mt-0.5">{formatLongDate(dateKey)}</p>
        )}
      </div>
    </header>
  );
}

// ===== Tab bar =====
function TabBar({ activeTab, onChange }) {
  const tabs = [
    { id: 'game', label: "Today's Puzzle" },
    { id: 'archives', label: 'Archives' },
    // { id: 'survivor', label: 'Weekly Puzzle' },  // hidden — WIP, re-enable to restore
    { id: 'stats', label: 'Stats' },
  ];
  return (
    <nav className="bg-white border-b border-stone-200">
      <div className="max-w-6xl mx-auto flex">
        {tabs.map(t => {
          const isActive = activeTab === t.id;
          return (
            <button key={t.id}
              onClick={() => onChange(t.id)}
              className={`flex-1 px-2 py-3 text-sm font-medium transition-colors relative
                         ${isActive
                           ? 'text-red-700'
                           : 'text-stone-500 hover:text-stone-800'}`}>
              {t.label}
              {isActive && (
                <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-red-700" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// ===== Name entry (own screen, no chrome) =====
// onSubmit(name, syncCode) resolves to a status string: 'ok' | 'taken' |
// 'invalid' | 'unavailable'. On 'taken' we reveal the sync-code field, which
// is how someone reclaims their own name on a new device (or after clearing
// their browser). mySecret, when present, is shown as this device's own sync
// code so it can be copied to another phone.
function NameEntry({ initial, onSubmit, onCancel, mySecret }) {
  const [input, setInput] = useState(initial || '');
  const [syncCode, setSyncCode] = useState('');
  const [showSync, setShowSync] = useState(false);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const trimmed = input.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 20;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setStatus(null);
    const res = await onSubmit(trimmed, showSync ? syncCode.trim() : '');
    setBusy(false);
    if (res === 'taken') { setStatus('taken'); setShowSync(true); }
    else if (res === 'invalid') setStatus('invalid');
    else if (res === 'unavailable') setStatus('unavailable');
  };

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(mySecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4"
         style={{ fontFamily: '"Inter", system-ui, sans-serif' }}>
      <div className="bg-white rounded-xl p-6 max-w-md w-full shadow-lg">
        <h1 className="text-2xl font-bold mb-1 text-center"
            style={{ fontFamily: '"Georgia", serif' }}>
          The Daily <span className="italic text-red-700">SET</span> Puzzle
        </h1>
        <p className="text-stone-600 text-sm text-center mb-5">
          A fresh 6-set puzzle every day. Same puzzle for everyone.
        </p>

        <label className="block text-sm font-medium text-stone-700 mb-1">Your name</label>
        <input
          type="text" value={input}
          onChange={(e) => { setInput(e.target.value); setStatus(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          maxLength={20}
          placeholder="e.g. Aaron"
          autoFocus
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2
                     ${status === 'taken'
                       ? 'border-red-400 focus:ring-red-500'
                       : 'border-stone-300 focus:ring-red-500'}`}
        />

        {status === 'taken' && (
          <div className="mt-2 text-sm text-red-700 bg-red-50 border border-red-200
                          rounded-md px-3 py-2">
            <strong>That name's taken.</strong> Pick a different one — or, if it's
            yours, paste your sync code below to claim it on this device.
          </div>
        )}
        {status === 'invalid' && (
          <p className="mt-2 text-sm text-red-700">That name can't be used. Try another.</p>
        )}
        {status === 'unavailable' && (
          <p className="mt-2 text-sm text-amber-700">
            Couldn't reach the server. Check your connection and try again.
          </p>
        )}

        {showSync && (
          <div className="mt-3">
            <label className="block text-sm font-medium text-stone-700 mb-1">
              Sync code <span className="text-stone-400 font-normal">(optional)</span>
            </label>
            <input
              type="text" value={syncCode}
              onChange={(e) => setSyncCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="Paste the code from your other device"
              className="w-full px-3 py-2 border border-stone-300 rounded-md text-sm
                         focus:outline-none focus:ring-2 focus:ring-red-500"
              style={{ fontFamily: '"Menlo", monospace' }}
            />
            <p className="text-xs text-stone-400 mt-1">
              Find it under “Change name” on the device you normally play on.
            </p>
          </div>
        )}

        <div className="flex gap-2 mt-3">
          {onCancel && (
            <button onClick={onCancel}
              className="flex-1 px-4 py-2 bg-stone-100 hover:bg-stone-200
                         text-stone-700 rounded-md font-medium transition-colors">
              Cancel
            </button>
          )}
          <button
            onClick={submit}
            disabled={!valid || busy}
            className="flex-1 px-4 py-2 bg-red-700 hover:bg-red-800 text-white
                       rounded-md font-medium
                       disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors"
          >
            {busy ? 'Checking…' : initial ? 'Save' : 'Start playing'}
          </button>
        </div>

        {mySecret && (
          <div className="mt-5 pt-4 border-t border-stone-200">
            <div className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold mb-1">
              Your sync code
            </div>
            <p className="text-xs text-stone-500 mb-2 leading-relaxed">
              This is what proves this name is yours. Paste it into another device
              to play as <strong>{initial}</strong> there. Keep it to yourself.
            </p>
            <div className="flex gap-2">
              <input
                readOnly value={mySecret}
                onFocus={(e) => e.target.select()}
                className="flex-1 min-w-0 px-2 py-1.5 bg-stone-50 border border-stone-200
                           rounded text-xs text-stone-600"
                style={{ fontFamily: '"Menlo", monospace' }}
              />
              <button onClick={copySecret}
                className="px-3 py-1.5 bg-stone-100 hover:bg-stone-200 rounded
                           text-xs font-medium text-stone-700 transition-colors flex-shrink-0">
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-stone-400 mt-3 text-center">
          Your name and times will be visible to others playing this puzzle.
        </p>
      </div>
    </div>
  );
}

// ===== Leaderboard =====
function Leaderboard({ results, currentName, onPlayerClick }) {
  const entries = Object.entries(results).sort((a, b) => a[1].time - b[1].time);
  if (entries.length === 0) {
    return (
      <div className="text-center text-stone-400 text-sm italic py-3">
        No times yet — be the first!
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {entries.map(([n, r], i) => {
        const isMe = n === currentName;
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null;
        const NameTag = onPlayerClick ? 'button' : 'span';
        return (
          <div key={n}
               className={`flex items-center justify-between px-3 py-2 rounded-md
                          ${isMe ? 'bg-red-50 border border-red-200' : 'bg-stone-50'}`}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base w-5 inline-block text-center">
                {medal || <span className="text-stone-400 text-sm">{i + 1}</span>}
              </span>
              <NameTag
                onClick={onPlayerClick ? () => onPlayerClick(n) : undefined}
                className={`text-sm font-medium truncate text-left
                           ${isMe ? 'text-red-800' : 'text-stone-800'}
                           ${onPlayerClick ? 'hover:underline underline-offset-2 cursor-pointer' : ''}`}>
                {n}{isMe && <span className="text-stone-400 font-normal"> (you)</span>}
              </NameTag>
            </div>
            <span className="font-mono text-sm tabular-nums text-stone-700 ml-2 flex-shrink-0"
                  style={{ fontFamily: '"Menlo", monospace' }}>
              {formatMmSs(r.time)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ===== Stat card =====
function StatCard({ label, value, sub, accent }) {
  return (
    <div className="bg-white rounded-md shadow-sm p-3 text-center">
      <div className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 tabular-nums ${accent || 'text-stone-800'}`}
           style={{ fontFamily: typeof value === 'string' && value.includes(':') ? '"Menlo", monospace' : undefined }}>
        {value}
        {sub && <span className="text-sm text-stone-400 font-normal ml-1">{sub}</span>}
      </div>
    </div>
  );
}

// ===== Difficulty badge =====
// Shows a 1-3 filled-star rating with an optional word label ("Medium").
// When onClick is provided, renders as a button with a small info icon so it
// reads as an interactive element that explains itself when tapped.
// Three buckets: easy / medium / hard -> 1 / 2 / 3 filled stars.
const DIFFICULTY_TIERS = {
  'easy':   { stars: 1, label: 'Easy',   color: '#15803d' },
  'medium': { stars: 2, label: 'Medium', color: '#d97706' },
  'hard':   { stars: 3, label: 'Hard',   color: '#b91c1c' },
};
const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];

function DifficultyBadge({ difficulty, showLabel = false, onClick, className = '' }) {
  if (!difficulty) return null;
  const { level } = difficulty;
  const tier = DIFFICULTY_TIERS[level] || DIFFICULTY_TIERS['medium'];
  const { stars, label } = tier;
  const inner = (
    <span className={`inline-flex items-baseline gap-1 ${className}`}>
      <span aria-label={`${label} — ${stars} of 3 stars`} className="text-red-600"
            style={{ whiteSpace: 'nowrap', letterSpacing: '0.05em' }}>
        {'★'.repeat(stars)}<span className="text-stone-300">{'★'.repeat(3 - stars)}</span>
      </span>
      {showLabel && <span className="text-stone-600 font-medium">{label}</span>}
      {onClick && (
        <span className="text-stone-400 ml-0.5" aria-hidden="true"
              style={{ fontSize: '0.9em' }}>ⓘ</span>
      )}
    </span>
  );
  if (onClick) {
    return (
      <button onClick={(e) => { e.stopPropagation(); onClick(); }}
              className="hover:text-red-700 transition-colors cursor-pointer"
              title="How is difficulty scored?">
        {inner}
      </button>
    );
  }
  return inner;
}

// ===== Pause overlay (replaces cards while paused) =====
// Like the in-game header, the pause screen deliberately doesn't show elapsed
// time — that's reserved for the completion screen.
function PauseOverlay({ foundCount, targetCount, onResume }) {
  return (
    <div className="bg-white rounded-lg border-2 border-stone-200 shadow-sm
                    flex flex-col items-center justify-center text-center py-16 px-6"
         style={{ minHeight: '380px' }}>
      <div className="text-5xl mb-3">⏸</div>
      <h2 className="text-lg font-semibold text-stone-600 mb-2">Paused</h2>
      <p className="text-sm text-stone-500 mb-6">
        {foundCount} / {targetCount} sets found
      </p>
      <button onClick={onResume}
        className="px-8 py-3 bg-red-700 hover:bg-red-800 text-white
                   rounded-md font-semibold transition-colors shadow-sm text-lg">
        Resume →
      </button>
    </div>
  );
}

// ===== Game content (active timer + cards/overlay + sidebar) =====
// The timer runs the whole time but is hidden during play — the player only
// sees their final time on the completion screen. This reduces clock anxiety
// and keeps the focus on the puzzle itself.
function GameContent({ puzzle, targetSets, time, foundSets, selected, flash,
                       userPaused, name, isPlayingToday, activeDate,
                       onToggle, onPause, onResume, onRename, onOpenScoring }) {
  const difficulty = useMemo(() => computePuzzleDifficulty(puzzle), [puzzle]);
  return (
    <>
      <div className="text-center pt-3 pb-1">
        {!userPaused && (
          <div className="flex items-center justify-center">
            <button onClick={onPause}
              className="px-3 py-1.5 text-stone-600 hover:text-stone-900 hover:bg-stone-200
                         rounded text-sm font-medium transition-colors"
              title="Pause">
              ⏸ Pause
            </button>
          </div>
        )}
        <div className="text-xs text-stone-500 mt-1 flex items-center justify-center gap-2 flex-wrap">
          {/* Difficulty stays hidden for today's puzzle until it's solved,
              so it can't anchor expectations mid-solve. Archived puzzles
              show it up front. */}
          {difficulty && !isPlayingToday && (
            <>
              <DifficultyBadge difficulty={difficulty} showLabel
                               onClick={onOpenScoring} />
              <span className="text-stone-300">·</span>
            </>
          )}
          <span>{foundSets.length} / {targetSets} sets found</span>
          <span className="text-stone-300">·</span>
          <span>
            playing as{' '}
            <button onClick={onRename}
                    className="underline underline-offset-2 hover:text-stone-700">
              {name}
            </button>
          </span>
        </div>
        {!isPlayingToday && (
          <div className="text-xs text-stone-500 mt-0.5 italic">
            Archived puzzle from {formatShortDate(activeDate)}
          </div>
        )}
      </div>

      <main className="flex-1 flex flex-col lg:flex-row gap-4 p-3 max-w-6xl w-full mx-auto">
        <section className="flex-1">
          {userPaused ? (
            <PauseOverlay
              foundCount={foundSets.length}
              targetCount={targetSets}
              onResume={onResume}
            />
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2 sm:gap-3">
                {puzzle.cards.map((card, i) => {
                  const isSel = selected.includes(i);
                  const isFlashing = isSel && flash ? flash : null;
                  return (
                    <GameCard key={i} card={card}
                              selected={isSel} flashing={isFlashing}
                              onClick={() => onToggle(i)} />
                  );
                })}
              </div>
              <div className="h-6 text-center text-sm mt-3 font-medium">
                {flash === 'bad' && <span className="text-red-600">Not a SET</span>}
                {flash === 'dup' && <span className="text-amber-600">Already found</span>}
                {!flash && selected.length > 0 && (
                  <span className="text-stone-500">{selected.length} selected</span>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="lg:w-72 lg:flex-shrink-0">
          <div className="text-center text-sm italic text-stone-600 mb-2"
               style={{ fontFamily: '"Georgia", serif' }}>
            <span className="font-semibold">SETs</span> Found{' '}
            <span className="text-stone-400 not-italic">({foundSets.length}/{targetSets})</span>
          </div>
          <div className="bg-white rounded-md border border-stone-300 p-2 shadow-sm">
            <div className="grid grid-cols-3 gap-1.5">
              {Array.from({ length: targetSets }).flatMap((_, row) =>
                Array.from({ length: 3 }).map((_, col) => {
                  const set = foundSets[row];
                  const card = set ? puzzle.cards[set.indices[col]] : null;
                  return <MiniCard key={`${row}-${col}`} card={card} />;
                })
              )}
            </div>
          </div>
        </aside>
      </main>
    </>
  );
}

// ===== Personal history panel (completion screen) =====
// Shows how this puzzle's time compares to the player's own track record —
// a histogram of their own times with this one marked, plus a plain-language
// callout. Renders nothing below MIN_HISTORY_FOR_PANEL games: a histogram of
// three points isn't a distribution, it's noise, and would just confuse a
// new player rather than orient them.
function PersonalHistoryCard({ myResults, thisTime, thisDateKey }) {
  // Exclude this puzzle's own entry from the comparison set by date, not by
  // matching its time value — matching by value would let today's row tie
  // with itself and silently inflate "faster than X%" past 100%.
  const { totalN, otherTimes, allTimes } = useMemo(() => {
    const entries = Object.entries(myResults || {});
    const all = entries.map(([, r]) => r.time).filter((t) => typeof t === 'number');
    const other = entries
      .filter(([d]) => d !== thisDateKey)
      .map(([, r]) => r.time)
      .filter((t) => typeof t === 'number');
    return { totalN: all.length, otherTimes: other, allTimes: all };
  }, [myResults, thisDateKey]);

  const stats = useMemo(() => {
    if (totalN < MIN_HISTORY_FOR_PANEL) return null;
    const slower = otherTimes.filter((t) => t > thisTime + 0.005).length;
    const faster = otherTimes.filter((t) => t < thisTime - 0.005).length;
    const tied = otherTimes.length - slower - faster;
    // "Faster than X% of your games" — measured against every OTHER game,
    // so today doesn't count itself. Ties split credit between the two sides.
    const fasterThanPct = otherTimes.length > 0
      ? Math.round(((slower + tied / 2) / otherTimes.length) * 100)
      : 100;
    const rank = faster + Math.ceil(tied / 2) + 1; // 1 = personal best
    const hist = buildPersonalHistogram(allTimes, thisTime, 7);
    return { fasterThanPct, rank, hist };
  }, [otherTimes, allTimes, thisTime, totalN]);

  if (!stats) return null;
  const { fasterThanPct, rank, hist } = stats;
  const n = totalN;

  return (
    <div className="border-t border-stone-200 pt-4 mt-4">
      <h3 className="text-sm font-semibold text-stone-700 mb-2">
        Vs. your own history <span className="text-stone-400 font-normal">· {n} games</span>
      </h3>
      <div className="bg-stone-50 rounded-md p-3 pt-5">
        <div className="relative" style={{ height: '56px' }}>
          {!hist.flat && (
            <>
              <div className="absolute w-px bg-red-600" style={{ left: `${hist.thisPct}%`, top: 0, bottom: 0 }} />
              <div className="absolute text-[9px] font-semibold text-red-700 whitespace-nowrap"
                   style={{ left: `${hist.thisPct}%`, top: '-15px', transform: 'translateX(-50%)' }}>
                this {formatMmSs(thisTime)}
              </div>
            </>
          )}
          <div className="absolute inset-0 flex items-end gap-1">
            {hist.bins.map((count, i) => {
              const maxCount = Math.max(...hist.bins, 1);
              const heightPct = count === 0 ? 0 : Math.max(10, Math.round((count / maxCount) * 100));
              const isThisBin = i === hist.thisIdx;
              return (
                <div key={i}
                     className={`flex-1 rounded-t transition-all ${isThisBin ? 'bg-red-300' : 'bg-stone-300'}`}
                     style={{ height: `${heightPct}%` }} />
              );
            })}
          </div>
        </div>
        {!hist.flat && (
          <div className="flex justify-between text-[10px] text-stone-400 mt-1 font-mono"
               style={{ fontFamily: '"Menlo", monospace' }}>
            <span>{formatMmSs(hist.min)}</span>
            <span>{formatMmSs(hist.max)}</span>
          </div>
        )}
      </div>
      <p className="text-sm text-stone-700 mt-2">
        <span className="text-red-700 font-semibold">Faster than {fasterThanPct}%</span> of your games
        <span className="text-stone-400"> · </span>
        your <span className="font-semibold">{ordinal(rank)}-best</span> ever
      </p>
    </div>
  );
}

// ===== Completed content =====
function CompletedContent({ result, leaderboard, name, isPlayingToday, dateKey,
                            msUntilTomorrow, puzzle, myResults, onPlayToday, onPlayerClick,
                            nextUnplayedDate, onPlayDate,
                            onRefresh, refreshing, onRename, onOpenScoring }) {
  const difficulty = useMemo(() => computePuzzleDifficulty(puzzle), [puzzle]);
  // Rank within today's field, derived from the same leaderboard data already
  // being fetched — no extra query, just a small header callout.
  const rankInfo = useMemo(() => {
    const entries = Object.entries(leaderboard).sort((a, b) => a[1].time - b[1].time);
    const idx = entries.findIndex(([n]) => n === name);
    if (idx === -1 || entries.length < 2) return null;
    return { rank: idx + 1, total: entries.length };
  }, [leaderboard, name]);
  return (
    <main className="flex-1 flex items-start justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-md p-6">
        <div className="text-center mb-4">
          <div className="text-5xl mb-1">🏆</div>
          <h2 className="text-xl font-bold"
              style={{ fontFamily: '"Georgia", serif' }}>
            {isPlayingToday ? "You finished today's puzzle!" : "Puzzle complete!"}
          </h2>
          <p className="text-4xl font-mono font-bold text-red-700 mt-2 tabular-nums"
             style={{ fontFamily: '"Menlo", monospace' }}>
            {formatMmSs(result.time)}
          </p>
          {!isPlayingToday && (
            <p className="text-xs text-stone-500 mt-1">
              Archived puzzle · {formatShortDate(dateKey)}
            </p>
          )}
          {difficulty && (
            <div className="mt-3 flex flex-col items-center gap-1">
              <div className="inline-flex items-baseline gap-1.5 px-3 py-1
                              bg-stone-100 rounded-full text-sm">
                <span className="text-stone-500 text-xs uppercase tracking-wider font-semibold">
                  Difficulty
                </span>
                <DifficultyBadge difficulty={difficulty} showLabel />
              </div>
              {onOpenScoring && (
                <button onClick={onOpenScoring}
                  className="text-xs text-red-700 hover:text-red-900
                             underline underline-offset-2 font-medium
                             transition-colors mt-1">
                  How is difficulty calculated? →
                </button>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-stone-200 pt-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-stone-700">
              Leaderboard
              {rankInfo && (
                <span className="text-stone-400 font-normal">
                  {' '}· you're {ordinal(rankInfo.rank)} of {rankInfo.total}
                </span>
              )}
            </h3>
            <button onClick={onRefresh} disabled={refreshing}
              className="text-xs text-stone-500 hover:text-stone-700 disabled:opacity-50">
              {refreshing ? 'Refreshing…' : '↻ Refresh'}
            </button>
          </div>
          <Leaderboard results={leaderboard} currentName={name} onPlayerClick={onPlayerClick} />
        </div>

        <PersonalHistoryCard myResults={myResults} thisTime={result.time} thisDateKey={dateKey} />

        <div className="flex flex-col items-center gap-3 mt-4">
          {isPlayingToday ? (
            <>
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full
                              bg-stone-100 text-stone-600 text-xs font-medium">
                <span>⏱</span>
                <span>Next puzzle in {formatCountdown(msUntilTomorrow)}</span>
              </div>
              {nextUnplayedDate && (
                <button onClick={() => onPlayDate(nextUnplayedDate)}
                  className="px-4 py-2 bg-red-700 hover:bg-red-800 text-white rounded-md
                             text-sm font-medium transition-colors">
                  Play another from the archives →
                </button>
              )}
            </>
          ) : (
            <>
              {nextUnplayedDate && (
                <button onClick={() => onPlayDate(nextUnplayedDate)}
                  className="px-4 py-2 bg-red-700 hover:bg-red-800 text-white rounded-md
                             text-sm font-medium transition-colors">
                  Play another from the archives →
                </button>
              )}
              <button onClick={onPlayToday}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors
                           ${nextUnplayedDate
                             ? 'bg-stone-100 hover:bg-stone-200 text-stone-700'
                             : 'bg-red-700 hover:bg-red-800 text-white'}`}>
                Play today's puzzle →
              </button>
            </>
          )}
          <button onClick={onRename}
            className="text-xs text-stone-400 hover:text-stone-600">
            Playing as <span className="font-medium">{name}</span> · Change name
          </button>
        </div>
      </div>
    </main>
  );
}

// ===== Archives content =====
// NYT-style monthly calendar. Each cell shows just the day number; the cell
// background carries completion state (solid red = solved, white card =
// unplayed past, dashed faded = future, red ring = today). Solved cells get a
// small medal in the corner when the player ranked 1st/2nd/3rd among 2+
// players that day. Tapping a cell expands a detail strip below with the
// puzzle's difficulty, the player's time (if solved), rank info, and a
// play/play-again button. Month nav arrows let users browse any prior month.
function ArchivesContent({ myResults, todayKey, currentName,
                           onPlayDate, onOpenScoring }) {
  const todayMonth = todayKey.substring(0, 7);  // "2026-05"
  const [viewMonth, setViewMonth] = useState(todayMonth);
  const [selectedDate, setSelectedDate] = useState(todayKey);

  // Cross-player history is needed to compute medals (rank among everyone who
  // solved that day). This is the same query the stats page uses, so it's
  // already cached on the backend side for short windows.
  const [allHistory, setAllHistory] = useState({});
  useEffect(() => { Storage.loadAllHistory().then(setAllHistory); }, []);

  // === Lifetime stats (overall, not per visible month — the calendar lets
  // you browse around but your numbers stay yours) ===
  const lifetime = useMemo(() => {
    const dates = Object.keys(myResults);
    const played = dates.length;
    const times = dates.map((d) => myResults[d].time).filter((t) => t != null);
    const best = times.length ? Math.min(...times) : null;
    const playedSet = new Set(dates);
    let streak = 0;
    let cursor = todayKey;
    if (!playedSet.has(cursor)) {
      cursor = utcDateKey(new Date(dateKeyToUTC(cursor) - 86400000));
    }
    while (playedSet.has(cursor)) {
      streak++;
      cursor = utcDateKey(new Date(dateKeyToUTC(cursor) - 86400000));
    }
    return { played, best, streak };
  }, [myResults, todayKey]);

  // === Month grid generation ===
  const monthCells = useMemo(() => {
    const [y, m] = viewMonth.split('-').map(Number);
    const firstDayOfWeek = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
    for (let d = 1; d <= lastDay; d++) {
      const dateKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, dateKey });
    }
    return cells;
  }, [viewMonth]);

  const monthLabel = useMemo(() => {
    const [y, m] = viewMonth.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', timeZone: 'UTC',
    });
  }, [viewMonth]);

  // Forward nav stops at today's month — no future months to browse.
  const canGoForward = viewMonth < todayMonth;

  const changeMonth = (delta) => {
    const [y, m] = viewMonth.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1 + delta, 1));
    const newMonth = utcDateKey(next).substring(0, 7);
    setViewMonth(newMonth);
    // Auto-select a useful day in the new month so the detail strip stays
    // populated: today for the current month, otherwise the last day of that
    // month (so any solved-day medals are visible right away).
    if (newMonth === todayMonth) {
      setSelectedDate(todayKey);
    } else {
      const [ny, nm] = newMonth.split('-').map(Number);
      const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
      setSelectedDate(`${ny}-${String(nm).padStart(2, '0')}-${String(last).padStart(2, '0')}`);
    }
  };

  // === Medal computation per date (for the current player) ===
  // Only awarded when 2+ players solved that day — no rank in a solo round.
  const medalFor = (dateKey) => {
    const dateResults = allHistory[dateKey];
    if (!dateResults || !dateResults[currentName]) return null;
    const entries = Object.entries(dateResults);
    if (entries.length < 2) return null;
    const sorted = entries.sort((a, b) => a[1].time - b[1].time);
    const rank = sorted.findIndex(([n]) => n === currentName);
    return rank === 0 ? 'gold' : rank === 1 ? 'silver' : rank === 2 ? 'bronze' : null;
  };
  const playerCount = (dateKey) =>
    Object.keys(allHistory[dateKey] || {}).length;

  // === Selected day info for the detail strip ===
  // Difficulty is computed only for the selected date (one generateDailyPuzzle
  // per selection, ~50ms worst case) rather than for every visible cell.
  const selectedInfo = useMemo(() => {
    if (!selectedDate) return null;
    const result = myResults[selectedDate];
    const isToday = selectedDate === todayKey;
    const isFuture = selectedDate > todayKey;
    const medal = result ? medalFor(selectedDate) : null;
    const count = playerCount(selectedDate);
    const difficulty = computePuzzleDifficulty(generateDailyPuzzle(selectedDate));
    return { result, isToday, isFuture, medal, count, difficulty };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, myResults, allHistory, todayKey]);

  const MEDAL = { gold: '🥇', silver: '🥈', bronze: '🥉' };
  const RANK_WORD = { gold: '1st', silver: '2nd', bronze: '3rd' };

  return (
    <main className="flex-1 p-3 max-w-md w-full mx-auto">
      {/* Lifetime stats */}
      <div className="bg-white rounded-md shadow-sm mb-4 p-4">
        <div className="grid grid-cols-3 gap-2 divide-x divide-stone-200">
          <div className="text-center">
            <div className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">Played</div>
            <div className="text-xl font-semibold text-stone-800 mt-0.5 tabular-nums">
              {lifetime.played}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">Streak</div>
            <div className="text-xl font-semibold text-red-700 mt-0.5 tabular-nums">
              {lifetime.streak}<span className="text-sm text-stone-500 font-normal ml-1">
                {lifetime.streak === 1 ? 'day' : 'days'}
              </span>
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">Best</div>
            <div className="text-xl font-semibold text-stone-800 mt-0.5 tabular-nums"
                 style={{ fontFamily: '"Menlo", monospace' }}>
              {lifetime.best != null ? formatMmSs(lifetime.best) : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Month navigation */}
      <div className="flex items-center justify-between mb-3 px-1">
        <button onClick={() => changeMonth(-1)}
          aria-label="Previous month"
          className="w-9 h-9 flex items-center justify-center rounded-md
                     border border-stone-300 text-stone-600 hover:bg-stone-100
                     transition-colors text-lg leading-none">
          ‹
        </button>
        <span className="text-base font-semibold text-stone-800"
              style={{ fontFamily: '"Georgia", serif' }}>
          {monthLabel}
        </span>
        <button onClick={() => changeMonth(1)}
          disabled={!canGoForward}
          aria-label="Next month"
          className="w-9 h-9 flex items-center justify-center rounded-md
                     border border-stone-300 text-stone-600 hover:bg-stone-100
                     disabled:opacity-30 disabled:cursor-not-allowed
                     transition-colors text-lg leading-none">
          ›
        </button>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 gap-1.5 mb-1.5 px-1">
        {['S','M','T','W','T','F','S'].map((d, i) => (
          <div key={i}
               className="text-center text-[10px] text-stone-400 uppercase font-semibold tracking-wider">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1.5 px-1">
        {monthCells.map((cell, idx) => {
          if (!cell) return <div key={`empty-${idx}`} className="aspect-square" />;
          const { day, dateKey } = cell;
          const result = myResults[dateKey];
          const isToday = dateKey === todayKey;
          const isFuture = dateKey > todayKey;
          const isSelected = dateKey === selectedDate;
          const solved = !!result;
          const medal = solved ? medalFor(dateKey) : null;

          const stateClass = solved
            ? 'bg-red-700 text-white border-0'
            : isFuture
              ? 'bg-transparent text-stone-400 border border-dashed border-stone-300 opacity-55'
              : 'bg-white text-stone-900 border border-stone-200';

          // Today's red ring and the selection dark ring stack via box-shadow
          // because Tailwind's ring utilities don't easily compose two rings.
          const shadows = [];
          if (isToday) shadows.push('0 0 0 2px #B91C1C');
          if (isSelected) shadows.push(isToday ? '0 0 0 4px #292524' : '0 0 0 2px #292524');
          const inlineStyle = {
            boxShadow: shadows.length ? shadows.join(', ') : undefined,
            transform: isSelected ? 'scale(1.08)' : undefined,
            zIndex: isSelected ? 1 : undefined,
            touchAction: 'manipulation',
          };

          const label = `${dateKey}`
            + (solved ? ' solved' : isToday ? ' today' : isFuture ? ' future' : '')
            + (medal ? ` ${RANK_WORD[medal]} of ${playerCount(dateKey)} players` : '');

          return (
            <button key={dateKey}
              onClick={() => setSelectedDate(dateKey)}
              aria-label={label}
              style={inlineStyle}
              className={`aspect-square rounded-md text-sm font-medium
                          flex items-center justify-center relative select-none
                          transition-transform duration-100 ${stateClass}`}>
              {day}
              {medal && (
                <span aria-hidden="true"
                  className="absolute"
                  style={{ top: 1, right: 2, fontSize: 11, lineHeight: 1,
                           filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.35))' }}>
                  {MEDAL[medal]}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Detail strip for the selected day */}
      {selectedInfo && (
        <ArchiveDetailStrip
          dateKey={selectedDate}
          info={selectedInfo}
          MEDAL={MEDAL}
          RANK_WORD={RANK_WORD}
          onPlay={() => onPlayDate(selectedDate)}
          onOpenScoring={onOpenScoring}
        />
      )}

      {/* Legend */}
      <div className="flex items-center gap-3 mt-3 text-[11px] text-stone-500 flex-wrap px-1">
        <span className="flex items-center gap-1.5">
          <span className="w-3.5 h-3.5 rounded-sm bg-red-700" />
          solved
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3.5 h-3.5 rounded-sm bg-white border border-stone-300" />
          not played
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3.5 h-3.5 rounded-sm"
                style={{ boxShadow: 'inset 0 0 0 2px #B91C1C' }} />
          today
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true">🥇🥈🥉</span>
          <span>daily rank</span>
        </span>
      </div>

      <p className="text-[11px] text-stone-400 text-center mt-4 mb-2">
        A new puzzle drops every day at midnight UTC.
      </p>
    </main>
  );
}

// Detail strip rendered below the calendar grid, varying its layout by whether
// the selected day was solved, is today, is in the future, or is an unplayed
// past day.
function ArchiveDetailStrip({ dateKey, info, MEDAL, RANK_WORD,
                              onPlay, onOpenScoring }) {
  const { result, isToday, isFuture, medal, count, difficulty } = info;
  const dateLong = formatLongDate(dateKey);
  const wrap = "bg-white border border-stone-200 rounded-md mt-4 p-4 shadow-sm";

  if (isToday && !result) {
    return (
      <div className={wrap}>
        <div className="flex items-start justify-between mb-3 gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-red-700 font-semibold">
              Today
            </div>
            <div className="text-base font-medium mt-0.5"
                 style={{ fontFamily: '"Georgia", serif' }}>
              {dateLong}
            </div>
          </div>
          {/* No difficulty badge here: today's difficulty is hidden until
              the puzzle is solved. */}
        </div>
        <button onClick={onPlay}
          className="w-full bg-red-700 hover:bg-red-800 text-white rounded-md
                     py-2.5 text-sm font-medium transition-colors">
          Play today's puzzle →
        </button>
      </div>
    );
  }

  if (result) {
    return (
      <div className={wrap}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="text-base font-medium"
                 style={{ fontFamily: '"Georgia", serif' }}>
              {dateLong}
            </div>
            <div className="text-xs text-stone-500 mt-1 flex items-center gap-1.5 flex-wrap">
              <span>solved</span>
              {difficulty && (
                <>
                  <span className="text-stone-300">·</span>
                  <DifficultyBadge difficulty={difficulty} onClick={onOpenScoring} />
                </>
              )}
            </div>
            {medal && (
              <div className="text-xs text-stone-700 mt-1.5 inline-flex items-center gap-1">
                <span aria-hidden="true">{MEDAL[medal]}</span>
                <span>{RANK_WORD[medal]} of {count} players</span>
              </div>
            )}
          </div>
          <div className="text-2xl font-semibold text-red-700 tabular-nums flex-shrink-0"
               style={{ fontFamily: '"Menlo", monospace' }}>
            {formatMmSs(result.time)}
          </div>
        </div>
        <button onClick={onPlay}
          className="w-full bg-transparent hover:bg-stone-50 border border-stone-300
                     text-stone-700 rounded-md py-2 text-sm font-medium
                     transition-colors">
          Play again
        </button>
      </div>
    );
  }

  if (isFuture) {
    return (
      <div className={wrap}>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-base font-medium text-stone-600"
                 style={{ fontFamily: '"Georgia", serif' }}>
              {dateLong}
            </div>
            <div className="text-xs text-stone-400 mt-1">
              Drops at midnight UTC
            </div>
          </div>
          <span className="text-stone-400 text-lg" aria-hidden="true">🔒</span>
        </div>
      </div>
    );
  }

  // Unsolved past
  return (
    <div className={wrap}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="text-base font-medium"
               style={{ fontFamily: '"Georgia", serif' }}>
            {dateLong}
          </div>
          <div className="text-xs text-stone-500 mt-1 flex items-center gap-1.5 flex-wrap">
            <span>not played</span>
            {difficulty && (
              <>
                <span className="text-stone-300">·</span>
                <DifficultyBadge difficulty={difficulty} onClick={onOpenScoring} />
              </>
            )}
          </div>
        </div>
      </div>
      <button onClick={onPlay}
        className="w-full bg-red-700 hover:bg-red-800 text-white rounded-md
                   py-2.5 text-sm font-medium transition-colors">
        Play this puzzle →
      </button>
    </div>
  );
}

// ===== Stats content (Option C: segmented Players / Day-by-day) =====
// Design rule: no element's size depends on player count. Regulars (3+
// solves) get rich ranked rows; drive-by visitors collapse behind a toggle.
// The old dates-x-players matrix is replaced by constant-width day rows
// that expand on tap.

const REGULAR_MIN_SOLVES = 3;
// Minimum solves in a difficulty tier before we show that tier's average.
const TIER_MIN_SOLVES = 5;
const DAYS_PAGE = 14;

// Tiny trend line of a player's last few solves (chronological; lower =
// better, so a falling line means improvement).
// Compact 1-3 star glyph used as a column header in the Players table.
// Filled stars stay red so they read as the same rating shown on a puzzle;
// the header colours itself when its column is the active sort.
function TierStars({ stars }) {
  return (
    <span style={{ whiteSpace: 'nowrap', letterSpacing: '-0.03em' }}>
      <span className="text-red-600">{'★'.repeat(stars)}</span>
      <span className="text-stone-300">{'★'.repeat(3 - stars)}</span>
    </span>
  );
}

function Sparkline({ times, accent }) {
  if (!times || times.length < 2) return null;
  const W = 92, H = 22, P = 3;
  const min = Math.min(...times), max = Math.max(...times);
  const span = max - min || 1;
  const xs = times.map((_, i) => P + (i * (W - 2 * P)) / (times.length - 1));
  const ys = times.map((t) => P + ((t - min) / span) * (H - 2 * P));
  const pts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const color = accent ? '#b91c1c' : '#78716c';
  return (
    <svg width={W} height={H} className="flex-shrink-0" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="2.2" fill={color} />
    </svg>
  );
}

function StatsContent({ onPlayerClick, currentName, todayKey, onOpenScoring }) {
  const [history, setHistory] = useState(null);
  const [tab, setTab] = useState('players');           // 'players' | 'days'
  const [showVisitors, setShowVisitors] = useState(false);
  // Players table sorting. Default: fastest overall average first.
  const [sortKey, setSortKey] = useState('avg');   // 'name'|'easy'|'medium'|'hard'|'avg'|'played'
  const [sortAsc, setSortAsc] = useState(true);
  const [daysShown, setDaysShown] = useState(DAYS_PAGE);
  const [expandedDays, setExpandedDays] = useState(() => new Set());
  // Weekly Survivor standings (lazy: fetched when the tab is first opened)
  const [survivorWeek, setSurvivorWeek] = useState(null);
  const [survivorPast, setSurvivorPast] = useState(null);
  const weekKey = utcIsoWeekKey();
  useEffect(() => { Storage.loadAllHistory().then(setHistory); }, []);
  useEffect(() => {
    if (tab !== 'weekly' || survivorWeek !== null) return;
    Storage.loadSurvivorWeek(weekKey).then(setSurvivorWeek);
    Storage.loadSurvivorChampions(weekKey).then(setSurvivorPast);
  }, [tab, survivorWeek, weekKey]);

  const dates = useMemo(
    () => (history ? Object.keys(history).sort().reverse() : []),
    [history]
  );

  // Difficulty for every date with results (deterministic from the date).
  // ~50ms worst case per date, runs once when history arrives.
  const difficulties = useMemo(() => {
    const map = {};
    for (const d of dates) map[d] = computePuzzleDifficulty(generateDailyPuzzle(d));
    return map;
  }, [dates]);

  // Per-player aggregates, including average time per difficulty tier.
  // A tier needs TIER_MIN_SOLVES samples before we show a number — below that
  // the "average" is one or two puzzles and reads as false precision.
  const players = useMemo(() => {
    if (!history) return [];
    const byName = {};
    for (const d of dates) {
      for (const [n, r] of Object.entries(history[d])) {
        (byName[n] ??= []).push({ date: d, time: r.time });
      }
    }
    const out = [];
    for (const [n, rows] of Object.entries(byName)) {
      rows.sort((a, b) => a.date.localeCompare(b.date));
      const times = rows.map((r) => r.time);
      const played = times.length;
      const best = Math.min(...times);
      const avg = Math.round((times.reduce((s, t) => s + t, 0) / played) * 100) / 100;

      // per-tier averages (null when too few solves to be meaningful)
      const tiers = {};
      for (const level of DIFFICULTY_ORDER) {
        const ts = rows
          .filter((r) => difficulties[r.date]?.level === level)
          .map((r) => r.time);
        tiers[level] = ts.length >= TIER_MIN_SOLVES
          ? Math.round((ts.reduce((s, t) => s + t, 0) / ts.length) * 100) / 100
          : null;
      }

      const playedSet = new Set(rows.map((r) => r.date));
      let streak = 0;
      let cursor = todayKey;
      if (!playedSet.has(cursor)) {
        cursor = utcDateKey(new Date(dateKeyToUTC(cursor) - 86400000));
      }
      while (playedSet.has(cursor)) {
        streak++;
        cursor = utcDateKey(new Date(dateKeyToUTC(cursor) - 86400000));
      }
      out.push({ name: n, played, best, avg, streak, tiers });
    }
    out.sort((a, b) => a.avg - b.avg);
    return out;
  }, [history, dates, difficulties, todayKey]);

  // The spotlight leader: fastest regular by overall average. `players` is
  // already avg-sorted, so the first regular is the leader regardless of how
  // the table below is currently sorted.
  const leader = useMemo(
    () => players.find((p) => p.played >= REGULAR_MIN_SOLVES) || null,
    [players]
  );

  // Sorted view of the regulars for the table. Nulls always sink to the
  // bottom regardless of direction, so an empty tier never wins a sort.
  const sortedRegulars = useMemo(() => {
    const regs = players.filter((p) => p.played >= REGULAR_MIN_SOLVES);
    const val = (p) => {
      if (sortKey === 'name') return null;
      if (sortKey === 'played') return p.played;
      if (sortKey === 'avg') return p.avg;
      return p.tiers[sortKey];  // 'easy' | 'medium' | 'hard'
    };
    const arr = [...regs];
    arr.sort((a, b) => {
      if (sortKey === 'name') {
        return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      }
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return a.avg - b.avg;
      if (av == null) return 1;   // nulls last, always
      if (bv == null) return -1;
      return sortAsc ? av - bv : bv - av;
    });
    return arr;
  }, [players, sortKey, sortAsc]);

  if (history === null) {
    return (
      <main className="flex-1 flex items-center justify-center text-stone-500">
        Loading stats…
      </main>
    );
  }

  if (dates.length === 0) {
    return (
      <main className="flex-1 p-3 max-w-2xl w-full mx-auto">
        <div className="text-center text-stone-500 italic mt-10">
          No games yet. Finish a puzzle to start tracking.
        </div>
      </main>
    );
  }

  const regulars = players.filter((p) => p.played >= REGULAR_MIN_SOLVES);
  const visitors = players.filter((p) => p.played < REGULAR_MIN_SOLVES);
  // Rank among regulars only — a visitor's single lucky solve shouldn't top
  // the board. Visitors are listed unranked.
  const rankOf = (p) => regulars.indexOf(p) + 1;

  const toggleDay = (date) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  return (
    <main className="flex-1 p-3 max-w-2xl w-full mx-auto">
      {/* segmented control */}
      <div className="flex bg-stone-200 rounded-lg p-0.5 mb-3">
        {[
          { id: 'players', label: 'Players' },
          { id: 'days', label: 'Day by day' },
          // { id: 'weekly', label: 'Weekly' },  // hidden with Weekly Puzzle
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 py-1.5 rounded-md text-sm font-semibold transition-colors
                       ${tab === t.id ? 'bg-white text-red-700 shadow-sm' : 'text-stone-500 hover:text-stone-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'players' && (
        <>
          {leader && (
            <button onClick={() => onPlayerClick(leader.name)}
              className="w-full mb-3 flex items-center gap-3 text-left rounded-lg overflow-hidden
                         shadow-sm border border-amber-200 px-3 py-3
                         transition-colors hover:brightness-[0.99]"
              style={{ background: 'linear-gradient(100deg, #fdf6e3, #ffffff 78%)' }}>
              <span className="text-2xl flex-shrink-0" aria-hidden="true">👑</span>
              <span className="flex-1 min-w-0">
                <span className="block text-lg font-bold text-stone-900 truncate"
                      style={{ fontFamily: '"Georgia", serif' }}>
                  {leader.name}
                  {leader.name === currentName && (
                    <span className="text-stone-400 font-normal text-sm"> (you)</span>
                  )}
                </span>
                <span className="block text-[11.5px] text-stone-600 truncate">
                  {leader.played} solves · fastest average
                  {leader.streak >= 2 && <> · 🔥 {leader.streak}-day streak</>}
                </span>
              </span>
              <span className="text-right flex-shrink-0">
                <span className="block text-xl font-bold tabular-nums"
                      style={{ fontFamily: '"Menlo", monospace', color: '#b08a24' }}>
                  {formatMmSs1(leader.avg)}
                </span>
                <span className="block text-[9px] uppercase tracking-wider text-stone-400 font-semibold">
                  avg
                </span>
              </span>
            </button>
          )}

          <div className="bg-white rounded-md shadow-sm overflow-hidden">
            <table className="w-full table-fixed border-collapse">
              {/* Fixed widths: the name column absorbs the slack (and truncates)
                  so the numeric columns can never be pushed off a narrow phone. */}
              <colgroup>
                <col style={{ width: '30%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '16%' }} />
              </colgroup>
              <thead>
                <tr>
                  {[
                    { k: 'name',   node: 'Player', align: 'left' },
                    { k: 'played', node: '#', align: 'right' },
                    { k: 'easy',   node: <TierStars stars={1} />, align: 'right' },
                    { k: 'medium', node: <TierStars stars={2} />, align: 'right' },
                    { k: 'hard',   node: <TierStars stars={3} />, align: 'right' },
                    { k: 'avg',    node: 'Avg', align: 'right' },
                  ].map(({ k, node, align }) => {
                    const active = sortKey === k;
                    return (
                      <th key={k}
                        onClick={() => {
                          if (sortKey === k) setSortAsc((v) => !v);
                          // times & name sort ascending first; counts descending first
                          else { setSortKey(k); setSortAsc(k !== 'played'); }
                        }}
                        className={`px-0.5 py-2 bg-stone-50 border-b border-stone-200
                                   text-[10px] uppercase tracking-tight font-bold whitespace-nowrap
                                   cursor-pointer select-none transition-colors
                                   hover:bg-stone-100
                                   ${align === 'left' ? 'text-left pl-2.5' : 'text-right'}
                                   ${k === 'played' ? 'pl-1' : ''}
                                   ${k === 'avg' ? 'pr-2' : ''}
                                   ${active ? 'text-red-700' : 'text-stone-400'}`}>
                        {node}
                        {active && (
                          <span className="ml-0.5 text-[8px]">{sortAsc ? '▲' : '▼'}</span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedRegulars.map((p, i) => {
                  const isMe = p.name === currentName;
                  const cell = (v) => v == null
                    ? <td className="px-0.5 py-2 text-right text-stone-300 border-b border-stone-100">—</td>
                    : <td className="px-0.5 py-2 text-right border-b border-stone-100 tabular-nums
                                     text-stone-600 text-[12px]"
                          style={{ fontFamily: '"Menlo", monospace' }}>{formatMmSs1(v)}</td>;
                  return (
                    <tr key={p.name}
                        onClick={() => onPlayerClick(p.name)}
                        className={`cursor-pointer transition-colors
                                   ${isMe ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-stone-50'}`}>
                      <td className={`px-0.5 pl-2.5 py-2 border-b border-stone-100 text-[12.5px]
                                     font-semibold whitespace-nowrap overflow-hidden text-ellipsis
                                     ${isMe ? 'text-red-800' : 'text-stone-800'}`}>
                        <span className="inline-block w-3.5 text-stone-400 font-normal text-[10.5px]">
                          {i + 1}
                        </span>
                        {p.name}
                        {isMe && <span className="text-stone-400 font-normal text-[10.5px]"> (you)</span>}
                      </td>
                      <td className="px-0.5 pl-1 py-2 text-right border-b border-stone-100 tabular-nums
                                     text-stone-400 text-[11.5px]"
                          style={{ fontFamily: '"Menlo", monospace' }}>
                        {p.played}
                      </td>
                      {cell(p.tiers.easy)}
                      {cell(p.tiers.medium)}
                      {cell(p.tiers.hard)}
                      <td className={`px-0.5 pr-2 py-2 text-right border-b border-stone-100 tabular-nums
                                     text-[12px] font-bold ${isMe ? 'text-red-700' : 'text-stone-800'}`}
                          style={{ fontFamily: '"Menlo", monospace' }}>
                        {formatMmSs1(p.avg)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {visitors.length > 0 && (
              <>
                {showVisitors && visitors.map((p) => {
                  const isMe = p.name === currentName;
                  return (
                    <button key={p.name} onClick={() => onPlayerClick(p.name)}
                      className={`w-full flex items-center justify-between px-3 py-2 border-t border-stone-100
                                 transition-colors text-left
                                 ${isMe ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-stone-50'}`}>
                      <span className={`text-sm font-medium ${isMe ? 'text-red-800' : 'text-stone-700'}`}>
                        {p.name}
                        {isMe && <span className="text-stone-400 font-normal text-[11px]"> (you)</span>}
                      </span>
                      <span className="text-[10.5px] text-stone-500 font-mono tabular-nums"
                            style={{ fontFamily: '"Menlo", monospace' }}>
                        {p.played}d · avg {formatMmSs(p.avg)}
                      </span>
                    </button>
                  );
                })}
                <button onClick={() => setShowVisitors((v) => !v)}
                  className="w-full py-2 bg-stone-50 hover:bg-stone-100 text-stone-500 text-[11px]
                             font-medium border-t border-stone-200 transition-colors">
                  {showVisitors
                    ? 'Hide occasional players ▴'
                    : `+ ${visitors.length} occasional player${visitors.length === 1 ? '' : 's'} (under ${REGULAR_MIN_SOLVES} solves) ▾`}
                </button>
              </>
            )}
          </div>
          <p className="text-[10px] text-stone-400 text-center mt-2 px-3 leading-relaxed">
            Average solve time by puzzle difficulty (# = solves). Tap any column to sort.
            A tier needs {TIER_MIN_SOLVES}+ solves to show a time — otherwise “—”.
          </p>
        </>
      )}

      {tab === 'weekly' && (
        <>
          <div className="flex items-baseline justify-between mb-1.5 px-1">
            <span className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold">
              Weekly Puzzle · {weekKey}
            </span>
            <span className="text-[10px] text-stone-400">
              this week: {WEEKLY_TYPE_META[weeklyTypeForKey(weekKey)].title} · resets Mon UTC
            </span>
          </div>
          <div className="bg-white rounded-md shadow-sm overflow-hidden mb-4">
            {survivorWeek === null ? (
              <div className="text-center text-stone-400 text-sm py-4">Loading…</div>
            ) : survivorWeek.length === 0 ? (
              <div className="text-center text-stone-400 text-sm italic py-4">
                No Survivor runs yet this week.
              </div>
            ) : (
              survivorWeek.map((r, i) => {
                const isMe = r.name === currentName;
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null;
                return (
                  <div key={r.name}
                       className={`flex items-center justify-between px-3 py-2 border-t border-stone-100 first:border-t-0
                                  ${isMe ? 'bg-red-50' : ''}`}>
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-base w-5 inline-block text-center flex-shrink-0">
                        {medal || <span className="text-stone-400 text-sm">{i + 1}</span>}
                      </span>
                      <button onClick={() => onPlayerClick(r.name)}
                              className={`text-sm font-medium truncate hover:underline underline-offset-2 text-left
                                         ${isMe ? 'text-red-800' : 'text-stone-800'}`}>
                        {r.name}{isMe && <span className="text-stone-400 font-normal"> (you)</span>}
                      </button>
                    </span>
                    <span className="text-sm flex-shrink-0 ml-2">
                      <span className="font-bold text-stone-800 tabular-nums">{r.best}</span>
                      <span className="text-stone-400 text-[11px]"> cards · {r.attempts} {r.attempts === 1 ? 'try' : 'tries'}</span>
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-baseline justify-between mb-1.5 px-1">
            <span className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold">
              Past champions
            </span>
          </div>
          <div className="bg-white rounded-md shadow-sm overflow-hidden">
            {survivorPast === null ? (
              <div className="text-center text-stone-400 text-sm py-4">Loading…</div>
            ) : survivorPast.length === 0 ? (
              <div className="text-center text-stone-400 text-sm italic py-4">
                No completed weeks yet — this is week one.
              </div>
            ) : (
              survivorPast.map((c) => (
                <div key={c.week}
                     className="flex items-center justify-between px-3 py-2 border-t border-stone-100 first:border-t-0">
                  <span className="text-[12px] text-stone-500 min-w-0">
                    <span className="font-mono" style={{ fontFamily: '"Menlo", monospace' }}>{c.week}</span>
                    <span className="text-stone-400 text-[10px]"> · {WEEKLY_TYPE_META[weeklyTypeForKey(c.week)].title}</span>
                  </span>
                  <span className="text-sm">
                    🏆{' '}
                    <button onClick={() => onPlayerClick(c.name)}
                            className={`font-medium hover:underline underline-offset-2
                                       ${c.name === currentName ? 'text-red-800' : 'text-stone-800'}`}>
                      {c.name}
                    </button>{' '}
                    <span className="font-bold text-stone-800 tabular-nums">{c.score}</span>
                    <span className="text-stone-400 text-[11px]"> cards</span>
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {tab === 'days' && (
        <>
          <div className="bg-white rounded-md shadow-sm overflow-hidden">
            {dates.slice(0, daysShown).map((date) => {
              const entries = Object.entries(history[date])
                .map(([n, r]) => ({ name: n, time: r.time }))
                .sort((a, b) => a.time - b.time);
              const winner = entries[0];
              const others = Math.max(0, entries.length - 1);  // everyone but the winner
              const open = expandedDays.has(date);
              const diff = difficulties[date];
              const expandable = others > 0;
              return (
                <div key={date} className={`border-t border-stone-100 first:border-t-0 ${open ? 'bg-stone-50' : ''}`}>
                  {/* One line per day: date · winner · time · difficulty · count.
                      Tap to expand the full field. */}
                  <div role={expandable ? 'button' : undefined}
                       tabIndex={expandable ? 0 : undefined}
                       onClick={expandable ? () => toggleDay(date) : undefined}
                       onKeyDown={expandable ? (e) => {
                         if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDay(date); }
                       } : undefined}
                       className={`flex items-center gap-2.5 px-3 py-2.5
                                  ${expandable ? 'cursor-pointer hover:bg-stone-50' : ''}`}>
                    {/* date */}
                    <div className="flex-shrink-0" style={{ width: '46px' }}>
                      <div className="text-[9px] font-bold text-stone-400 tracking-wider leading-none">
                        {shortWeekday(date, true)}
                      </div>
                      <div className="text-[12.5px] font-bold text-stone-800 leading-tight">
                        {formatShortDate(date)}
                      </div>
                    </div>
                    {/* winner */}
                    <div className="flex-1 min-w-0 flex items-center gap-1.5">
                      <span className="flex-shrink-0 text-[13px]" aria-hidden="true">🥇</span>
                      {winner ? (
                        <>
                          <button onClick={(ev) => { ev.stopPropagation(); onPlayerClick(winner.name); }}
                            className={`font-semibold text-[13px] truncate hover:underline underline-offset-2
                                       ${winner.name === currentName ? 'text-red-800' : 'text-stone-800'}`}>
                            {winner.name}
                          </button>
                          <span className="flex-shrink-0 font-mono text-[12px] font-semibold tabular-nums"
                                style={{ fontFamily: '"Menlo", monospace', color: '#b08a24' }}>
                            {formatMmSs1(winner.time)}
                          </span>
                        </>
                      ) : (
                        <span className="text-[12px] text-stone-300">no plays</span>
                      )}
                    </div>
                    {/* difficulty + count + chevron */}
                    <div className="flex-shrink-0 flex items-center gap-2">
                      {diff && (
                        <button onClick={(ev) => { ev.stopPropagation(); onOpenScoring(); }}
                                className="text-[10px]" title="How difficulty is scored">
                          <DifficultyBadge difficulty={diff} />
                        </button>
                      )}
                      <span className="text-[11px] text-stone-400 tabular-nums w-12 text-right">
                        {entries.length} played
                      </span>
                      <span className="text-stone-300 text-[11px] w-2.5 text-right">
                        {expandable ? (open ? '⌄' : '›') : ''}
                      </span>
                    </div>
                  </div>
                  {/* expanded: ranks 2..N */}
                  {open && expandable && (
                    <div className="pb-2.5 pl-[70px] pr-3">
                      {entries.slice(1).map((e, i) => (
                        <div key={e.name} className="flex items-center justify-between py-0.5">
                          <span className="text-[12px] text-stone-600 min-w-0 truncate">
                            <span className="inline-block w-5 text-stone-400">{i + 2}</span>
                            <button onClick={() => onPlayerClick(e.name)}
                                    className={`hover:underline underline-offset-2
                                               ${e.name === currentName ? 'text-red-800 font-medium' : ''}`}>
                              {e.name}
                            </button>
                          </span>
                          <span className="font-mono text-[11px] text-stone-500 tabular-nums flex-shrink-0"
                                style={{ fontFamily: '"Menlo", monospace' }}>
                            {formatMmSs1(e.time)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {dates.length > daysShown && (
              <button onClick={() => setDaysShown((n) => n + DAYS_PAGE)}
                className="w-full py-2 bg-stone-50 hover:bg-stone-100 text-stone-500 text-[11px]
                           font-medium border-t border-stone-100 transition-colors">
                Show {Math.min(DAYS_PAGE, dates.length - daysShown)} more days ▾
              </button>
            )}
          </div>
        </>
      )}
    </main>
  );
}

// ===== Player detail stats =====
function PlayerStatsContent({ player, todayKey, currentName, onBack, onOpenScoring }) {
  const [history, setHistory] = useState(null);
  useEffect(() => { Storage.loadAllHistory().then(setHistory); }, []);

  // Pace-chart data: scoped fetch first (cheap), then the wider field-wide
  // fetch only if this player actually clears the threshold to show it.
  const [mySplits, setMySplits] = useState(null);
  const [fieldSplits, setFieldSplits] = useState(null);
  useEffect(() => {
    setMySplits(null);
    setFieldSplits(null);
    Storage.loadPlayerSplits(player).then(setMySplits);
  }, [player]);
  useEffect(() => {
    if (mySplits && mySplits.length >= MIN_SPLITS_FOR_PACE_CHART && fieldSplits === null) {
      Storage.loadFieldSplits().then(setFieldSplits);
    }
  }, [mySplits, fieldSplits]);

  if (history === null) {
    return (
      <main className="flex-1 flex items-center justify-center text-stone-500">
        Loading…
      </main>
    );
  }

  const entries = [];
  for (const date of Object.keys(history)) {
    const r = history[date][player];
    if (!r) continue;
    const dateResults = history[date];
    const times = Object.values(dateResults).map(x => x.time);
    const sortedTimes = [...times].sort((a, b) => a - b);
    const rank = sortedTimes.indexOf(r.time) + 1;
    entries.push({ date, time: r.time, rank, total: times.length });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));

  if (entries.length === 0) {
    return (
      <main className="flex-1 p-4 max-w-2xl w-full mx-auto">
        <button onClick={onBack}
          className="text-sm text-red-700 hover:text-red-900 font-medium mb-3 inline-flex items-center gap-1">
          ← All players
        </button>
        <h2 className="text-2xl font-bold text-stone-800 mb-2"
            style={{ fontFamily: '"Georgia", serif' }}>
          {player}
          {player === currentName && (
            <span className="text-base text-stone-400 font-normal ml-2">(you)</span>
          )}
        </h2>
        <div className="text-stone-500 italic mt-6 text-center">No games played yet.</div>
      </main>
    );
  }

  const times = entries.map(e => e.time);
  const played = times.length;
  const best = Math.min(...times);
  const avg = Math.round(times.reduce((s, t) => s + t, 0) / played * 100) / 100;
  const sortedTimes = [...times].sort((a, b) => a - b);
  const median = sortedTimes.length % 2 === 0
    ? Math.round((sortedTimes[sortedTimes.length / 2 - 1] + sortedTimes[sortedTimes.length / 2]) / 2 * 100) / 100
    : sortedTimes[Math.floor(sortedTimes.length / 2)];

  // Difficulty of each played puzzle (deterministic from the date) and
  // per-tier time stats. ~50ms worst case per date; runs only on the rare
  // re-renders of this view.
  const difficultyByDate = {};
  for (const e of entries) {
    difficultyByDate[e.date] = computePuzzleDifficulty(generateDailyPuzzle(e.date));
  }
  const tierStats = DIFFICULTY_ORDER.map((level) => {
    const ts = entries
      .filter((e) => difficultyByDate[e.date]?.level === level)
      .map((e) => e.time);
    if (ts.length === 0) return { level, n: 0 };
    return {
      level,
      n: ts.length,
      best: Math.min(...ts),
      avg: Math.round(ts.reduce((s, t) => s + t, 0) / ts.length * 100) / 100,
    };
  });

  const multiPlayerEntries = entries.filter(e => e.total > 1);
  const wins = multiPlayerEntries.filter(e => e.rank === 1).length;
  const podiums = multiPlayerEntries.filter(e => e.rank <= 3).length;

  // Streaks
  const playedDates = new Set(entries.map(e => e.date));
  const sortedDates = [...playedDates].sort();
  let bestStreak = 0, curStreak = 0, prevDate = null;
  for (const d of sortedDates) {
    if (prevDate !== null) {
      const diffDays = Math.round((dateKeyToUTC(d) - dateKeyToUTC(prevDate)) / 86400000);
      curStreak = diffDays === 1 ? curStreak + 1 : 1;
    } else {
      curStreak = 1;
    }
    if (curStreak > bestStreak) bestStreak = curStreak;
    prevDate = d;
  }

  let currentStreak = 0;
  let cursor = todayKey;
  if (!playedDates.has(cursor)) {
    cursor = utcDateKey(new Date(dateKeyToUTC(cursor) - 86400000));
  }
  while (playedDates.has(cursor)) {
    currentStreak++;
    cursor = utcDateKey(new Date(dateKeyToUTC(cursor) - 86400000));
  }

  // Pace chart: only ready once this player clears the threshold AND the
  // field-wide comparison data has loaded. Below the threshold, or while
  // still loading, paceReady is false and the card just doesn't render.
  const paceReady = mySplits && mySplits.length >= MIN_SPLITS_FOR_PACE_CHART && fieldSplits;
  let myPace = null, fieldPace = null, paceMax = 1, paceTakeaway = null;
  if (paceReady) {
    myPace = buildPaceByPosition(mySplits);
    fieldPace = buildPaceByPosition(fieldSplits);
    const allVals = [...myPace, ...fieldPace].map((p) => p.median).filter((v) => v != null);
    paceMax = allVals.length ? Math.max(...allVals) : 1;
    let bestIdx = -1, bestAbsGap = -Infinity, bestGap = 0;
    for (let i = 0; i < myPace.length; i++) {
      if (myPace[i].median != null && fieldPace[i].median != null) {
        const gap = myPace[i].median - fieldPace[i].median;
        if (Math.abs(gap) > bestAbsGap) { bestAbsGap = Math.abs(gap); bestIdx = i; bestGap = gap; }
      }
    }
    if (bestIdx >= 0) {
      const label = bestIdx === myPace.length - 1 ? 'last-set hunt' : `${ordinal(bestIdx + 1)}-set find`;
      const mine = myPace[bestIdx].median.toFixed(1);
      const field = fieldPace[bestIdx].median.toFixed(1);
      paceTakeaway = bestGap > 0
        ? <>Your <b>{label}</b> costs you the most — {mine}s vs field {field}s.</>
        : <>Your <b>{label}</b> is where you gain the most ground — {mine}s vs field {field}s.</>;
    }
  }

  return (
    <main className="flex-1 p-3 max-w-2xl w-full mx-auto">
      <button onClick={onBack}
        className="text-sm text-red-700 hover:text-red-900 font-medium mb-3 inline-flex items-center gap-1">
        ← All players
      </button>
      <h2 className="text-2xl font-bold text-stone-800 mb-3"
          style={{ fontFamily: '"Georgia", serif' }}>
        {player}
        {player === currentName && (
          <span className="text-base text-stone-400 font-normal ml-2">(you)</span>
        )}
      </h2>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <StatCard label="Played" value={played} />
        <StatCard label="Best" value={formatMmSs(best)} />
        <StatCard label="Average" value={formatMmSs(avg)} />
        <StatCard label="Median" value={formatMmSs(median)} />
        <StatCard label="Current streak" value={currentStreak}
                  sub={currentStreak === 1 ? 'day' : 'days'}
                  accent="text-red-700" />
        <StatCard label="Best streak" value={bestStreak}
                  sub={bestStreak === 1 ? 'day' : 'days'} />
      </div>

      <div className="bg-white rounded-md shadow-sm p-3 mb-3">
        <div className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold mb-1.5">
          Times by difficulty
        </div>
        <div className="divide-y divide-stone-100">
          {tierStats.map(({ level, n, best: tBest, avg: tAvg }) => {
            const tier = DIFFICULTY_TIERS[level];
            return (
              <div key={level} className="flex items-center justify-between py-1.5 gap-2">
                <span className="text-sm flex items-baseline gap-1.5 min-w-0">
                  <span className="text-red-600" style={{ whiteSpace: 'nowrap', letterSpacing: '0.05em' }}>
                    {'★'.repeat(tier.stars)}<span className="text-stone-300">{'★'.repeat(3 - tier.stars)}</span>
                  </span>
                  <span className="text-stone-700 font-medium">{tier.label}</span>
                </span>
                {n === 0 ? (
                  <span className="text-xs text-stone-300 italic">not played</span>
                ) : (
                  <span className="text-xs text-stone-600 font-mono tabular-nums text-right flex-shrink-0"
                        style={{ fontFamily: '"Menlo", monospace' }}>
                    best {formatMmSs(tBest)} · avg {formatMmSs(tAvg)} · {n}d
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {paceReady && (
        <div className="bg-white rounded-md shadow-sm p-3 mb-3">
          <div className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold mb-1.5">
            Where your time goes
            <span className="normal-case font-normal text-stone-400"> · {mySplits.length} timed solves</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-stone-500 mb-2">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-red-600 inline-block" /> You
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-stone-300 inline-block" /> Field median
            </span>
          </div>
          <div className="flex items-end gap-2">
            {myPace.map((mine, i) => {
              const field = fieldPace[i];
              const mineH = mine.median != null ? Math.max(4, Math.round((mine.median / paceMax) * 100)) : 0;
              const fieldH = field.median != null ? Math.max(4, Math.round((field.median / paceMax) * 100)) : 0;
              return (
                <div key={i} className="flex-1 flex flex-col items-center">
                  <div className="text-[8px] text-red-700 font-semibold h-3 leading-3">
                    {mine.median != null ? mine.median.toFixed(1) : ''}
                  </div>
                  <div className="flex items-end gap-0.5 w-full justify-center" style={{ height: '84px' }}>
                    <div className="w-2.5 rounded-t bg-red-600" style={{ height: `${mineH}%` }}
                         title={mine.median != null ? `You: ${mine.median.toFixed(1)}s` : 'no data'} />
                    <div className="w-2.5 rounded-t bg-stone-300" style={{ height: `${fieldH}%` }}
                         title={field.median != null ? `Field: ${field.median.toFixed(1)}s` : 'no data'} />
                  </div>
                  <div className="text-[9px] text-stone-400 mt-1">
                    {i === myPace.length - 1 ? 'last' : ordinal(i + 1)}
                  </div>
                </div>
              );
            })}
          </div>
          {paceTakeaway && (
            <p className="text-xs text-stone-600 mt-3 pt-2 border-t border-stone-100 leading-relaxed">
              {paceTakeaway}
            </p>
          )}
        </div>
      )}

      {multiPlayerEntries.length > 0 && (
        <div className="bg-white rounded-md shadow-sm p-3 mb-3">
          <div className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold mb-1">
            Head-to-head
          </div>
          <div className="text-sm text-stone-700">
            <span className="font-semibold">{wins}</span>{' '}
            {wins === 1 ? 'win' : 'wins'}
            <span className="text-stone-400 mx-1">·</span>
            <span className="font-semibold">{podiums}</span> top-3
            <span className="text-stone-400 mx-1">·</span>
            across {multiPlayerEntries.length}{' '}
            multiplayer {multiPlayerEntries.length === 1 ? 'day' : 'days'}
            {wins > 0 && (
              <span className="text-stone-500">
                {' '}({Math.round(100 * wins / multiPlayerEntries.length)}% win rate)
              </span>
            )}
          </div>
        </div>
      )}

      <h3 className="text-xs uppercase tracking-wider text-stone-500 mb-2 px-1 font-semibold">
        Puzzles played
      </h3>
      <div className="bg-white rounded-md shadow-sm divide-y divide-stone-100 overflow-hidden">
        {entries.map((e) => {
          const isBest = e.time === best;
          return (
            <div key={e.date} className="flex items-center justify-between px-4 py-2.5">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-stone-500 uppercase text-[11px] font-semibold tracking-wider w-9 flex-shrink-0">
                  {shortWeekday(e.date, true)}
                </span>
                <span className="text-sm text-stone-800 font-medium">
                  {formatShortDate(e.date)}
                </span>
                {difficultyByDate[e.date] && (
                  <DifficultyBadge difficulty={difficultyByDate[e.date]}
                                   onClick={onOpenScoring}
                                   className="text-[11px]" />
                )}
                {e.total > 1 && (
                  <span className="text-[11px] text-stone-500">
                    {e.rank === 1 ? '🥇'
                      : e.rank === 2 ? '🥈'
                      : e.rank === 3 ? '🥉'
                      : `#${e.rank} of ${e.total}`}
                  </span>
                )}
              </div>
              <span className={`font-mono tabular-nums text-sm
                               ${isBest ? 'text-red-700 font-semibold' : 'text-stone-700'}`}
                    style={{ fontFamily: '"Menlo", monospace' }}>
                {formatMmSs(e.time)}
                {isBest && <span className="ml-1 text-[10px] uppercase tracking-wider">best</span>}
              </span>
            </div>
          );
        })}
      </div>
    </main>
  );
}

// ===== Difficulty distribution data =====
// PUZZLE_UNIVERSE is exact; the rest are Monte-Carlo estimates. The set-count
// distribution comes from an earlier 30M-layout sample (it's formula-
// independent). The difficulty histogram was recomputed for the v2 formula by
// sampling 17,158,209 random 12-card layouts (400,000 valid 6-set puzzles).
const PUZZLE_UNIVERSE = 70724320184700;   // C(81,12) — every 12-card layout
const DIST_SAMPLE_N   = 400000;           // sampled valid 6-set puzzles (v2)
// [setCount, estimated number of layouts with exactly that many sets]
const SETCOUNT_DIST = [
  [0, 2284383754579], [1, 10264189941200], [2, 18462798314654],
  [3, 19278662284918], [4, 12743881263447], [5, 5649119219617],
  [6, 1652344079862], [7, 330159986441], [8, 48255203662],
  [9, 8163944027], [10, 2138231947],
];
// v2 difficulty histogram of the 6-set pool, 0.5-wide bins:
// [scoreLo, sampledCount, estimatedBillionsOfPuzzles]
const HISTO_BINS = [
  [0.0, 72, 0.30], [0.5, 560, 2.31], [1.0, 2346, 9.69], [1.5, 7129, 29.45],
  [2.0, 14711, 60.77], [2.5, 33319, 137.64], [3.0, 26135, 107.96],
  [3.5, 37034, 152.98], [4.0, 53452, 220.80], [4.5, 58774, 242.79],
  [5.0, 58681, 242.40], [5.5, 19643, 81.14], [6.0, 16020, 66.18],
  [6.5, 15301, 63.21], [7.0, 12142, 50.16], [7.5, 16507, 68.19],
  [8.0, 12204, 50.41], [8.5, 9884, 40.83], [9.0, 4863, 20.09],
  [9.5, 1223, 5.05],
];

function scoreToColor(s) {
  if (s < SCORE_CUT_EASY) return DIFFICULTY_TIERS['easy'].color;
  if (s < SCORE_CUT_HARD) return DIFFICULTY_TIERS['medium'].color;
  return DIFFICULTY_TIERS['hard'].color;
}

// Build the "sets per random layout" bar chart as a standalone SVG string.
function buildSetCountSvg() {
  const W = 700, H = 320, ML = 64, MR = 14, MT = 30, MB = 46;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const yMax = 20;  // trillions
  const slot = plotW / SETCOUNT_DIST.length;
  const y = (v) => MT + plotH - (v / yMax) * plotH;
  const fp = (p) => (p >= 1 ? p.toFixed(1) : p >= 0.1 ? p.toFixed(2) : p.toFixed(3)) + '%';
  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" `
        + `style="width:100%;height:auto;display:block" role="img" `
        + `aria-label="Bar chart: how many sets a random 12-card layout contains. It peaks at 3 sets; layouts with exactly 6 sets — the Daily SET pool — are only about 2.3 percent.">`;
  for (let g = 0; g <= yMax; g += 5) {
    const gy = y(g);
    s += `<line x1="${ML}" y1="${gy}" x2="${W-MR}" y2="${gy}" stroke="#e7e5e4"/>`;
    s += `<text x="${ML-7}" y="${gy+4}" text-anchor="end" font-size="12" fill="#a8a29e" font-family="Menlo, monospace">${g}T</text>`;
  }
  SETCOUNT_DIST.forEach(([k, cnt], i) => {
    const v = cnt / 1e12;
    const bx = ML + i*slot + slot*0.16, bw = slot*0.68;
    const by = y(v), bh = MT + plotH - by, isPool = k === 6;
    const pct = 100 * cnt / PUZZLE_UNIVERSE;
    s += `<rect x="${bx}" y="${by}" width="${bw}" height="${Math.max(bh,0)}" fill="${isPool?'#c0392b':'#a8a29e'}" rx="2"/>`;
    s += `<text x="${bx+bw/2}" y="${MT+plotH+18}" text-anchor="middle" font-size="12" fill="${isPool?'#b91c1c':'#78716c'}" font-weight="${isPool?'700':'400'}" font-family="Menlo, monospace">${k}</text>`;
    if (bh >= 20) {
      s += `<text x="${bx+bw/2}" y="${by-5}" text-anchor="middle" font-size="11" fill="#78716c" font-family="Menlo, monospace">${v.toFixed(1)}T</text>`;
      s += `<text x="${bx+bw/2}" y="${by+bh/2+4}" text-anchor="middle" font-size="11.5" font-weight="700" fill="${isPool?'#fff':'#1c1917'}" font-family="Menlo, monospace">${fp(pct)}</text>`;
    } else {
      s += `<text x="${bx+bw/2}" y="${by-5}" text-anchor="middle" font-size="10.5" fill="#78716c" font-family="Menlo, monospace">${fp(pct)}</text>`;
    }
  });
  const sixX = ML + 6*slot + slot*0.5;
  s += `<text x="${sixX}" y="${MT-13}" text-anchor="middle" font-size="11.5" fill="#b91c1c" font-weight="700">▲ Daily SET pool</text>`;
  s += `<line x1="${ML}" y1="${MT+plotH}" x2="${W-MR}" y2="${MT+plotH}" stroke="#a8a29e" stroke-width="1.4"/>`;
  s += `<text x="${ML+plotW/2}" y="${H-6}" text-anchor="middle" font-size="12.5" fill="#57534e" font-weight="600">Number of sets in the layout</text>`;
  s += `<text x="14" y="${MT+plotH/2}" text-anchor="middle" font-size="12" fill="#57534e" font-weight="600" transform="rotate(-90 14 ${MT+plotH/2})">Est. number of layouts</text>`;
  return s + '</svg>';
}

// Build the v2 difficulty histogram (three colour-coded tiers) as an SVG string.
function buildDiffHistogramSvg() {
  const W = 700, H = 360, ML = 56, MR = 14, MT = 26, MB = 46;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const yMax = 250;
  const x = (v) => ML + (v / 10) * plotW;
  const y = (v) => MT + plotH - (v / yMax) * plotH;
  const cuts = [SCORE_CUT_EASY, SCORE_CUT_HARD];
  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" `
        + `style="width:100%;height:auto;display:block" role="img" `
        + `aria-label="Histogram of v2 difficulty across the 1.65 trillion six-set puzzles, in three colour-coded star tiers. It is centred near 5 with rarer extremes.">`;
  for (let g = 0; g <= yMax; g += 50) {
    const gy = y(g);
    s += `<line x1="${ML}" y1="${gy}" x2="${W-MR}" y2="${gy}" stroke="#e7e5e4"/>`;
    s += `<text x="${ML-7}" y="${gy+4}" text-anchor="end" font-size="12" fill="#a8a29e" font-family="Menlo, monospace">${g}B</text>`;
  }
  for (const [lo, , est] of HISTO_BINS) {
    const bx = x(lo), bw = x(lo+0.5) - x(lo) - 1.4, by = y(est), bh = MT + plotH - by;
    s += `<rect x="${bx}" y="${by}" width="${bw}" height="${Math.max(bh,0)}" fill="${scoreToColor(lo+0.25)}" rx="1.5"/>`;
  }
  for (const t of cuts) {
    const tx = x(t);
    s += `<line x1="${tx}" y1="${MT}" x2="${tx}" y2="${MT+plotH}" stroke="#1c1917" stroke-width="1.4" stroke-dasharray="4 3"/>`;
    s += `<text x="${tx}" y="${MT-6}" text-anchor="middle" font-size="11" fill="#1c1917" font-weight="700" font-family="Menlo, monospace">${t.toFixed(1)}</text>`;
  }
  for (const [lo, samp] of HISTO_BINS) {
    const pct = 100 * samp / DIST_SAMPLE_N;
    if (pct < 1) continue;
    const bx = x(lo), bw = x(lo+0.5) - x(lo) - 1.4, est = HISTO_BINS.find(b => b[0]===lo)[2];
    const by = y(est), bh = MT + plotH - by;
    if (bh >= 18)
      s += `<text x="${bx+bw/2}" y="${by+bh/2+4}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff" font-family="Menlo, monospace">${Math.round(pct)}%</text>`;
  }
  s += `<line x1="${ML}" y1="${MT+plotH}" x2="${W-MR}" y2="${MT+plotH}" stroke="#a8a29e" stroke-width="1.4"/>`;
  for (let t = 0; t <= 10; t++) {
    const tx = x(t);
    s += `<line x1="${tx}" y1="${MT+plotH}" x2="${tx}" y2="${MT+plotH+4}" stroke="#a8a29e"/>`;
    s += `<text x="${tx}" y="${MT+plotH+17}" text-anchor="middle" font-size="11.5" fill="#a8a29e" font-family="Menlo, monospace">${t}</text>`;
  }
  s += `<text x="${ML+plotW/2}" y="${H-6}" text-anchor="middle" font-size="12.5" fill="#57534e" font-weight="600">Difficulty score (0–10)</text>`;
  s += `<text x="13" y="${MT+plotH/2}" text-anchor="middle" font-size="12" fill="#57534e" font-weight="600" transform="rotate(-90 13 ${MT+plotH/2})">Est. number of puzzles</text>`;
  return s + '</svg>';
}

const SETCOUNT_SVG = buildSetCountSvg();
const DIFF_HISTOGRAM_SVG = buildDiffHistogramSvg();

// ===== Weekly Survivor =====
// Arcade weekly: build the biggest set-free board from a freshly shuffled
// deck (random each attempt — a fixed weekly deck would reward memorizing
// the order). Keep or pass each dealt card; 10 passes per run; keeping a
// card that completes a set with two board cards ends the run. Scores
// bucket into ISO weeks (Mon 00:00 UTC reset); leaderboard takes each
// player's best. Every attempt is stored for later analysis.
function SurvivorContent({ name, onPlayerClick }) {
  const week = utcIsoWeekKey();
  const [deck, setDeck] = useState(() => survivorShuffledDeck());
  const [pos, setPos] = useState(0);
  const [board, setBoard] = useState([]);
  const [passes, setPasses] = useState(SURVIVOR_MAX_PASSES);
  const [dead, setDead] = useState(null);        // { card, sets }
  const [saving, setSaving] = useState(false);
  const [weekBoard, setWeekBoard] = useState(null);  // weekly leaderboard rows

  const current = pos < deck.length ? deck[pos] : null;
  const poison = useMemo(() => survivorPoisonSet(board), [board]);
  const remaining = deck.length - pos - (current !== null ? 1 : 0);
  const poisonLeft = useMemo(() => {
    let n = 0;
    for (let i = pos + 1; i < deck.length; i++) if (poison.has(deck[i])) n++;
    return n;
  }, [deck, pos, poison]);

  const refreshWeek = () => { Storage.loadSurvivorWeek(week).then(setWeekBoard); };
  useEffect(refreshWeek, [week]);  // eslint-disable-line react-hooks/exhaustive-deps

  const deckExhausted = current === null && !dead;
  const runOver = Boolean(dead) || deckExhausted;

  // Persist the attempt exactly once when a run ends.
  const savedRef = useRef(false);
  useEffect(() => {
    if (!runOver || savedRef.current || !name) return;
    savedRef.current = true;
    setSaving(true);
    (async () => {
      await Storage.saveSurvivorResult(week, name, board.length, SURVIVOR_MAX_PASSES - passes, board);
      const rows = await Storage.loadSurvivorWeek(week);
      setWeekBoard(rows);
      setSaving(false);
    })();
  }, [runOver, name, week, board, passes]);

  const keep = () => {
    if (current === null || dead) return;
    if (poison.has(current)) {
      const sets = [];
      for (let i = 0; i < board.length; i++)
        for (let j = i + 1; j < board.length; j++)
          if (SURV_THIRD[board[i]][board[j]] === current) sets.push([board[i], board[j], current]);
      setDead({ card: current, sets });
      return;
    }
    setBoard((b) => [...b, current]);
    setPos((p) => p + 1);
  };

  const pass = () => {
    if (current === null || dead || passes <= 0) return;
    setPasses((p) => p - 1);
    setPos((p) => p + 1);
  };

  const reset = () => {
    setDeck(survivorShuffledDeck());
    setPos(0); setBoard([]); setPasses(SURVIVOR_MAX_PASSES); setDead(null);
    savedRef.current = false;
  };

  const killCards = useMemo(() => {
    if (!dead) return new Set();
    const s = new Set();
    for (const trio of dead.sets) for (const c of trio) s.add(c);
    return s;
  }, [dead]);

  const myBest = weekBoard ? weekBoard.find((r) => r.name === name) : null;
  const daysLeft = Math.ceil(msUntilNextUtcMonday() / 86400000);

  return (
    <main className="flex-1 p-3 max-w-md w-full mx-auto">
      <div className="text-center mb-3">
        <h2 className="text-xl font-bold text-stone-900" style={{ fontFamily: '"Georgia", serif' }}>
          Weekly <span className="text-red-700 italic">Puzzle</span>
        </h2>
        <div className="mt-1.5 mb-1">
          <span className="inline-block bg-red-700 text-white text-[10px] uppercase tracking-widest
                           font-bold px-2.5 py-1 rounded-full">
            This week: Survivor
          </span>
        </div>
        <p className="text-[11.5px] text-stone-500 mt-1 leading-snug">
          Build the biggest board with <strong>no set</strong>. Keep or pass each
          card; a kept card that completes a set ends the run. Unlimited tries —
          your best this week counts. A new puzzle type arrives Monday 00:00 UTC
          ({daysLeft} {daysLeft === 1 ? 'day' : 'days'} left).
        </p>
      </div>

      {/* status strip */}
      <div className="bg-white rounded-md shadow-sm flex divide-x divide-stone-100 text-center mb-3">
        <div className="flex-1 py-2">
          <div className="text-lg font-bold text-stone-800 tabular-nums leading-none">{board.length}</div>
          <div className="text-[8.5px] uppercase tracking-wider text-stone-500 font-bold mt-0.5">on board</div>
        </div>
        <div className="flex-1 py-2">
          <div className={`text-lg font-bold tabular-nums leading-none ${passes <= 2 ? 'text-red-700' : 'text-stone-800'}`}>{passes}</div>
          <div className="text-[8.5px] uppercase tracking-wider text-stone-500 font-bold mt-0.5">passes left</div>
        </div>
        <div className="flex-1 py-2">
          <div className="text-lg font-bold text-stone-800 tabular-nums leading-none">
            {poisonLeft}<span className="text-[11px] text-stone-400 font-normal">/{remaining}</span>
          </div>
          <div className="text-[8.5px] uppercase tracking-wider text-stone-500 font-bold mt-0.5">poison in deck</div>
        </div>
        <div className="flex-1 py-2">
          <div className="text-lg font-bold text-stone-800 tabular-nums leading-none">{myBest ? myBest.best : '—'}</div>
          <div className="text-[8.5px] uppercase tracking-wider text-stone-500 font-bold mt-0.5">week best</div>
        </div>
      </div>

      {/* dealt card / end states */}
      {dead ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-red-200 p-4 text-center mb-3">
          <div className="text-3xl mb-1">💀</div>
          <h3 className="text-lg font-bold text-stone-900" style={{ fontFamily: '"Georgia", serif' }}>
            That card made a set.
          </h3>
          <p className="text-sm text-stone-600 mt-1 mb-2">
            You survived to <strong className="text-red-700">{board.length}</strong> cards
            {dead.sets.length > 1 && ` — and it completed ${dead.sets.length} sets at once`}.
          </p>
          <div className="inline-block mb-1" style={{ width: '84px' }}>
            <div style={{ aspectRatio: '4 / 3' }}
                 className="relative w-full rounded-lg border-2 border-red-500 ring-2 ring-red-300 bg-white overflow-hidden shadow">
              <CardBody card={decodeCard(dead.card)} />
            </div>
          </div>
          <p className="text-[11px] text-stone-400 mb-3">
            {saving ? 'saving score…' : `the killing set${dead.sets.length > 1 ? 's are' : ' is'} highlighted below`}
          </p>
          <button onClick={reset}
            className="px-7 py-2.5 bg-red-700 hover:bg-red-800 text-white rounded-md font-semibold transition-colors">
            Play again
          </button>
        </div>
      ) : deckExhausted ? (
        <div className="bg-white rounded-xl shadow-md border-2 border-green-200 p-4 text-center mb-3">
          <div className="text-3xl mb-1">🏆</div>
          <h3 className="text-lg font-bold text-stone-900" style={{ fontFamily: '"Georgia", serif' }}>
            Deck exhausted — you out-survived it!
          </h3>
          <p className="text-sm text-stone-600 mt-1 mb-3">
            {board.length} cards, no set. {saving ? 'Saving…' : 'Remarkable.'}
          </p>
          <button onClick={reset}
            className="px-7 py-2.5 bg-red-700 hover:bg-red-800 text-white rounded-md font-semibold transition-colors">
            Play again
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-md p-4 mb-3">
          <div className="text-[10px] uppercase tracking-wider text-stone-400 font-bold text-center mb-2">
            Card {pos + 1} of {deck.length} — keep it or pass?
          </div>
          <div className="flex items-center justify-center gap-3">
            <button onClick={pass} disabled={passes <= 0}
              className="px-4 py-2.5 rounded-md font-semibold text-sm bg-stone-100 text-stone-600
                         hover:bg-stone-200 disabled:opacity-35 disabled:cursor-not-allowed transition-colors">
              Pass ({passes})
            </button>
            <div style={{ width: '104px' }} className="flex-shrink-0">
              <div style={{ aspectRatio: '4 / 3' }}
                   className="relative w-full rounded-lg border-2 border-stone-300 bg-white overflow-hidden shadow">
                <CardBody card={decodeCard(current)} />
              </div>
            </div>
            <button onClick={keep}
              className="px-4 py-2.5 rounded-md font-semibold text-sm bg-red-700 text-white hover:bg-red-800 transition-colors">
              Keep it
            </button>
          </div>
          <p className="text-[10px] text-stone-400 text-center mt-2 italic">
            no warnings — you have to spot the danger yourself
          </p>
        </div>
      )}

      {/* board */}
      <div className="flex items-baseline justify-between mb-1.5 px-1">
        <span className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold">Your board</span>
        <span className="text-[10px] text-stone-400">{board.length} / 20 possible</span>
      </div>
      <div className="bg-white rounded-md border border-stone-200 shadow-sm p-2 min-h-[80px] mb-4">
        {board.length === 0 && !dead ? (
          <div className="text-center text-stone-300 italic text-sm py-5">empty — keep your first card</div>
        ) : (
          <div className="grid grid-cols-5 gap-1.5">
            {board.map((c) => (
              <div key={c} style={{ aspectRatio: '4 / 3' }}
                   className={`relative w-full rounded border bg-white overflow-hidden shadow-sm transition-all
                              ${killCards.has(c) ? 'border-red-500 ring-2 ring-red-300' : 'border-stone-200'}
                              ${dead && !killCards.has(c) ? 'opacity-35' : ''}`}>
                <CardBody card={decodeCard(c)} />
              </div>
            ))}
            {dead && (
              <div style={{ aspectRatio: '4 / 3' }}
                   className="relative w-full rounded border-2 border-red-500 ring-2 ring-red-300 bg-red-50 overflow-hidden shadow">
                <CardBody card={decodeCard(dead.card)} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* weekly leaderboard */}
      <div className="flex items-baseline justify-between mb-1.5 px-1">
        <span className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold">
          This week's leaderboard
        </span>
        <span className="text-[10px] text-stone-400">{week} · best of unlimited tries</span>
      </div>
      <div className="bg-white rounded-md shadow-sm overflow-hidden mb-3">
        {weekBoard === null ? (
          <div className="text-center text-stone-400 text-sm py-4">Loading…</div>
        ) : weekBoard.length === 0 ? (
          <div className="text-center text-stone-400 text-sm italic py-4">
            No runs yet this week — set the bar!
          </div>
        ) : (
          weekBoard.slice(0, 10).map((r, i) => {
            const isMe = r.name === name;
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null;
            return (
              <div key={r.name}
                   className={`flex items-center justify-between px-3 py-2 border-t border-stone-100 first:border-t-0
                              ${isMe ? 'bg-red-50' : ''}`}>
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-base w-5 inline-block text-center flex-shrink-0">
                    {medal || <span className="text-stone-400 text-sm">{i + 1}</span>}
                  </span>
                  <button onClick={() => onPlayerClick(r.name)}
                          className={`text-sm font-medium truncate hover:underline underline-offset-2 text-left
                                     ${isMe ? 'text-red-800' : 'text-stone-800'}`}>
                    {r.name}{isMe && <span className="text-stone-400 font-normal"> (you)</span>}
                  </button>
                </span>
                <span className="text-sm flex-shrink-0 ml-2">
                  <span className="font-bold text-stone-800 tabular-nums">{r.best}</span>
                  <span className="text-stone-400 text-[11px]"> cards · {r.attempts} {r.attempts === 1 ? 'try' : 'tries'}</span>
                </span>
              </div>
            );
          })
        )}
      </div>

      <p className="text-[10px] text-stone-400 text-center leading-relaxed px-2">
        "Poison in deck" counts the undealt cards that would complete a set with a
        pair on your board right now. The mathematical ceiling is 20 cards
        (Pellegrino, 1971) — any 21 must contain a set. Even a perfect player
        averages ~14.
      </p>
    </main>
  );
}

// ===== Scoring explanation page =====
function ScoringContent({ onBack }) {
  const subhead = "text-[11px] uppercase tracking-wider text-stone-500 mb-2 px-1 font-semibold mt-1";
  return (
    <main className="flex-1 p-3 max-w-2xl w-full mx-auto">
      <button onClick={onBack}
        className="text-sm text-red-700 hover:text-red-900 font-medium mb-3 inline-flex items-center gap-1">
        ← Back
      </button>
      <h2 className="text-2xl font-bold text-stone-800 mb-2"
          style={{ fontFamily: '"Georgia", serif' }}>
        How difficulty is scored
      </h2>
      <p className="text-stone-600 text-sm mb-5 leading-relaxed">
        Every puzzle gets a score from <strong>structural properties of the
        12-card layout itself</strong>, not from how long anyone took to solve
        it. The same layout always gets the same score, so ratings are
        comparable across days and across players.
      </p>

      <div className="bg-white rounded-md border border-stone-300 p-3 mb-2
                      text-sm text-stone-800 tabular-nums text-center overflow-x-auto"
           style={{ fontFamily: '"Menlo", monospace' }}>
        score = ((raw − 1.808) / 2.0) × 10
      </div>
      <p className="text-xs text-stone-500 mb-5 text-center leading-relaxed">
        where <span className="font-mono">raw = avgVars + 0.141 × decoys</span>.{' '}
        The raw composite spans 1.81–3.81 across the puzzles this site actually
        serves, so the easiest possible daily puzzle scores ~0 and the hardest ~10.
      </p>

      <section className="mb-4">
        <h3 className="font-semibold text-stone-800 mb-1"
            style={{ fontFamily: '"Georgia", serif' }}>
          avgVars
          <span className="text-stone-400 font-normal text-sm ml-1">
            — average varying attributes per set
          </span>
        </h3>
        <p className="text-sm text-stone-700 leading-relaxed">
          Each set varies in 1–4 of its attributes (color, shape, shading,
          number). A set with 1 varying attribute looks nearly identical
          (e.g. three red solid ovals — just the count differs); a set with
          all 4 varying looks maximally different and is the hardest to spot.
          Across 1,338 real solves this is comfortably the strongest structural
          predictor of how long a puzzle takes, so it carries the most weight.{' '}
          <strong>Higher = harder.</strong>
        </p>
      </section>

      <section className="mb-4">
        <h3 className="font-semibold text-stone-800 mb-1"
            style={{ fontFamily: '"Georgia", serif' }}>
          decoys
          <span className="text-stone-400 font-normal text-sm ml-1">
            — cards in zero sets
          </span>
        </h3>
        <p className="text-sm text-stone-700 leading-relaxed">
          Cards that don't belong to any set still have to be visually
          evaluated and dismissed — wasted scanning. Decoys do slow people
          down in our data, but only mildly, which is why they carry a small
          weight next to avgVars.{' '}
          <strong>Higher = harder.</strong>
        </p>
      </section>

      <h3 className="text-[11px] uppercase tracking-wider text-stone-500 mb-2 px-1 font-semibold">
        Star ratings
      </h3>
      <p className="text-xs text-stone-500 mb-2 leading-relaxed">
        The 0–10 score is bucketed into three star ratings, cut so that 1★ and
        3★ are the rarer ends and 2★ is the broad middle. For a player who
        averages around 1:23, the tiers work out to roughly{' '}
        <strong>1:09 / 1:22 / 1:36</strong> — a real spread of about 40% from
        an easy board to a hard one.
      </p>
      <div className="bg-white rounded-md border border-stone-300 divide-y divide-stone-200 mb-5">
        <div className="px-4 py-1.5 flex items-center gap-3 bg-stone-50
                        text-[10px] uppercase tracking-wider text-stone-500 font-semibold">
          <span className="flex-1">Rating</span>
          <span className="w-24 text-right">Score range</span>
          <span className="w-16 text-right">Share</span>
        </div>
        {[
          [1, 'Easy', '0.0 – 3.5', '~18%'],
          [2, 'Medium', '3.5 – 6.7', '~54%'],
          [3, 'Hard', '6.7 – 10.0', '~28%'],
        ].map(([stars, label, range, share]) => (
          <div key={label} className="px-4 py-2.5 flex items-center gap-3">
            <span className="text-sm flex-1 min-w-0">
              <span className="text-red-600" style={{ whiteSpace: 'nowrap', letterSpacing: '0.05em' }}>
                {'★'.repeat(stars)}<span className="text-stone-300">{'★'.repeat(3 - stars)}</span>
              </span>
              <span className="ml-1.5">{label}</span>
            </span>
            <span className="text-stone-700 tabular-nums text-sm font-medium w-24 text-right flex-shrink-0"
                  style={{ fontFamily: '"Menlo", monospace' }}>
              {range}
            </span>
            <span className="text-stone-400 tabular-nums text-xs w-16 text-right flex-shrink-0"
                  style={{ fontFamily: '"Menlo", monospace' }}>
              {share}
            </span>
          </div>
        ))}
      </div>

      <h3 className="text-[11px] uppercase tracking-wider text-stone-500 mb-2 px-1 font-semibold">
        What this rating can — and can't — tell you
      </h3>
      <div className="bg-stone-100 border border-stone-200 rounded-md p-4 text-sm
                      text-stone-700 leading-relaxed space-y-3 mb-4">
        <p>
          Read the stars as <strong>"structural complexity, roughly"</strong>{' '}
          — not a promise about how your solve will go.
        </p>
        <p>
          The formula was refit in July 2026 against{' '}
          <strong>1,338 real solves</strong> across 368 puzzle days from this
          site's own leaderboard — comparing each solve against that player's
          own baseline, so a fast player's easy day doesn't get mistaken for an
          easy puzzle. The refit roughly doubled the score's accuracy: its
          correlation with player-adjusted solve times went from 0.21 to{' '}
          <strong>0.40</strong>.
        </p>
        <p>
          Which still means the layout explains only about{' '}
          <strong>16% of the variance</strong> in how long a puzzle takes. The
          other 84% is everything a structural metric can't see: which set your
          eye lands on first, focus, luck. The same puzzle here has produced a
          3-minute solve and a 7½-minute solve from two different people.
        </p>
        <p>
          That's exactly why there are three buckets and not a precise number.
          The three ratings do line up in the right order — 1★ days genuinely
          get solved faster, 3★ days genuinely slower — but it's an average,
          and 2★ is the big middle where structure says the least. A 2★ puzzle
          can absolutely fight you harder than a 3★ one. Read the stars as{' '}
          <strong>a tendency, not a prediction.</strong>
        </p>
      </div>

      <h3 className="text-[11px] uppercase tracking-wider text-stone-500 mb-2 px-1 font-semibold">
        The puzzle universe
      </h3>
      <p className="text-xs text-stone-500 mb-3 leading-relaxed">
        Difficulty is only defined for layouts that are actually puzzles — the
        ones with exactly six sets. Here's how narrow that pool is, and how the
        scores spread across it.
      </p>

      {/* funnel */}
      <div className="rounded-lg bg-stone-100 border border-stone-300 p-3 text-center">
        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">
          Every 12-card layout
        </div>
        <div className="text-2xl font-bold text-stone-700 tabular-nums mt-0.5"
             style={{ fontFamily: '"Menlo", monospace' }}>
          70.72<span className="text-sm font-normal text-stone-400"> trillion</span>
        </div>
        <div className="text-[11px] text-stone-500 mt-0.5">
          C(81,&nbsp;12) = 70,724,320,184,700 — any 12 cards from the deck. Exact.
        </div>
      </div>
      <div className="text-center py-1.5">
        <div className="text-red-600 text-lg leading-none">▼</div>
        <div className="inline-block bg-white border border-dashed border-red-400
                        text-red-800 text-[11px] font-medium px-3 py-1 rounded-full mt-1">
          keep only layouts with exactly 6 sets — 2.33% qualify
        </div>
      </div>
      <div className="rounded-lg bg-red-50 border-2 border-red-200 p-3 text-center mx-auto"
           style={{ maxWidth: '80%' }}>
        <div className="text-[10px] uppercase tracking-wider font-bold text-red-800">
          The Daily SET pool
        </div>
        <div className="text-2xl font-bold text-red-700 tabular-nums mt-0.5"
             style={{ fontFamily: '"Menlo", monospace' }}>
          ~1.65<span className="text-sm font-normal text-red-400"> trillion</span>
        </div>
        <div className="text-[11px] text-red-800 mt-0.5">
          the 6-set layouts — what every daily puzzle is drawn from
        </div>
      </div>
      <p className="text-xs text-stone-500 leading-relaxed mt-3 mb-5">
        Only about 2.33% of random 12-card layouts contain exactly 6 sets — but
        the deck is so large that this is still roughly 1.65 trillion distinct
        puzzles.
      </p>

      {/* set-count chart */}
      <h4 className={subhead}>Sets per random layout</h4>
      <div className="bg-white rounded-md border border-stone-200 p-2 mb-1">
        <div className="overflow-x-auto">
          <div style={{ minWidth: '540px' }}
               dangerouslySetInnerHTML={{ __html: SETCOUNT_SVG }} />
        </div>
      </div>
      <p className="text-xs text-stone-500 mb-5 leading-relaxed">
        Deal 12 random cards and count the sets. Most layouts have 2–4. The red
        bar — exactly 6 sets — is the only one Daily SET keeps; every other bar
        is discarded.
      </p>

      {/* difficulty histogram */}
      <h4 className={subhead}>Difficulty across the puzzle pool</h4>
      <div className="bg-white rounded-md border border-stone-200 p-2 mb-1">
        <div className="overflow-x-auto">
          <div style={{ minWidth: '540px' }}
               dangerouslySetInnerHTML={{ __html: DIFF_HISTOGRAM_SVG }} />
        </div>
        <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 mt-1.5 px-1">
          {DIFFICULTY_ORDER.map((key) => {
            const t = DIFFICULTY_TIERS[key];
            return (
              <span key={key}
                    className="inline-flex items-center gap-1 text-[10px] text-stone-500">
                <span style={{ width: '10px', height: '10px', borderRadius: '2px',
                               background: t.color, display: 'inline-block' }} />
                {'★'.repeat(t.stars)} {t.label}
              </span>
            );
          })}
          <span className="inline-flex items-center gap-1 text-[10px] text-stone-500">
            <span style={{ width: '14px', height: '0', borderTop: '2px dashed #1c1917',
                           display: 'inline-block' }} />
            star cuts (3.6 / 5.7)
          </span>
        </div>
      </div>
      <p className="text-xs text-stone-500 mb-5 leading-relaxed">
        Every one of the ~1.65 trillion puzzles, scored with the v2 formula and
        binned. The dashed lines are the 1★/2★ and 2★/3★ cuts; the figure inside
        each bar is that bin's share of the pool. The bulk sits in the middle —
        which is exactly why 2★ is the broad "typical" bucket and the star
        ratings only call out the rarer ends.
      </p>

      {/* raw bin table */}
      <h4 className={subhead}>Raw bin data</h4>
      <div className="bg-white rounded-md border border-stone-200 overflow-hidden mb-1">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-stone-100">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-stone-600">Score bin</th>
                <th className="px-3 py-2 text-right font-semibold text-stone-600">Sampled</th>
                <th className="px-3 py-2 text-right font-semibold text-stone-600">Est. in pool</th>
                <th className="px-3 py-2 text-right font-semibold text-stone-600">Share</th>
              </tr>
            </thead>
            <tbody>
              {HISTO_BINS.map(([lo, samp, est], i) => (
                <tr key={lo} className={i % 2 === 0 ? 'bg-white' : 'bg-stone-50'}>
                  <td className="px-3 py-1.5 text-stone-700 whitespace-nowrap">
                    {lo.toFixed(1)} – {(lo + 0.5).toFixed(1)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-stone-700"
                      style={{ fontFamily: '"Menlo", monospace' }}>
                    {samp.toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-stone-700"
                      style={{ fontFamily: '"Menlo", monospace' }}>
                    {est.toFixed(2)} B
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-stone-700"
                      style={{ fontFamily: '"Menlo", monospace' }}>
                    {(100 * samp / DIST_SAMPLE_N).toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-stone-500 mb-5 leading-relaxed">
        Score percentiles across the pool — p10&nbsp;2.7 · p25&nbsp;3.6 ·
        p50&nbsp;4.5 · p75&nbsp;5.7 · p90&nbsp;7.5. Mean 4.9, standard
        deviation 1.8.
      </p>

      {/* method */}
      <h4 className={subhead}>Method</h4>
      <p className="text-xs text-stone-500 leading-relaxed mb-5">
        The 70.72-trillion figure is exact — it is C(81,&nbsp;12). Everything
        else is estimated by sampling random 12-card layouts and counting the
        sets in each. About 2.33% had exactly 6 sets, which scaled up by
        C(81,&nbsp;12) gives ~1.65 trillion puzzles. The v2 difficulty score
        was then computed for 400,000 sampled 6-set puzzles. A "layout" /
        "puzzle" is an unordered set of 12 cards; layouts related by SET's
        symmetries are not deduplicated.
      </p>

      <p className="text-xs text-stone-500 italic leading-relaxed">
        The coefficients and star cut points will be re-fit periodically as
        more solve data accumulates.
      </p>
    </main>
  );
}

// ===== Main app =====
export default function App() {
  const [todayKey, setTodayKey] = useState(() => utcDateKey());
  const [playingDate, setPlayingDate] = useState(null);
  const activeDate = playingDate || todayKey;
  const isPlayingToday = !playingDate;

  const puzzle = useMemo(() => generateDailyPuzzle(activeDate), [activeDate]);
  const targetSets = puzzle.sets.length;

  const [name, setNameState] = useState(null);
  const [loadingName, setLoadingName] = useState(true);

  const [myResults, setMyResults] = useState({});
  const [currentResult, setCurrentResult] = useState(null);
  const [leaderboard, setLeaderboard] = useState({});

  const [selected, setSelected] = useState([]);
  const [foundSets, setFoundSets] = useState([]);
  const [time, setTime] = useState(0);
  const [running, setRunning] = useState(false);
  const [flash, setFlash] = useState(null);
  const flashTimer = useRef(null);
  const startTimeRef = useRef(null);
  const accumulatedMsRef = useRef(0);
  const splitsRef = useRef([]);   // per-set {t, idx, mask} for the active puzzle

  // Timer is running unless the user actively pressed Pause.
  const [userPaused, setUserPaused] = useState(false);

  const [view, setView] = useState('game');
  const [viewingPlayer, setViewingPlayer] = useState(null);
  // Remember where the user came from when they opened the scoring page so
  // the Back button takes them back there (game vs archives).
  const [scoringFrom, setScoringFrom] = useState('game');
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);

  const [isVisible, setIsVisible] = useState(() =>
    typeof document !== 'undefined' ? !document.hidden : true
  );

  const lastActiveDateRef = useRef(null);

  // === Load name on mount ===
  // Existing players arrive here with a name in localStorage but no secret
  // (they predate the ownership system). We silently mint a secret and claim
  // their name for them — so the ~60 people already playing get grandfathered
  // in without ever seeing a prompt. If someone else got there first, the name
  // comes back 'taken' and we send them to the name screen to sort it out;
  // that should be rare, and only for names that were dormant.
  useEffect(() => {
    (async () => {
      const n = await Storage.getName();
      if (!n) {
        setNameState(null);
        setLoadingName(false);
        setView('firstname');
        return;
      }
      if (!Storage.getSecret()) {
        const secret = Storage.ensureSecret();
        const res = await Storage.claimName(n, secret);
        if (res === 'taken') {
          // Someone else owns this name. Drop the unusable secret so the
          // name screen starts clean, and make them pick/reclaim.
          Storage.setSecret('');
          setNameState(null);
          setLoadingName(false);
          setView('firstname');
          return;
        }
        // 'claimed' | 'ok' | 'unavailable' -> carry on as this player.
      }
      setNameState(n);
      setLoadingName(false);
    })();
  }, []);

  // === Bulk-load all personal results once name is set ===
  // Sync first so any local-only saves (e.g. ones whose Supabase POST failed
  // silently) get pushed to cloud, then load so we see the merged view.
  useEffect(() => {
    if (!name) return;
    (async () => {
      await Storage.syncLocalToCloud(name);
      const results = await Storage.loadMyResults(name);
      setMyResults(results);
    })();
  }, [name]);

  // === Load active puzzle state when activeDate changes ===
  useEffect(() => {
    if (loadingName || !name) return;
    if (lastActiveDateRef.current === activeDate) return;
    lastActiveDateRef.current = activeDate;

    let cancelled = false;

    setSelected([]);
    setFoundSets([]);
    setTime(0);
    setRunning(false);
    setFlash(null);
    setLeaderboard({});
    setCurrentResult(null);
    setUserPaused(false);  // fresh puzzle: ready to play
    accumulatedMsRef.current = 0;
    startTimeRef.current = null;
    splitsRef.current = [];

    // Persist the puzzle cards (idempotent in Supabase; useful for any future
    // analysis even if no one finishes today's puzzle).
    Storage.savePuzzle(activeDate, puzzle.cards);

    (async () => {
      const r = await Storage.getMyResult(activeDate, name);
      if (cancelled) return;
      if (r) {
        setCurrentResult(r);
        const lb = await Storage.loadLeaderboard(activeDate);
        if (!cancelled) setLeaderboard(lb);
      }
    })();

    return () => { cancelled = true; };
  }, [activeDate, name, loadingName, puzzle.cards]);

  // === Visibility tracking ===
  useEffect(() => {
    const handler = () => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // === Timer pause/resume control ===
  useEffect(() => {
    if (loadingName || !name) return;
    const shouldRun = view === 'game' && !currentResult && isVisible && !userPaused;
    if (shouldRun) {
      if (startTimeRef.current === null) startTimeRef.current = Date.now();
      setRunning(true);
    } else {
      if (startTimeRef.current !== null) {
        accumulatedMsRef.current += Date.now() - startTimeRef.current;
        startTimeRef.current = null;
      }
      setRunning(false);
    }
  }, [view, currentResult, isVisible, userPaused, loadingName, name]);

  // === Game timer ticks ===
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const ms = accumulatedMsRef.current +
        (startTimeRef.current !== null ? Date.now() - startTimeRef.current : 0);
      // Store seconds with 2-decimal (centisecond) precision
      setTime(Math.round(ms / 10) / 100);
    }, 50);
    return () => clearInterval(id);
  }, [running]);

  // === Now ticker ===
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // === Day rollover ===
  useEffect(() => {
    const newToday = utcDateKey();
    if (newToday !== todayKey) setTodayKey(newToday);
  }, [now, todayKey]);

  // === Auto-refresh leaderboard on completed view ===
  // Polls every 15s while visible on the completed screen, and refetches
  // immediately when the tab comes back into view, so we pick up other
  // players' times without anyone having to hit Refresh manually.
  useEffect(() => {
    if (!isVisible || view !== 'game' || !currentResult) return;
    Storage.loadLeaderboard(activeDate).then(setLeaderboard);
    const id = setInterval(() => {
      Storage.loadLeaderboard(activeDate).then(setLeaderboard);
    }, 15000);
    return () => clearInterval(id);
  }, [isVisible, view, currentResult, activeDate]);

  // === Selection validation ===
  useEffect(() => {
    if (selected.length !== 3 || flash) return;
    const sorted = [...selected].sort((a, b) => a - b);
    const [i, j, k] = sorted;
    const valid = isSet(puzzle.cards[i], puzzle.cards[j], puzzle.cards[k]);
    if (valid) {
      const key = sorted.join('-');
      const already = foundSets.some((s) => s.key === key);
      if (already) {
        setFlash('dup');
        flashTimer.current = setTimeout(() => { setSelected([]); setFlash(null); }, 900);
      } else {
        // Record the split for this set: elapsed active solve time (same
        // pause-aware clock as the final time), card indices, and the set's
        // differing-attribute mask. Stored with the result for later
        // analysis of find-order vs set type.
        const elapsedMs = accumulatedMsRef.current +
          (startTimeRef.current !== null ? Date.now() - startTimeRef.current : 0);
        splitsRef.current.push({
          t: Math.round(elapsedMs / 10) / 100,
          idx: sorted,
          mask: setDiffMask(puzzle.cards[i], puzzle.cards[j], puzzle.cards[k]),
        });
        const next = [...foundSets, { key, indices: sorted }];
        setFoundSets(next);
        setSelected([]);
        if (next.length === targetSets) {
          if (startTimeRef.current !== null) {
            accumulatedMsRef.current += Date.now() - startTimeRef.current;
            startTimeRef.current = null;
          }
          setRunning(false);
          // Final time as seconds with 2-decimal precision (e.g. 123.45)
          const finalTime = Math.round(accumulatedMsRef.current / 10) / 100;
          setTime(finalTime);
          const newResult = { time: finalTime, completedAt: Date.now() };
          const splits = splitsRef.current;
          (async () => {
            await Storage.saveResult(activeDate, name, finalTime, splits);
            setCurrentResult(newResult);
            setMyResults((prev) => ({ ...prev, [activeDate]: newResult }));
            const lb = await Storage.loadLeaderboard(activeDate);
            setLeaderboard(lb);
          })();
        }
      }
    } else {
      setFlash('bad');
      flashTimer.current = setTimeout(() => { setSelected([]); setFlash(null); }, 900);
    }
  }, [selected, foundSets, puzzle, flash, name, activeDate, targetSets]);

  // === Handlers ===
  const toggle = (idx) => {
    if (!running) return;
    if (flash) {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = null;
      setFlash(null);
      setSelected([idx]);
      return;
    }
    if (selected.includes(idx)) setSelected(selected.filter((x) => x !== idx));
    else if (selected.length < 3) setSelected([...selected, idx]);
  };

  // Claim `n` before accepting it. If the player supplied a sync code, we try
  // that secret instead of this device's — that's how you reclaim your own
  // name on a new phone. Returns a status the NameEntry screen renders.
  const handleNameSubmit = async (n, syncCode) => {
    const secret = (syncCode && syncCode.length >= 16)
      ? syncCode
      : Storage.ensureSecret();

    const res = await Storage.claimName(n, secret);

    if (res === 'taken' || res === 'invalid') return res;

    // 'claimed' (new name), 'ok' (already ours / valid sync code), or
    // 'unavailable' (offline — fail open, the server still gates writes).
    if (syncCode && res === 'ok') Storage.setSecret(secret);  // adopt the synced identity
    await Storage.setName(n);
    setNameState(n);
    setView('game');
    return 'ok';
  };

  const refreshLeaderboard = async () => {
    setRefreshing(true);
    const lb = await Storage.loadLeaderboard(activeDate);
    setLeaderboard(lb);
    setRefreshing(false);
  };

  const openPlayerStats = (player) => {
    setViewingPlayer(player);
    setView('playerStats');
  };

  // Open the scoring page from anywhere; remember origin so Back returns there.
  const openScoring = () => {
    setScoringFrom(view);
    setView('scoring');
  };

  // Tab navigation
  const activeTab = view === 'archives' ? 'archives'
                  : view === 'survivor' ? 'survivor'
                  : (view === 'stats' || view === 'playerStats') ? 'stats'
                  : view === 'scoring' ? (scoringFrom === 'archives' ? 'archives'
                      : (scoringFrom === 'stats' || scoringFrom === 'playerStats') ? 'stats'
                      : 'game')
                  : playingDate ? 'archives'  // archived puzzle in game view
                  : 'game';

  const handleTabChange = (tab) => {
    if (tab === 'game') {
      setPlayingDate(null);
      setView('game');
    } else if (tab === 'archives') {
      setView('archives');
    } else if (tab === 'survivor') {
      setView('survivor');
    } else if (tab === 'stats') {
      setViewingPlayer(null);
      setView('stats');
    }
  };

  // Derived
  const msUntilTomorrow = msUntilNextUtcMidnight();

  // Most recent archived puzzle the player hasn't finished yet: walk backward
  // from yesterday until we hit a date with no result. Bounded so we never
  // loop forever if someone has somehow solved a long unbroken run. Drives
  // the "play another" shortcut on the completion screen.
  const nextUnplayedDate = useMemo(() => {
    let cursor = utcDateKey(new Date(dateKeyToUTC(todayKey) - 86400000));
    for (let i = 0; i < 400; i++) {
      if (!myResults[cursor]) return cursor;
      cursor = utcDateKey(new Date(dateKeyToUTC(cursor) - 86400000));
    }
    return null;  // unbroken 400-day streak — nothing recent to suggest
  }, [todayKey, myResults]);

  // === Render ===
  if (loadingName) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center text-stone-500"
           style={{ fontFamily: '"Inter", system-ui, sans-serif' }}>
        <SharedSvgDefs />
        Loading…
      </div>
    );
  }

  if (view === 'firstname') {
    return (
      <>
        <SharedSvgDefs />
        <PreviewModeBanner />
        <NameEntry onSubmit={handleNameSubmit} />
      </>
    );
  }

  if (view === 'rename') {
    return (
      <>
        <SharedSvgDefs />
        <PreviewModeBanner />
        <NameEntry initial={name}
                   onSubmit={handleNameSubmit}
                   onCancel={() => setView('game')}
                   mySecret={Storage.getSecret() || undefined} />
      </>
    );
  }

  const headerDate = view === 'game' ? activeDate : null;

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col"
         style={{ fontFamily: '"Inter", system-ui, sans-serif' }}>
      <SharedSvgDefs />
      <PreviewModeBanner />
      <Header dateKey={headerDate} />
      <TabBar activeTab={activeTab} onChange={handleTabChange} />

      {view === 'archives' && (
        <ArchivesContent
          myResults={myResults}
          todayKey={todayKey}
          currentName={name}
          onPlayDate={(date) => {
            // Today => regular play; any other date => archived puzzle.
            if (date === todayKey) setPlayingDate(null);
            else setPlayingDate(date);
            setView('game');
          }}
          onOpenScoring={openScoring}
        />
      )}

      {view === 'survivor' && (
        <SurvivorContent name={name} onPlayerClick={openPlayerStats} />
      )}

      {view === 'stats' && (
        <StatsContent
          onPlayerClick={openPlayerStats}
          currentName={name}
          todayKey={todayKey}
          onOpenScoring={openScoring}
        />
      )}

      {view === 'playerStats' && (
        <PlayerStatsContent
          player={viewingPlayer}
          todayKey={todayKey}
          currentName={name}
          onBack={() => setView('stats')}
          onOpenScoring={openScoring}
        />
      )}

      {view === 'scoring' && (
        <ScoringContent onBack={() => setView(scoringFrom)} />
      )}

      {view === 'game' && currentResult && (
        <CompletedContent
          result={currentResult}
          leaderboard={leaderboard}
          name={name}
          isPlayingToday={isPlayingToday}
          dateKey={activeDate}
          msUntilTomorrow={msUntilTomorrow}
          puzzle={puzzle}
          myResults={myResults}
          onPlayToday={() => handleTabChange('game')}
          nextUnplayedDate={nextUnplayedDate}
          onPlayDate={(date) => { setPlayingDate(date); setView('game'); }}
          onPlayerClick={openPlayerStats}
          onRefresh={refreshLeaderboard}
          refreshing={refreshing}
          onRename={() => setView('rename')}
          onOpenScoring={openScoring}
        />
      )}

      {view === 'game' && !currentResult && (
        <GameContent
          puzzle={puzzle}
          targetSets={targetSets}
          time={time}
          foundSets={foundSets}
          selected={selected}
          flash={flash}
          userPaused={userPaused}
          name={name}
          isPlayingToday={isPlayingToday}
          activeDate={activeDate}
          onToggle={toggle}
          onPause={() => setUserPaused(true)}
          onResume={() => setUserPaused(false)}
          onRename={() => setView('rename')}
          onOpenScoring={openScoring}
        />
      )}
    </div>
  );
}