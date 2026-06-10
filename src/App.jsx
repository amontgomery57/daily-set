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
//     A set varying in only 1 attribute (e.g. three red solid ovals, just
//     1/2/3 of them) is trivially easy to spot; one varying in all 4 looks
//     maximally different and is the hardest to recognize.
//   decoys: cards that belong to no set at all. Decoys force players to
//     actively dismiss cards, which costs scan time. Empirically the
//     strongest single predictor of real solve times.
//   nCompact: number of sets whose three cards sit near each other in the
//     4-column grid (sum of pairwise Chebyshev distances <= 4). Neighboring
//     cards get compared more often, so compact sets are found sooner;
//     subtracted.
//
// v2 (June 2026): recalibrated against 150 real solves (98 puzzle days,
// players with 8+ plays, per-player normalized log solve times):
//   raw = 0.75*avgVars + 1.0*decoys - 0.25*nCompact
// Coefficients follow the fitted regression ratios. v1's membershipStd term
// was dropped: its empirical sign was the opposite of the design assumption.
// Correlation with normalized solve times is ~0.3 (v1 scored ~0.27), i.e.
// layout structure explains roughly 10% of the variance in how long a puzzle
// takes. ScoringContent carries the honest framing of that limit.
const RAW_SCORE_MIN = 0.0;  // empirical min raw composite (n=30,000 sampled)
const RAW_SCORE_MAX = 5.5;  // empirical max raw composite
// Three buckets -> 1/2/3 stars. Cut points on the 0-10 scale are the
// population quartiles (p25 / p75), so ~20% of layouts land in 1-star,
// ~55% in 2-star, ~25% in 3-star. This is deliberately the only split of
// the score that separates *monotonically* on real solve time: in our data
// 1-star days are genuinely faster (mean z -0.48), 3-star genuinely slower
// (+0.38), and the big 2-star middle sits at average (+0.03). Finer splits
// (e.g. 5 tiers) put the middle out of order, because layout structure just
// doesn't distinguish medium-hard puzzles reliably.
const SCORE_CUT_EASY = 3.6;  // < this -> 1 star
const SCORE_CUT_HARD = 5.7;  // >= this -> 3 stars; between -> 2 stars

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

  // 2. Per-card memberships -> decoys
  const memberships = new Array(cards.length).fill(0);
  for (const [i, j, k] of sets) { memberships[i]++; memberships[j]++; memberships[k]++; }
  const decoys = memberships.filter(m => m === 0).length;

  // 3. Spatial compactness: card index i renders at grid (row i/4, col i%4).
  // A set's spread = sum of pairwise Chebyshev distances between its cards;
  // spread <= 4 means the three cards are roughly adjacent on screen.
  const pos = (i) => [Math.floor(i / 4), i % 4];
  const cheb = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
  let nCompact = 0;
  for (const [i, j, k] of sets) {
    const [a, b, c] = [pos(i), pos(j), pos(k)];
    if (cheb(a, b) + cheb(a, c) + cheb(b, c) <= 4) nCompact++;
  }

  // Raw composite, then normalize to 0-10 using empirical population bounds.
  // Clamp in case a puzzle scores slightly outside the sampled range.
  const rawScore = 0.75 * avgVars + 1.0 * decoys - 0.25 * nCompact;
  const normalized = ((rawScore - RAW_SCORE_MIN) / (RAW_SCORE_MAX - RAW_SCORE_MIN)) * 10;
  const score = Math.max(0, Math.min(10, normalized));
  const level = score < SCORE_CUT_EASY ? 'easy'
              : score < SCORE_CUT_HARD ? 'medium'
              :                          'hard';

  return { avgVars, decoys, nCompact, rawScore, score, level };
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
const LS_MINE_PREFIX = 'daily-set:mine:';

