import React, { useState, useEffect, useMemo, useRef } from 'react';

// ===== SET game constants =====
const COLORS = { purple: '#6B2D8C', green: '#1B8B3A', red: '#C9252D' };
const COLOR_KEYS = ['purple', 'green', 'red'];
const SHAPES = ['oval', 'diamond', 'squiggle'];
const SHADINGS = ['solid', 'striped', 'open'];
const NUMBERS = [1, 2, 3];
const PUZZLE_VERSION = '1';
const ARCHIVE_DAYS = 30;

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

// ===== Puzzle difficulty scoring =====
// Three structural metrics, independent of the player:
//   avgVars: average number of varying attributes across all sets (1.0-4.0).
//     A set varying in only 1 attribute (e.g. three red solid ovals, just
//     1/2/3 of them) is trivially easy to spot. A set varying in all 4
//     attributes looks maximally different and is the hardest to recognize.
//   decoys: number of cards that belong to no set at all. Decoys force
//     players to actively dismiss cards, which costs scan time.
//   membershipStd: standard deviation of set-counts per card. Hub cards
//     (in many sets) create shortcuts — find one set, find several. So
//     higher std means more clustered, which means *easier*; subtracted.
// Raw composite = avgVars + 0.5 * decoys - 0.4 * membershipStd.
// We then multiply by 2 to put the score on a familiar 1-10 scale.
// Thresholds (5.5 / 6.5) are set at the empirical tertiles across all
// valid 6-set puzzles, so Easy/Medium/Hard each contain ~1/3 of puzzles.
// Will be recalibrated against real solve-time data once that exists.
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

  // 2. Per-card memberships → decoys + spread
  const memberships = new Array(cards.length).fill(0);
  for (const [i, j, k] of sets) { memberships[i]++; memberships[j]++; memberships[k]++; }
  const decoys = memberships.filter(m => m === 0).length;
  const meanMem = memberships.reduce((s, m) => s + m, 0) / memberships.length;
  const variance = memberships.reduce((s, m) => s + (m - meanMem) ** 2, 0) / memberships.length;
  const membershipStd = Math.sqrt(variance);

  // Composite, scaled to 1-10. Higher = harder.
  const rawScore = avgVars + 0.5 * decoys - 0.4 * membershipStd;
  const score = rawScore * 2;
  const level = score < 5.5 ? 'easy' : score < 6.5 ? 'medium' : 'hard';

  return { avgVars, decoys, membershipStd, rawScore, score, level };
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
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
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