const lsGetName = () => { try { return localStorage.getItem(LS_NAME); } catch { return null; } };
const lsSetName = (n) => { try { localStorage.setItem(LS_NAME, n); } catch {} };
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
    const payload = { time, completedAt: Date.now() };
    if (splits && splits.length) payload.splits = splits;
    if (USE_SUPABASE) {
      lsSetResult(dateKey, payload);
      try {
        await sbFetch('/results', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({
            date: dateKey, name,
            time_seconds: time, completed_at: payload.completedAt,
            splits: payload.splits || null,
          }),
        });
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
      for (const [date, payload] of missing) {
        if (!payload || typeof payload.time !== 'number') continue;
        try {
          await sbFetch('/results', {
            method: 'POST',
            headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify({
              date, name: playerName,
              time_seconds: payload.time,
              completed_at: payload.completedAt || Date.now(),
              splits: payload.splits || null,
            }),
          });
          pushed++;
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
      try {
        const rows = await sbFetch(
          '/results?select=date,name,time_seconds,completed_at&order=date.desc&limit=10000'
        );
        const history = {};
        for (const row of rows || []) {
          if (!history[row.date]) history[row.date] = {};
          history[row.date][row.name] = { time: row.time_seconds, completedAt: row.completed_at };
        }
        return history;
      } catch { return {}; }
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
function NameEntry({ initial, onSubmit, onCancel }) {
  const [input, setInput] = useState(initial || '');
  const trimmed = input.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 20;
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
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && valid) onSubmit(trimmed); }}
          maxLength={20}
          placeholder="e.g. Aaron"
          autoFocus
          className="w-full px-3 py-2 border border-stone-300 rounded-md
                     focus:outline-none focus:ring-2 focus:ring-red-500"
        />
        <div className="flex gap-2 mt-3">
          {onCancel && (
            <button onClick={onCancel}
              className="flex-1 px-4 py-2 bg-stone-100 hover:bg-stone-200
                         text-stone-700 rounded-md font-medium transition-colors">
              Cancel
            </button>
          )}
          <button
            onClick={() => onSubmit(trimmed)}
            disabled={!valid}
            className="flex-1 px-4 py-2 bg-red-700 hover:bg-red-800 text-white
                       rounded-md font-medium
                       disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors"
          >
            {initial ? 'Save' : 'Start playing'}
          </button>
        </div>
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

// ===== Completed content =====
function CompletedContent({ result, leaderboard, name, isPlayingToday, dateKey,
                            msUntilTomorrow, puzzle, onPlayToday, onPlayerClick,
                            onRefresh, refreshing, onRename, onOpenScoring }) {
  const difficulty = useMemo(() => computePuzzleDifficulty(puzzle), [puzzle]);
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
            <h3 className="text-sm font-semibold text-stone-700">Leaderboard</h3>
            <button onClick={onRefresh} disabled={refreshing}
              className="text-xs text-stone-500 hover:text-stone-700 disabled:opacity-50">
              {refreshing ? 'Refreshing…' : '↻ Refresh'}
            </button>
          </div>
          <Leaderboard results={leaderboard} currentName={name} onPlayerClick={onPlayerClick} />
        </div>

        <div className="flex flex-col items-center gap-3 mt-4">
          {isPlayingToday ? (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full
                            bg-stone-100 text-stone-600 text-xs font-medium">
              <span>⏱</span>
              <span>Next puzzle in {formatCountdown(msUntilTomorrow)}</span>
            </div>
          ) : (
            <button onClick={onPlayToday}
              className="px-4 py-2 bg-red-700 hover:bg-red-800 text-white rounded-md text-sm font-medium transition-colors">
              Play today's puzzle →
            </button>
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
const DAYS_PAGE = 14;

// Tiny trend line of a player's last few solves (chronological; lower =
// better, so a falling line means improvement).
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
  const [tab, setTab] = useState('days');              // 'days' | 'players'
  const [showVisitors, setShowVisitors] = useState(false);
  const [daysShown, setDaysShown] = useState(DAYS_PAGE);
  const [expandedDays, setExpandedDays] = useState(() => new Set());
  useEffect(() => { Storage.loadAllHistory().then(setHistory); }, []);

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

  // Per-player aggregates, ranked by average time.
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
      out.push({ name: n, played, best, avg, streak, last7: times.slice(-7) });
    }
    out.sort((a, b) => a.avg - b.avg);
    return out;
  }, [history, dates, todayKey]);

  // Current player's avg by difficulty tier (the pills on their row).
  const myTierPills = useMemo(() => {
    if (!history || !currentName) return null;
    const mine = [];
    for (const d of dates) {
      const r = history[d][currentName];
      if (r) mine.push({ d, t: r.time });
    }
    if (mine.length === 0) return null;
    const pills = DIFFICULTY_ORDER.map((level) => {
      const ts = mine.filter((m) => difficulties[m.d]?.level === level).map((m) => m.t);
      return ts.length
        ? { level, n: ts.length, avg: Math.round((ts.reduce((s, t) => s + t, 0) / ts.length) * 100) / 100 }
        : { level, n: 0 };
    }).filter((p) => p.n > 0);
    return pills.length ? pills : null;
  }, [history, dates, difficulties, currentName]);

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

  const starsFor = (level) => {
    const tier = DIFFICULTY_TIERS[level];
    if (!tier) return null;
    return (
      <span className="text-red-600" style={{ whiteSpace: 'nowrap', letterSpacing: '0.05em' }}>
        {'★'.repeat(tier.stars)}<span className="text-stone-300">{'★'.repeat(3 - tier.stars)}</span>
      </span>
    );
  };

  return (
    <main className="flex-1 p-3 max-w-2xl w-full mx-auto">
      {/* segmented control */}
      <div className="flex bg-stone-200 rounded-lg p-0.5 mb-3">
        {[
          { id: 'days', label: 'Day by day' },
          { id: 'players', label: 'Players' },
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
          <div className="flex items-baseline justify-between mb-1.5 px-1">
            <span className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold">
              Ranked by average
            </span>
            <span className="text-[10px] text-stone-400">tap a player for details</span>
          </div>
          <div className="bg-white rounded-md shadow-sm overflow-hidden">
            {regulars.map((p) => {
              const isMe = p.name === currentName;
              return (
                <button key={p.name} onClick={() => onPlayerClick(p.name)}
                  className={`w-full text-left px-3 py-2.5 block border-t border-stone-100 first:border-t-0
                             transition-colors
                             ${isMe ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-stone-50'}`}
                  style={isMe ? { boxShadow: 'inset 3px 0 0 #b91c1c' } : undefined}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`text-sm font-semibold truncate ${isMe ? 'text-red-800' : 'text-stone-800'}`}>
                      {rankOf(p)} · {p.name}
                      {isMe && <span className="text-stone-400 font-normal text-[11px]"> (you)</span>}
                    </span>
                    <span className="text-[11px] text-stone-600 font-mono tabular-nums flex-shrink-0"
                          style={{ fontFamily: '"Menlo", monospace' }}>
                      avg <span className="font-bold text-stone-800">{formatMmSs(p.avg)}</span>
                    </span>
                  </div>
                  <div className="flex items-end justify-between gap-2 mt-1">
                    <span className="text-[10.5px] text-stone-500 min-w-0">
                      {p.played} played · best{' '}
                      <span className="font-mono" style={{ fontFamily: '"Menlo", monospace' }}>
                        {formatMmSs(p.best)}
                      </span>
                      {p.streak >= 2 && <span> · 🔥 {p.streak}-day streak</span>}
                    </span>
                    <Sparkline times={p.last7} accent={isMe} />
                  </div>
                  {isMe && myTierPills && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {myTierPills.map((pill) => (
                        <span key={pill.level}
                              className="text-[10px] bg-white border border-red-200 rounded-full px-2 py-0.5 text-stone-600">
                          {starsFor(pill.level)}{' '}
                          <span className="font-mono tabular-nums" style={{ fontFamily: '"Menlo", monospace' }}>
                            avg {formatMmSs(pill.avg)}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}

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
                             font-medium border-t border-stone-100 transition-colors">
                  {showVisitors
                    ? 'Hide occasional players ▴'
                    : `Show ${visitors.length} more player${visitors.length === 1 ? '' : 's'} (under ${REGULAR_MIN_SOLVES} solves) ▾`}
                </button>
              </>
            )}
          </div>
          <p className="text-[10px] text-stone-400 text-center mt-2 px-2">
            sparkline = last 7 solves, lower is better · pills = your average by difficulty
          </p>
        </>
      )}

      {tab === 'days' && (
        <>
          <div className="flex items-baseline justify-between mb-1.5 px-1">
            <span className="text-[11px] uppercase tracking-wider text-stone-500 font-semibold">
              Most recent first
            </span>
            <span className="text-[10px] text-stone-400">tap a day to expand</span>
          </div>
          <div className="bg-white rounded-md shadow-sm overflow-hidden">
            {dates.slice(0, daysShown).map((date) => {
              const entries = Object.entries(history[date])
                .map(([n, r]) => ({ name: n, time: r.time }))
                .sort((a, b) => a.time - b.time);
              const others = Math.max(0, entries.length - 3);  // beyond the podium
              const open = expandedDays.has(date);
              const diff = difficulties[date];
              return (
                <div key={date} className={`border-t border-stone-100 first:border-t-0 ${open ? 'bg-stone-50' : ''}`}>
                  <div role={others > 0 ? 'button' : undefined}
                       tabIndex={others > 0 ? 0 : undefined}
                       onClick={others > 0 ? () => toggleDay(date) : undefined}
                       onKeyDown={others > 0 ? (e) => {
                         if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDay(date); }
                       } : undefined}
                       className={`px-3 py-2 ${others > 0 ? 'cursor-pointer hover:bg-stone-50' : ''}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span style={{ whiteSpace: 'nowrap' }}>
                        <span className="text-[9px] text-stone-400 font-bold tracking-wider">
                          {shortWeekday(date, true)}
                        </span>{' '}
                        <span className="text-[12px] font-semibold text-stone-800">
                          {formatShortDate(date)}
                        </span>
                        <span className="ml-2 text-[10px]">
                          {diff && <DifficultyBadge difficulty={diff} onClick={onOpenScoring} />}
                        </span>
                      </span>
                      <span className="text-[11px] text-stone-400 flex-shrink-0 ml-1">
                        {others > 0 ? (open ? '⌄' : `+${others} ›`) : ''}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {[0, 1, 2].map((slot) => {
                        const e = entries[slot];
                        const medal = slot === 0 ? '🥇' : slot === 1 ? '🥈' : '🥉';
                        if (!e) {
                          return (
                            <span key={slot} className="text-[11px] text-stone-300 text-center py-0.5">
                              {medal} —
                            </span>
                          );
                        }
                        return (
                          <span key={slot} className="min-w-0 text-center leading-tight">
                            <span className="block text-[11.5px] text-stone-700 truncate">
                              {medal}{' '}
                              <button onClick={(ev) => { ev.stopPropagation(); onPlayerClick(e.name); }}
                                      className={`font-medium hover:underline underline-offset-2
                                                 ${e.name === currentName ? 'text-red-800' : ''}`}>
                                {e.name}
                              </button>
                            </span>
                            <span className="block font-mono text-[10.5px] text-stone-500 tabular-nums"
                                  style={{ fontFamily: '"Menlo", monospace' }}>
                              {formatMmSs(e.time)}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  {open && others > 0 && (
                    <div className="pb-2.5 px-3">
                      {entries.slice(3).map((e, i) => {
                        const rank = i + 4;
                        const medal = `#${rank}`;
                        return (
                          <div key={e.name} className="flex items-center justify-between py-0.5">
                            <span className="text-[12px] text-stone-600">
                              {medal}{' '}
                              <button onClick={() => onPlayerClick(e.name)}
                                      className={`hover:underline underline-offset-2
                                                 ${e.name === currentName ? 'text-red-800 font-medium' : ''}`}>
                                {e.name}
                              </button>
                            </span>
                            <span className="font-mono text-[11px] text-stone-500 tabular-nums"
                                  style={{ fontFamily: '"Menlo", monospace' }}>
                              {formatMmSs(e.time)}
                            </span>
                          </div>
                        );
                      })}
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
        score = (raw / 5.5) × 10
      </div>
      <p className="text-xs text-stone-500 mb-5 text-center leading-relaxed">
        where <span className="font-mono">raw = 0.75 × avgVars + 1.0 × decoys − 0.25 × nCompact</span>.{' '}
        The raw composite spans roughly 0–5.5 across all valid 6-set layouts,
        so the easiest possible puzzle scores ~0 and the hardest ~10.
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
          all 4 varying looks maximally different and is the hardest to spot.{' '}
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
          evaluated and dismissed — wasted scanning. In this site's real solve
          data, decoys are by far the strongest single predictor of how long
          a puzzle takes, which is why they carry the largest weight.{' '}
          <strong>Higher = harder.</strong>
        </p>
      </section>

      <section className="mb-5">
        <h3 className="font-semibold text-stone-800 mb-1"
            style={{ fontFamily: '"Georgia", serif' }}>
          nCompact
          <span className="text-stone-400 font-normal text-sm ml-1">
            — sets whose cards sit close together
          </span>
        </h3>
        <p className="text-sm text-stone-700 leading-relaxed">
          Counts the sets whose three cards land near each other in the
          4-column grid. Your eye naturally compares neighboring cards first,
          so tightly clustered sets tend to get found sooner.{' '}
          <strong>Higher = easier</strong> (so it's subtracted).
        </p>
      </section>

      <h3 className="text-[11px] uppercase tracking-wider text-stone-500 mb-2 px-1 font-semibold">
        Star ratings
      </h3>
      <p className="text-xs text-stone-500 mb-2 leading-relaxed">
        The 0–10 score is bucketed into three star ratings at the population
        quartiles, so 1★ and 3★ are the rarer ends (~20% and ~25% of all
        layouts) and 2★ is the broad middle. These are the only cuts that line
        up in the right order against real solve times — see below.
      </p>
      <div className="bg-white rounded-md border border-stone-300 divide-y divide-stone-200 mb-5">
        <div className="px-4 py-1.5 flex items-center gap-3 bg-stone-50
                        text-[10px] uppercase tracking-wider text-stone-500 font-semibold">
          <span className="flex-1">Rating</span>
          <span className="w-24 text-right">Score range</span>
          <span className="w-16 text-right">Share</span>
        </div>
        {[
          [1, 'Easy', '0.0 – 3.6', '~20%'],
          [2, 'Medium', '3.6 – 5.7', '~55%'],
          [3, 'Hard', '5.7 – 10.0', '~25%'],
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
          The formula was recalibrated in June 2026 against 150 real solves
          from this site's own leaderboard. Even after recalibration, the
          underlying score's correlation with (player-adjusted) solve times is
          about 0.3 — meaning the layout's structure explains only around{' '}
          <strong>10% of the variance</strong> in how long a puzzle takes.
          The rest is everything a layout metric can't see: which set your
          eye happens to land on first, focus, luck.
        </p>
        <p>
          That's exactly why there are only three buckets instead of a precise
          number. The good news: across our data the three ratings line up in
          the right order — 1★ days really do get solved faster on average,
          3★ days slower, and 2★ sits in between. The honest caveat: it's an
          average, and 2★ is the big middle where structure says the least. A
          2★ puzzle can absolutely fight you harder than a 3★ one, and the
          same puzzle routinely splits the leaderboard — fast for one player,
          brutal for another.
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
  useEffect(() => {
    Storage.getName().then((n) => {
      setNameState(n);
      setLoadingName(false);
      if (!n) setView('firstname');
    });
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

  const handleNameSubmit = async (n) => {
    await Storage.setName(n);
    setNameState(n);
    setView('game');
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
    } else if (tab === 'stats') {
      setViewingPlayer(null);
      setView('stats');
    }
  };

  // Derived
  const msUntilTomorrow = msUntilNextUtcMidnight();

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
                   onCancel={() => setView('game')} />
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
          onPlayToday={() => handleTabChange('game')}
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