function generateArchiveDates(todayKey, count = ARCHIVE_DAYS) {
  const baseTime = dateKeyToUTC(todayKey);
  const dates = [];
  for (let i = 1; i <= count; i++) {
    dates.push(utcDateKey(new Date(baseTime - i * 86400000)));
  }
  return dates;
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
  async saveResult(dateKey, name, time) {
    const payload = { time, completedAt: Date.now() };
    if (USE_SUPABASE) {
      lsSetResult(dateKey, payload);
      try {
        await sbFetch('/results', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify({
            date: dateKey, name,
            time_seconds: time, completed_at: payload.completedAt,
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
  const border = flashing === 'bad' ? 'border-red-500 ring-2 ring-red-300'
                : flashing === 'dup' ? 'border-amber-500 ring-2 ring-amber-300'
                : selected ? 'border-blue-500 ring-2 ring-blue-200'
                : 'border-gray-200';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ aspectRatio: CARD_ASPECT }}
      className={`relative w-full bg-white rounded-lg border-2 ${border}
        overflow-hidden transition-all duration-150 shadow-sm
        ${disabled ? '' : 'hover:border-gray-400 hover:shadow active:scale-[0.97]'}`}
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
// Shows pepper icons, optional label ("Medium"), and the score (out of 10).
// When onClick is provided, renders as a button with a small info icon so it
// reads as an interactive element that explains itself when tapped.
function DifficultyBadge({ difficulty, showLabel = false, showScore = true,
                          onClick, className = '' }) {
  if (!difficulty) return null;
  const { level, score } = difficulty;
  const peppers = level === 'easy' ? '🌶️'
                : level === 'medium' ? '🌶️🌶️'
                : '🌶️🌶️🌶️';
  const label = level === 'easy' ? 'Easy'
              : level === 'medium' ? 'Medium'
              : 'Hard';
  const inner = (
    <span className={`inline-flex items-baseline gap-1 ${className}`}>
      <span aria-label={label}>{peppers}</span>
      {showLabel && <span className="text-stone-600 font-medium">{label}</span>}
      {showScore && (
        <span className="text-stone-500 tabular-nums"
              style={{ fontFamily: '"Menlo", monospace' }}>
          · {score.toFixed(1)}<span className="text-stone-400">/10</span>
        </span>
      )}
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
function PauseOverlay({ time, foundCount, targetCount, onResume }) {
  return (
    <div className="bg-white rounded-lg border-2 border-stone-200 shadow-sm
                    flex flex-col items-center justify-center text-center py-16 px-6"
         style={{ minHeight: '380px' }}>
      <div className="text-5xl mb-3">⏸</div>
      <h2 className="text-lg font-semibold text-stone-600 mb-1">Paused</h2>
      <div className="text-4xl font-mono font-bold text-stone-800 mb-1 tabular-nums"
           style={{ fontFamily: '"Menlo", monospace' }}>
        {formatMmSs(time)}
      </div>
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
function GameContent({ puzzle, targetSets, time, foundSets, selected, flash,
                       userPaused, name, isPlayingToday, activeDate,
                       onToggle, onPause, onResume, onRename, onOpenScoring }) {
  const difficulty = useMemo(() => computePuzzleDifficulty(puzzle), [puzzle]);
  return (
    <>
      <div className="text-center pt-3 pb-1">
        <div className="flex items-center justify-center gap-3">
          <div className="text-3xl font-mono tabular-nums text-stone-800"
               style={{ fontFamily: '"Menlo", "Courier New", monospace' }}>
            {formatMmSs(time)}
          </div>
          {!userPaused && (
            <button onClick={onPause}
              className="px-2.5 py-1 text-stone-600 hover:text-stone-900 hover:bg-stone-200
                         rounded text-sm font-medium transition-colors"
              title="Pause">
              ⏸ Pause
            </button>
          )}
        </div>
        <div className="text-xs text-stone-500 mt-1 flex items-center justify-center gap-2 flex-wrap">
          {difficulty && (
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
              time={time}
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
function ArchivesContent({ archiveDates, archiveResults, todayResult, todayKey,
                           onPlayToday, onPlayArchive, onOpenScoring }) {
  const allResults = { ...archiveResults };
  if (todayResult) allResults[todayKey] = todayResult;
  const playedCount = Object.keys(allResults).length;
  const totalCount = archiveDates.length + 1;
  const allTimes = Object.values(allResults).map((r) => r.time);
  const best = allTimes.length ? Math.min(...allTimes) : null;

  // Compute difficulty for every shown puzzle (today + 30 days). Each
  // generateDailyPuzzle is ~50ms worst case; memoized by date so this runs
  // once when the archives view first mounts.
  const difficulties = useMemo(() => {
    const map = {};
    for (const date of [todayKey, ...archiveDates]) {
      map[date] = computePuzzleDifficulty(generateDailyPuzzle(date));
    }
    return map;
  }, [todayKey, archiveDates]);

  let streak = 0;
  if (todayResult) streak = 1;
  for (const date of archiveDates) {
    if (archiveResults[date]) streak++;
    else break;
  }

  return (
    <main className="flex-1 p-3 max-w-2xl w-full mx-auto">
      <div className="bg-white rounded-md shadow-sm mb-4 p-4">
        <div className="grid grid-cols-3 gap-2 divide-x divide-stone-200">
          <div className="text-center">
            <div className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">Played</div>
            <div className="text-xl font-semibold text-stone-800 mt-0.5 tabular-nums">
              {playedCount}<span className="text-stone-400 text-sm font-normal">/{totalCount}</span>
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">Streak</div>
            <div className="text-xl font-semibold text-red-700 mt-0.5 tabular-nums">
              {streak}<span className="text-sm text-stone-500 font-normal ml-1">
                {streak === 1 ? 'day' : 'days'}
              </span>
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">Best</div>
            <div className="text-xl font-semibold text-stone-800 mt-0.5 tabular-nums"
                 style={{ fontFamily: '"Menlo", monospace' }}>
              {best != null ? formatMmSs(best) : '—'}
            </div>
          </div>
        </div>
      </div>

      <h2 className="text-[11px] uppercase tracking-wider text-stone-500 mb-2 px-1 font-semibold">Today</h2>
      <button onClick={onPlayToday}
        className="w-full mb-4 flex items-center justify-between px-4 py-3 bg-white
                   border-2 border-red-200 rounded-md hover:border-red-400
                   hover:bg-red-50/30 transition-all text-left shadow-sm">
        <div className="flex items-center gap-3">
          <span className={`text-xl ${todayResult ? 'text-green-600' : 'text-red-700'}`}>
            {todayResult ? '✓' : '★'}
          </span>
          <div>
            <div className="font-semibold text-stone-800">
              {shortWeekday(todayKey)}, {formatShortDate(todayKey)}
            </div>
            <div className="text-xs text-stone-500">Today's puzzle</div>
          </div>
        </div>
        <div className="text-sm">
          {todayResult ? (
            <span className="font-mono text-red-700 font-semibold tabular-nums"
                  style={{ fontFamily: '"Menlo", monospace' }}>
              {formatMmSs(todayResult.time)}
            </span>
          ) : (
            <span className="text-red-700 font-medium">Play →</span>
          )}
        </div>
      </button>

      <h2 className="text-[11px] uppercase tracking-wider text-stone-500 mb-2 px-1 font-semibold">
        Past 30 days
      </h2>
      <div className="bg-white rounded-md shadow-sm divide-y divide-stone-100 overflow-hidden">
        {archiveDates.map((date) => {
          const result = archiveResults[date];
          // Using div + role=button so the difficulty badge inside can be its
          // own clickable element (nested <button> in <button> is invalid HTML).
          return (
            <div key={date} role="button" tabIndex={0}
              onClick={() => onPlayArchive(date)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPlayArchive(date);
                }
              }}
              className="w-full flex items-center justify-between px-4 py-3
                         hover:bg-stone-50 transition-colors text-left group cursor-pointer
                         focus:outline-none focus:bg-stone-50">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`text-lg w-5 inline-block text-center flex-shrink-0
                                 ${result ? 'text-green-600' : 'text-stone-300'}`}>
                  {result ? '✓' : '○'}
                </span>
                <div className="text-sm flex items-baseline gap-2 min-w-0 flex-wrap">
                  <span className="text-stone-500 uppercase text-[11px] font-semibold
                                   tracking-wider w-9 flex-shrink-0">
                    {shortWeekday(date, true)}
                  </span>
                  <span className="text-stone-800 font-medium truncate">
                    {formatShortDate(date)}
                  </span>
                  {difficulties[date] && (
                    <DifficultyBadge difficulty={difficulties[date]}
                                     onClick={onOpenScoring}
                                     className="text-[11px]" />
                  )}
                </div>
              </div>
              <div className="text-sm flex-shrink-0">
                {result ? (
                  <span className="font-mono text-stone-700 tabular-nums"
                        style={{ fontFamily: '"Menlo", monospace' }}>
                    {formatMmSs(result.time)}
                  </span>
                ) : (
                  <span className="text-stone-400 text-xs group-hover:text-red-700 transition-colors">
                    Play →
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-stone-400 text-center mt-4 mb-2">
        A new puzzle drops every day at midnight UTC.
      </p>
    </main>
  );
}

// ===== Stats content (overall players + daily log) =====
function StatsContent({ onPlayerClick, currentName }) {
  const [history, setHistory] = useState(null);
  useEffect(() => { Storage.loadAllHistory().then(setHistory); }, []);

  if (history === null) {
    return (
      <main className="flex-1 flex items-center justify-center text-stone-500">
        Loading stats…
      </main>
    );
  }

  const dates = Object.keys(history).sort().reverse();
  const allNames = Array.from(new Set(dates.flatMap((d) => Object.keys(history[d]))));
  allNames.sort((a, b) => {
    if (a === currentName) return -1;
    if (b === currentName) return 1;
    return a.localeCompare(b);
  });

  const stats = {};
  for (const n of allNames) {
    const times = dates.map((d) => history[d][n]?.time).filter((t) => t != null);
    if (times.length === 0) continue;
    stats[n] = {
      played: times.length,
      best: Math.min(...times),
      avg: Math.round(times.reduce((s, t) => s + t, 0) / times.length),
    };
  }

  return (
    <main className="flex-1 p-3 max-w-3xl w-full mx-auto">
      {dates.length === 0 ? (
        <div className="text-center text-stone-500 italic mt-10">
          No games yet. Finish a puzzle to start tracking.
        </div>
      ) : (
        <>
          <div className="bg-white rounded-md shadow-sm p-3 mb-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-stone-700">Players</h3>
              <span className="text-[11px] text-stone-400">Tap a name for details</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {Object.entries(stats).map(([n, s]) => (
                <button key={n}
                  onClick={() => onPlayerClick(n)}
                  className={`flex items-center justify-between px-3 py-2 rounded text-left
                             transition-colors
                             ${n === currentName
                               ? 'bg-red-50 border border-red-100 hover:bg-red-100'
                               : 'bg-stone-50 hover:bg-stone-100'}`}>
                  <span className={`text-sm font-medium ${n === currentName ? 'text-red-800' : 'text-stone-800'}`}>
                    {n}{n === currentName && <span className="text-stone-400 font-normal"> (you)</span>}
                  </span>
                  <span className="text-xs text-stone-600 font-mono tabular-nums"
                        style={{ fontFamily: '"Menlo", monospace' }}>
                    best {formatMmSs(s.best)} · avg {formatMmSs(s.avg)} · {s.played}d
                  </span>
                </button>
              ))}
            </div>
          </div>

          <h3 className="text-xs uppercase tracking-wider text-stone-500 mb-2 px-1 font-semibold">
            Daily log
          </h3>
          <div className="bg-white rounded-md shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-stone-100">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-stone-700">Date</th>
                    {allNames.map((n) => (
                      <th key={n}
                          className={`px-3 py-2 text-right font-semibold whitespace-nowrap
                                     ${n === currentName ? 'text-red-700' : 'text-stone-700'}`}>
                        <button onClick={() => onPlayerClick(n)}
                          className="hover:underline underline-offset-2">
                          {n}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dates.map((date, i) => {
                    const dateTimes = Object.values(history[date]).map((r) => r.time);
                    const minTime = dateTimes.length ? Math.min(...dateTimes) : null;
                    return (
                      <tr key={date} className={i % 2 === 0 ? 'bg-white' : 'bg-stone-50'}>
                        <td className="px-3 py-2 font-medium text-stone-800 whitespace-nowrap">
                          {formatShortDate(date)}
                        </td>
                        {allNames.map((n) => {
                          const r = history[date][n];
                          const isWinner = r && r.time === minTime && dateTimes.length > 1;
                          return (
                            <td key={n}
                                className={`px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap
                                           ${n === currentName ? 'text-red-700' : 'text-stone-700'}
                                           ${isWinner ? 'font-bold' : ''}`}
                                style={{ fontFamily: '"Menlo", monospace' }}>
                              {r ? (
                                <span>
                                  {isWinner && <span className="mr-1">🥇</span>}
                                  {formatMmSs(r.time)}
                                </span>
                              ) : (
                                <span className="text-stone-300">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

// ===== Player detail stats =====
function PlayerStatsContent({ player, todayKey, currentName, onBack }) {
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
  const avg = Math.round(times.reduce((s, t) => s + t, 0) / played);
  const sortedTimes = [...times].sort((a, b) => a - b);
  const median = sortedTimes.length % 2 === 0
    ? Math.round((sortedTimes[sortedTimes.length / 2 - 1] + sortedTimes[sortedTimes.length / 2]) / 2)
    : sortedTimes[Math.floor(sortedTimes.length / 2)];

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

// ===== Scoring explanation page =====
function ScoringContent({ onBack }) {
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
        it. That keeps it honest — a 🌶️🌶️🌶️ today is comparable to a
        🌶️🌶️🌶️ a year ago.
      </p>

      <div className="bg-white rounded-md border border-stone-300 p-3 mb-2
                      text-sm text-stone-800 tabular-nums text-center overflow-x-auto"
           style={{ fontFamily: '"Menlo", monospace' }}>
        score = 2 × (avgVars + 0.5 × decoys − 0.4 × membershipStd)
      </div>
      <p className="text-xs text-stone-500 mb-5 text-center">
        The raw composite is doubled so the score lands on a familiar 1–10 scale.
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
          evaluated and dismissed. More decoys means more wasted scanning.{' '}
          <strong>Higher = harder.</strong>
        </p>
      </section>

      <section className="mb-5">
        <h3 className="font-semibold text-stone-800 mb-1"
            style={{ fontFamily: '"Georgia", serif' }}>
          membershipStd
          <span className="text-stone-400 font-normal text-sm ml-1">
            — how clustered the sets are
          </span>
        </h3>
        <p className="text-sm text-stone-700 leading-relaxed">
          The standard deviation of "how many sets each card belongs to." If a
          few "hub" cards appear in many sets, finding one set tends to reveal
          several others — your eye is already on those cards. Even spread =
          no shortcuts. <strong>Higher = easier</strong> (so it's subtracted).
        </p>
      </section>

      <h3 className="text-[11px] uppercase tracking-wider text-stone-500 mb-2 px-1 font-semibold">
        Thresholds
      </h3>
      <p className="text-xs text-stone-500 mb-2 leading-relaxed">
        Set at the empirical tertiles across ~46,500 sampled valid 6-set
        puzzles, so each level contains roughly a third of all possible puzzles.
      </p>
      <div className="bg-white rounded-md border border-stone-300 divide-y divide-stone-200 mb-4">
        <div className="px-4 py-2.5 flex justify-between items-center">
          <span className="text-sm">🌶️ <span className="ml-1">Easy</span></span>
          <span className="text-stone-500 tabular-nums text-sm"
                style={{ fontFamily: '"Menlo", monospace' }}>
            score &lt; 5.5
          </span>
        </div>
        <div className="px-4 py-2.5 flex justify-between items-center">
          <span className="text-sm">🌶️🌶️ <span className="ml-1">Medium</span></span>
          <span className="text-stone-500 tabular-nums text-sm"
                style={{ fontFamily: '"Menlo", monospace' }}>
            5.5 ≤ score &lt; 6.5
          </span>
        </div>
        <div className="px-4 py-2.5 flex justify-between items-center">
          <span className="text-sm">🌶️🌶️🌶️ <span className="ml-1">Hard</span></span>
          <span className="text-stone-500 tabular-nums text-sm"
                style={{ fontFamily: '"Menlo", monospace' }}>
            score ≥ 6.5
          </span>
        </div>
      </div>

      <p className="text-xs text-stone-500 italic leading-relaxed">
        The coefficients (0.5, 0.4) and thresholds are first-pass estimates.
        As solve-time data accumulates, they'll be recalibrated against what
        actually predicts how hard humans find each puzzle.
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

  const archiveDates = useMemo(() => generateArchiveDates(todayKey), [todayKey]);

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
  useEffect(() => {
    if (!name) return;
    Storage.loadMyResults(name).then(setMyResults);
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
      setTime(Math.floor(ms / 1000));
    }, 250);
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
        const next = [...foundSets, { key, indices: sorted }];
        setFoundSets(next);
        setSelected([]);
        if (next.length === targetSets) {
          if (startTimeRef.current !== null) {
            accumulatedMsRef.current += Date.now() - startTimeRef.current;
            startTimeRef.current = null;
          }
          setRunning(false);
          const finalTime = Math.floor(accumulatedMsRef.current / 1000);
          setTime(finalTime);
          const newResult = { time: finalTime, completedAt: Date.now() };
          (async () => {
            await Storage.saveResult(activeDate, name, finalTime);
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
                  : view === 'scoring' ? (scoringFrom === 'archives' ? 'archives' : 'game')
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
  const todayResult = myResults[todayKey];
  const archiveResults = useMemo(() => {
    const r = {};
    for (const d of archiveDates) if (myResults[d]) r[d] = myResults[d];
    return r;
  }, [myResults, archiveDates]);

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
          archiveDates={archiveDates}
          archiveResults={archiveResults}
          todayResult={todayResult}
          todayKey={todayKey}
          onPlayToday={() => handleTabChange('game')}
          onPlayArchive={(date) => { setPlayingDate(date); setView('game'); }}
          onOpenScoring={openScoring}
        />
      )}

      {view === 'stats' && (
        <StatsContent
          onPlayerClick={openPlayerStats}
          currentName={name}
        />
      )}

      {view === 'playerStats' && (
        <PlayerStatsContent
          player={viewingPlayer}
          todayKey={todayKey}
          currentName={name}
          onBack={() => setView('stats')}
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